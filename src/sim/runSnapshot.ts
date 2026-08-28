import type { GameState } from './GameState';
import type { WallTier } from './types';
import { CLASS_REGISTRY } from '../data/classRegistry';
import { allAbilities, applyClassToPlayer, buyAbilityRank, getAbilityDef } from './classes';
import { buyAbilityTreeNode, purchasedTreeNodes } from './abilityTree';

/** Owned by [ui] (session-persistence task, 2026-08-27). Pure capture/restore of a run's
 *  progression as a plain JSON-able object. Deliberately knows nothing about *where* a snapshot
 *  is kept — ui/saveStorage.ts owns localStorage, autosave timing, and the resume UI — so this
 *  file stays free of browser APIs and keeps the sim/platform split ARCHITECTURE.md requires.
 *
 *  WHAT IS AND ISN'T SAVED. A snapshot holds progression only: gold, wave reached, walls and
 *  their upgrades, installed structures and theirs, and the player's class/ranks/mastery nodes.
 *  It deliberately does NOT hold live combat state — enemy positions and hp, projectiles in
 *  flight, ally AI targets, status effects, ground fields, cooldowns. Restoring always lands the
 *  player at the START OF THE BUILD PHASE for the wave they were on, so quitting mid-wave replays
 *  that wave rather than resuming it frozen mid-swing. That is the whole reason this file is
 *  ~150 lines instead of a serialization pass over every system: the transient half of the state
 *  is by far the larger and more fragile half, it is worthless to reconstruct exactly, and
 *  "you keep everything you built, and re-fight the wave you died partway through" is both
 *  simpler to reason about and the more forgiving rule for the player.
 *
 *  RESTORE IS A REPLAY, NOT AN ASSIGNMENT. Rather than writing fields back onto the castle and
 *  player directly, restore re-issues the same purchases through the very same public APIs the
 *  menus call (buildWall/upgradeWall/buildStructure/upgradeStructure/buyAbilityRank/
 *  buyAbilityTreeNode), with gold temporarily raised so none of them can fail on cost. Everything
 *  derived therefore rebuilds itself for free and cannot drift from what a hand-built run looks
 *  like: expansion sockets get created by the wall node that grants them, structure instances get
 *  their real per-structure runtime state, `wall:built`/`structure:built` fire so the render
 *  views build their meshes, and battlement collision fns get rebuilt. `purchased` arrays are
 *  push-ordered, so replaying them in array order always satisfies each node's `requires` chain.
 *
 *  ASSUMES A FRESH GAMESTATE. Restore is only ever driven from the start screen of a
 *  just-loaded page (every other route to the menu reloads first), so it replays onto an
 *  untouched castle and player rather than trying to diff against an existing run. */

export const RUN_SNAPSHOT_VERSION = 1;

export interface WallSnapshot {
  tier: WallTier;
  built: boolean;
  hp: number;
  purchased: string[];
}

export interface StructureSnapshot {
  socketId: string;
  defId: string;
  purchased: string[];
}

export interface RunSnapshot {
  version: number;
  savedAt: number; // Date.now() — shown as "3 hours ago" on the resume card
  classId: string;
  abilityRanks: Record<string, number>;
  abilityTree: Record<string, string[]>; // abilityId -> owned mastery node ids, in purchase order
  gold: number;
  goldEarned: number;
  kills: number;
  waveNumber: number; // last wave CLEARED; the horn starts waveNumber + 1
  walls: WallSnapshot[];
  structures: StructureSnapshot[];
}

/** Wall upgrades live on the Castle class but not on the FROZEN CastleApi interface, so reach
 *  them through the same narrow-local-interface cast ui/menus.ts already uses for its castle
 *  menu rather than widening the shared contract. */
interface WallUpgradable {
  wallPurchased(tier: WallTier): string[];
  upgradeWall(tier: WallTier, nodeId: string): boolean;
}

export function captureRun(game: GameState): RunSnapshot | null {
  const player = game.localPlayer;
  if (!player) return null;
  const castle = game.castle as unknown as WallUpgradable;

  const abilityTree: Record<string, string[]> = {};
  for (const a of allAbilities(player.classDef)) {
    const owned = purchasedTreeNodes(player, a.id);
    if (owned.length > 0) abilityTree[a.id] = [...owned];
  }

  const structures: StructureSnapshot[] = [];
  for (const wall of game.castle.walls) {
    for (const socket of wall.sockets) {
      if (!socket.structure) continue;
      structures.push({
        socketId: socket.id,
        defId: socket.structure.defId,
        purchased: [...socket.structure.purchased],
      });
    }
  }

  return {
    version: RUN_SNAPSHOT_VERSION,
    savedAt: Date.now(),
    classId: player.classDef.id,
    abilityRanks: { ...player.abilityRanks },
    abilityTree,
    gold: game.gold,
    goldEarned: game.goldEarned,
    kills: game.kills,
    waveNumber: game.waveNumber,
    walls: game.castle.walls.map((w) => ({
      tier: w.tier,
      built: w.built,
      hp: w.hp,
      purchased: [...castle.wallPurchased(w.tier)],
    })),
    structures,
  };
}

/** Replays a snapshot onto a fresh GameState and leaves it in the build phase, ready to play.
 *  Returns false only when the snapshot names a class this build no longer has. */
export function restoreRun(game: GameState, snap: RunSnapshot): boolean {
  const player = game.localPlayer;
  if (!player) return false;
  const classDef = CLASS_REGISTRY.find((d) => d.id === snap.classId);
  if (!classDef) return false;
  applyClassToPlayer(player, classDef);

  const castle = game.castle as unknown as WallUpgradable;

  // Gold is the only gate on every API below, so lift it for the replay and write the real
  // balance back at the end. Assigning the field directly (rather than addGold) keeps goldEarned
  // — a run statistic, not a currency — from being inflated by the restore itself.
  game.gold = Number.MAX_SAFE_INTEGER;

  // Walls before structures: an expansion node is what creates the extra sockets that a saved
  // structure may be installed in. Tier 3 (the keep) starts built and cannot be re-built.
  for (const w of snap.walls) {
    if (w.built && w.tier !== 3) game.castle.buildWall(w.tier);
  }
  for (const w of snap.walls) {
    for (const nodeId of w.purchased) castle.upgradeWall(w.tier, nodeId);
  }

  for (const s of snap.structures) {
    if (!game.castle.buildStructure(s.socketId, s.defId)) continue;
    for (const nodeId of s.purchased) game.castle.upgradeStructure(s.socketId, nodeId);
  }

  for (const [abilityId, rank] of Object.entries(snap.abilityRanks)) {
    for (let i = 0; i < rank; i++) {
      if (!buyAbilityRank(game, player, abilityId)) break; // maxed or unknown id in an older save
    }
  }
  for (const [abilityId, nodeIds] of Object.entries(snap.abilityTree)) {
    const def = getAbilityDef(player.classDef, abilityId);
    if (!def) continue;
    for (const nodeId of nodeIds) buyAbilityTreeNode(game, player, def, nodeId);
  }

  // Damage last: buildWall and the upgrades that raise maxHp both reset/extend hp, so a wall's
  // saved damage has to be re-applied after its tree is in place. Clamped in case a node that
  // granted max hp is gone from a newer build.
  for (const w of snap.walls) {
    const wall = game.castle.walls[w.tier - 1];
    if (!wall.built) continue;
    wall.hp = Math.max(0, Math.min(w.hp, wall.maxHp));
  }

  game.gold = snap.gold;
  game.goldEarned = snap.goldEarned;
  game.kills = snap.kills;
  game.waveNumber = snap.waveNumber;
  game.setPhase('build');
  return true;
}
