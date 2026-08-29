import type { AbilityDef, PlayerState, UpgradeNode } from './types';
import type { GameState } from './GameState';

/** Owned by [player-classes]. Late-game branching ability upgrades ("Mastery" trees) — split out
 *  of sim/classes.ts to keep that file under the ~400-line guideline (same reasoning
 *  sim/structures.ts split into sim/structures/*.ts for).
 *
 *  Mechanism choice: reuse the exact same node-tree shape structures already use (`UpgradeNode`:
 *  id/name/desc/cost/requires/excludes, resolved by castle.upgradeStructure and rendered by
 *  ui/menuWidgets.ts's branchColumns/nodeState/upgradeNodeHtml) instead of inventing a second
 *  progression system. `AbilityDef` (sim/types.ts) is FROZEN and has no room for a tree, so this
 *  file declares a wider `AbilityWithTree` shape and data/<class>.ts files type their ability
 *  constants as that (a strict superset of AbilityDef) instead of the frozen interface directly —
 *  assigning them into a PlayerClassDef's plain `AbilityDef`-typed fields is then just an ordinary
 *  upcast (no excess-property errors), the same "adapter in your own module, not a frozen-file
 *  edit" pattern sim/projectiles.ts uses for `CastleBlocking`.
 *
 *  Deliberately NOT gated behind maxing an ability's linear ranks first: structures don't force
 *  "max damage before you can pick Rapid/Ballista/Cannon" either, and the steep tier costs below
 *  (600/1600, vs a maxed linear kit costing ~260-540g total) already make rushing a mastery node
 *  before the cheap linear ranks a poor trade in practice, without needing a hard rule to enforce it. */

export interface AbilityTreeNode extends UpgradeNode {
  /** Stats this node grants once purchased, merged on top of the ability's linear rank stats (see
   *  sim/classes.ts's getAbilityStats). Absolute totals, not deltas — a tier-2 node restates the
   *  tier-1 numbers as a bigger total rather than stacking on top of it.
   *
   *  Restating totals means a node also restates stats it isn't really changing, at whatever the
   *  numbers were when it was authored. That was harmless while ranks stopped at IV, but ranks now
   *  run to X, so a plain override would let a Mastery purchase *downgrade* a deep-ranked ability
   *  — buying Wings of the Abyss cutting a rank-X flight from 13s to 9.6s. applyTreeStats keeps
   *  whichever value is better instead, so a node can only ever add. */
  stats: Record<string, number>;
  /** Stat keys this node means to force even when that makes them WORSE — a real trade, not a
   *  stale restatement. Fork Bolt genuinely gives up piercing to split, Empowered Bolt genuinely
   *  collapses back to a single bolt, War Leap genuinely drops the stun for a shorter cooldown.
   *  Without this they'd keep the deep ranks' pierce/volley/stun and their branches would stop
   *  meaning anything. */
  overrides?: string[];
}

/** Stats where a SMALLER number is the better one, so "keep the better value" doesn't mean max. */
const LOWER_IS_BETTER = new Set(['cooldownMult']);

export interface AbilityWithTree extends AbilityDef {
  /** Optional late-game branching tree hanging off the ability's linear ranks. Absent = no
   *  Mastery section for this ability in the Tab menu — nothing else has to change. */
  tree?: AbilityTreeNode[];
}

/** Uniform per-tier cost, same convention as the crossbow's three branches costing identically
 *  per tier (data/structures.ts's CROSSBOW.upgrades: every root 50g, every second tier 90g) —
 *  "cost scales with power, tier over tier," not "different price per branch." Every
 *  data/<class>Tree.ts file uses these two numbers instead of hand-copying them, so retuning the
 *  whole game's mastery-tree economy is a one-line change. See docs/GAME_DESIGN.md for the
 *  income-vs-cost math that justifies these specific numbers. */
export const TREE_TIER_COST = [600, 1600] as const;

export function abilityTree(def: AbilityDef): AbilityTreeNode[] {
  return (def as AbilityWithTree).tree ?? [];
}

export function hasAbilityTree(def: AbilityDef): boolean {
  return abilityTree(def).length > 0;
}

// ---------- purchased-node state ----------
// PlayerState (sim/types.ts) is FROZEN and has no room for "which mastery nodes has this player
// bought, per ability" — kept here instead, the same WeakMap-off-to-the-side shape as
// sim/classes.ts's damageReduction and sim/castle.ts's per-wall wallPurchasedMap.
const purchases = new WeakMap<PlayerState, Record<string, string[]>>();

/** Read-only copy of the mastery node ids a player owns for one ability. */
export function purchasedTreeNodes(player: PlayerState, abilityId: string): string[] {
  return purchases.get(player)?.[abilityId] ?? [];
}

function findNode(tree: AbilityTreeNode[], id: string): AbilityTreeNode | undefined {
  return tree.find((n) => n.id === id);
}

/** Same requires/excludes validation sim/castle.ts's upgradeStructure/upgradeWall use: a node is
 *  buyable once, its prerequisite (if any) must already be owned, and nothing already owned may
 *  exclude it (checked both directions, so either root of a mutually-exclusive pair locks out
 *  the other regardless of purchase order). */
export function buyAbilityTreeNode(
  game: GameState,
  player: PlayerState,
  def: AbilityDef,
  nodeId: string
): boolean {
  const tree = abilityTree(def);
  const node = findNode(tree, nodeId);
  if (!node) return false;
  const owned = purchasedTreeNodes(player, def.id);
  if (owned.includes(nodeId)) return false;
  if (node.requires && !owned.includes(node.requires)) return false;
  for (const ownedId of owned) {
    const ownedNode = findNode(tree, ownedId);
    if (ownedNode?.excludes?.includes(nodeId)) return false;
    if (node.excludes?.includes(ownedId)) return false;
  }
  if (!game.trySpend(node.cost)) return false;
  const rec = purchases.get(player) ?? {};
  rec[def.id] = [...(rec[def.id] ?? []), nodeId];
  purchases.set(player, rec);
  return true;
}

/** Merged stats from every mastery node the player owns for this ability, applied in tree-array
 *  order (a capstone listed after its tier-1 prerequisite always overrides it, exactly like
 *  AbilityRank merging). Called from sim/classes.ts's getAbilityStats and applied on top of the
 *  linear rank stats, so a tree node only needs to name the stats it actually changes. */
/** Merge every purchased Mastery node into `base` (the ability's merged linear-rank stats), in
 *  tree order so a tier-2 node lands after its tier-1 prerequisite.
 *
 *  A node never lowers a stat it already shares with the ranks — see AbilityTreeNode.stats for
 *  why that matters now that ranks run to X — unless it names the key in `overrides`, which marks
 *  a deliberate trade rather than a stale restatement. Keys the ranks don't have at all are
 *  simply granted; that's how a node adds something genuinely new. */
export function applyTreeStats(player: PlayerState, def: AbilityDef, base: Record<string, number>): void {
  const tree = abilityTree(def);
  if (tree.length === 0) return;
  const owned = purchasedTreeNodes(player, def.id);
  if (owned.length === 0) return;
  for (const node of tree) {
    if (!owned.includes(node.id)) continue;
    for (const [key, value] of Object.entries(node.stats)) {
      const current = base[key];
      if (current === undefined || node.overrides?.includes(key)) {
        base[key] = value;
        continue;
      }
      base[key] = LOWER_IS_BETTER.has(key) ? Math.min(current, value) : Math.max(current, value);
    }
  }
}
