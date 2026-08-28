import { Vector3 } from 'three';
import type { GameState } from './GameState';
import { allocId, type Enemy, type Unit, type Wall, type WallTier } from './types';
import { isStunned } from './status';
import {
  ALLY_BOUNDS,
  ARMY_RALLY_LOOKAHEAD,
  ARMY_RALLY_MAX_X,
  ARMY_RALLY_SMOOTHING,
} from '../data/allies';
import { WALL_THICKNESS } from '../data/castle';
import { separateAllies, stepMelee, stepRangedOrCaster, stepSupport } from './allyAI';
import { pulseThornsIfReady, tryMedicSave } from './allyTierEffects';

/** Owned by [structures-allies]. Generic ally AI: every spawner structure (armory, archer
 *  barracks, mage tower, tank barracks, field hospital) produces a `Unit` carrying a fully
 *  computed `AllyDef` snapshot (base stats + that structure's purchased upgrades, baked in at
 *  spawn time — future upgrades only affect allies spawned afterward, same rule the original
 *  Swordsman Armory already used). One tick loop below dispatches on `def.behavior`.
 *  Sim-only: no Math.random() (game.rng only), never touch THREE/DOM.
 *
 *  ---- Re-anchoring to the forwardmost wall ----
 *  Per the roadmap, EVERY ally behavior except engineer fights/works at the CURRENT front, not
 *  its spawning structure's own wall — a keep armory (or archer barracks, or field hospital)
 *  should still send its unit to the outer wall while it stands, at a depth appropriate to what
 *  that unit does (see the anchoring doc comment in data/allies.ts for the full per-behavior
 *  breakdown: melee out front, ranged/caster sheltered just behind them, medic behind that,
 *  engineer the one exception that stays put on its own home wall). `AllyDef.reanchorToFront`
 *  marks which behaviors do this. Each tick, every such ally's `guardZ` (only Z — see below) is
 *  recomputed from `game.castle.outermostIntactWall()` instead of its home wall, via `guardZFor`
 *  (the same helper `guardPostFor` uses at spawn, so the two can never compute different depths
 *  for the same def). `guardX` is fixed at spawn and never re-derived, which is what keeps this
 *  from turning into a stampede:
 *   - Each ally still only walks toward its OWN guard post (a point), never toward "the front"
 *     as a region, so when the front changes every ally independently retargets a new point and
 *     walks a straight line to it — there is no shared corridor for units to funnel through and
 *     no leader-follower chain, so nothing can conga-line.
 *   - A mid-fight ally keeps fighting/acting exactly as it always did (see stepMelee /
 *     stepRangedOrCaster): the guard post only matters once it goes idle (or, for ranged/caster/
 *     support, once it's outside `guardTolerance` of it). A wall falling doesn't yank anyone out
 *     of a swing or a shot; it just changes where they walk back to afterward.
 *   - The one real hazard is lateral: two DIFFERENT structures (e.g. a tier-1 and a tier-3
 *     archer barracks, both at chamber x = -6) re-anchoring to the same front wall would
 *     otherwise compute the *identical* guard post for their "slot 0" units and pile them on
 *     each other. That is now solved by forming ONE army rather than many squads: every tick,
 *     `rebuildFormation()` hands each reanchoring ally a slot in a single shared line per rank,
 *     centred on where the fighting actually is, so spawners on all three tiers contribute to the
 *     same shield wall / archer rank instead of each holding a private stretch of wall. The
 *     per-ally `separateAllies()` push-apart (sim/allyAI.ts) still runs every tick as a
 *     last-resort safety net.
 *  Engineer is the only behavior that does NOT reanchor — see ALLY_DEFS in data/allies.ts for why.
 *
 *  ---- Flying enemies (added after this module; see sim/flyers.ts) ----
 *  Melee allies are height-gated out of ever targeting a flyer at all (MELEE_TARGET_MAX_DY,
 *  data/allies.ts) — they have no way to reach one regardless. Ranged/caster allies deliberately
 *  CAN engage flyers; see the DECISION comment on stepRangedOrCaster in sim/allyAI.ts. */

export type AllyBehavior = 'melee' | 'ranged' | 'caster' | 'support';
export type SupportKind = 'medic' | 'engineer';

/** Data-driven ally definition. A structure computes one of these per spawn (base stats from
 *  ALLY_DEFS merged with that structure's purchased-upgrade deltas) and hands it to spawnAlly();
 *  the resulting unit carries the snapshot for its whole lifetime — upgrades bought later only
 *  change what NEW allies get, exactly like the original armory's Veterans upgrades did. */
export interface AllyDef {
  id: string; // stable kind key ('swordsman', 'archer', 'allyMage', 'tank', 'medic', 'engineer') — render picks a model off this
  name: string;
  behavior: AllyBehavior;

  hp: number;
  damage: number; // melee hit / ranged-caster projectile damage; 0 (unused) for support
  speed: number;
  /** Speed multiplier used ONLY while walking back to the formation post with no target, never
   *  while chasing or fighting. A tank is meant to be slow in a brawl, but one `speed` field was
   *  governing both brawling and forming up, so the slowest unit in the army also lost every
   *  race to its own line — the tank rank ended up BEHIND the swordsmen it is supposed to screen.
   *  Defaults to 1 (identical behaviour) for anything that doesn't set it. */
  formUpSpeedMult?: number;
  radius: number;
  height: number;

  attackInterval: number;
  attackRange: number; // melee reach (+ target radius), or ranged/caster max engagement range
  aggroRange: number; // target-acquisition leash, measured from the guard post, not the ally

  // ---- Battle-line formation (see guardPostFor) ----
  lineDistance: number; // offset from the relevant wall's face — home wall for engineer, current front for everyone else
  lineSide?: 'front' | 'back'; // 'front' (default) = out in the field; 'back' = sheltered courtyard
  lineSpacing: number; // lateral gap between this structure's own allies on the line
  separationRadius: number;
  separationStrength: number;
  guardTolerance: number;
  /** true = re-anchor guardZ to the CURRENT outermost intact wall every tick instead of the
   *  ally's own home wall. Every behavior except engineer (see module doc comment above and
   *  data/allies.ts's anchoring doc comment for the full per-behavior reasoning). */
  reanchorToFront?: boolean;

  /** Flat damage mitigation (0..1) applied in takeDamage. Generic (any behavior could use it in
   *  principle) but only the Tank Barracks' Plated Armor branch sets it today. */
  damageReductionPct?: number;

  // ---- Ranged/caster projectile attack ----
  projectileSpeed?: number;
  projectileRadius?: number;
  projectileTtl?: number;
  /** Fraction of the ally's own height the shot originates/aims from — also the eye height used
   *  for the castle line-of-sight check (see shotBlocked). */
  muzzleHeightFrac?: number;
  aoeRadius?: number; // caster splash; undefined/0 = single-target
  slowPct?: number; // caster on-impact debuff (via sim/status.ts)
  slowDuration?: number;

  // ---- Support ----
  supportKind?: SupportKind;
  healAmount?: number; // medic: hp restored per action, to each eligible unit
  healInterval?: number;
  healRange?: number;
  /** Medic only: how far from its formation post it will chase a wounded ally. The leash that
   *  keeps a medic near the army instead of following one straggler across the map. */
  followRange?: number;
  /** Medic only: how close it closes to the ally it's treating. Keeps it tucked beside the
   *  wounded rather than shoving into the front rank. */
  healStandoff?: number;
  repairRate?: number; // engineer: home-wall hp/sec restored while stationed, combat phase only

  // ---- High-tier spawner upgrades (600g/1600g, see each sim/structures/*.ts for the node
  // definitions and data/structures.ts for the numbers). Behavioral, not stat multipliers —
  // deliberately never touch hp/damage/speed directly, unlike the cheap tier below them. ----

  // Swordsman Armory — Bleeding Strikes (applied in stepMelee via sim/abilityEffects.ts's
  // applyBleed) vs Sundering Blows (applyVulnerability), mutually exclusive.
  bleedDpsPerStack?: number;
  bleedDuration?: number;
  bleedMaxStacks?: number;
  markVulnPct?: number;
  markVulnDuration?: number;

  // Archer Barracks — Broadhead Arrows (pierce, threaded into the projectile spec in fireAt)
  // vs Explosive Fletching (reuses aoeRadius above), mutually exclusive.
  pierce?: number;

  // Mage Tower — Arcane Residue (a lingering damage zone via spawnGroundEffect, fired from
  // fireAt's onImpact) vs Twin Casting (an extra bolt at a second target, stepRangedOrCaster),
  // mutually exclusive.
  lingerDps?: number;
  lingerDuration?: number;
  lingerRadius?: number;
  extraBoltCount?: number;
  extraBoltDamageMult?: number;

  // Tank Barracks — Retaliation Plating (a retaliation pulse on taking damage, see spawnAlly's
  // takeDamage) vs Hardened Resolve (heal-on-hit, stepMelee), mutually exclusive.
  thornsDamage?: number;
  thornsRadius?: number;
  healOnHit?: number;

  // Field Hospital — Guardian's Grace (medic only: save an ally from a killing blow, see
  // tryMedicSave below) and Emergency Patching (engineer only: a once-per-wave wall-hp burst,
  // see stepEngineer in sim/allyAI.ts) — independent of each other, not mutually exclusive (see
  // FIELD_HOSPITAL's doc comment in data/structures.ts for why this one building differs).
  reviveRange?: number;
  reviveHpFrac?: number;
  reviveCooldown?: number;
  emergencyThresholdPct?: number;
  emergencyPatchPct?: number;
}

/** Concrete ally unit. Everything in game.allies is one of these; render code may read the
 *  extra fields but must never write them. */
export interface AllyUnit extends Unit {
  def: AllyDef;
  yaw: number; // facing (radians, atan2(dx,dz) — matches enemyView's convention)
  guardX: number; // forward battle-line/support post — fixed at spawn (see module doc comment)
  guardZ: number; // re-derived every tick for reanchoring allies; fixed for everyone else
  homeTier: WallTier; // the wall this ally's structure is socketed on
  nextAttackAt: number; // game.time when it may attack/shoot again
  nextActionAt: number; // game.time when a support ally may next act (heal pulse)
  targetId: number | null; // id of the enemy currently engaged/tracked, or null when idle
  nextThornsAt: number; // Tank Barracks' Retaliation Plating: game.time when it may pulse again
  nextReviveAt: number; // Field Hospital's Guardian's Grace: game.time this MEDIC may save again
}

/** Lateral slot offsets within one structure's own battle line: slot 0 is dead center on the
 *  socket's x, then slots alternate outward right/left so a squad fills the line symmetrically
 *  as it grows and no two slots ever land on the same point. */
function lineSlotOffset(slot: number, spacing: number): number {
  if (slot <= 0) return 0;
  const step = Math.ceil(slot / 2);
  const sign = slot % 2 === 1 ? 1 : -1;
  return sign * step * spacing;
}

/** Lateral slot spacing is per-behaviour (see AllyDef.lineSpacing). Squads no longer get a
 *  per-tier lateral band: every reanchoring ally's guardX is recomputed each tick as part of ONE
 *  shared army formation (see rebuildFormation below), so a tier-3 armory's swordsmen fall in on
 *  the same shield wall as a tier-1 armory's rather than holding a private stretch of wall. */

/** The z half of a guard post against `wall`, honoring `lineSide` — 'front' sits `lineDistance`
 *  out from the wall's front face (into the field), 'back' sits `lineDistance` INTO the
 *  courtyard behind the wall's back face. Shared by `guardPostFor` (spawn time) and the
 *  reanchor tick below (every tick, for `reanchorToFront` allies) so the two can never drift
 *  out of sync on what "this ally's depth" means. */
function guardZFor(def: AllyDef, wall: Wall): number {
  return def.lineSide === 'back' ? wall.z + WALL_THICKNESS + def.lineDistance : wall.z - def.lineDistance;
}

/** Forward (or, for 'back'-sided allies, rearward) guard post for the `slot`-th ally of a
 *  structure whose home wall tier is `homeTier` and chamber socket sits at `socketX`, measured
 *  against `wall` — the ally's OWN home wall for the one non-reanchoring behaviour (engineer),
 *  or the current outermost intact wall for every reanchoring one (the caller decides which
 *  `Wall` to pass; this function only knows how to place a post relative to whichever wall it's
 *  given). Exported so structure code (which owns socket/slot bookkeeping) can hand each spawned
 *  ally its post without duplicating the formation math here. */
export function guardPostFor(
  def: AllyDef,
  wall: Wall,
  homeTier: WallTier,
  socketX: number,
  slot: number,
): { x: number; z: number } {
  // Reanchoring allies get this only as a spawn-frame placeholder — rebuildFormation() below
  // overwrites their guardX on the very next tick with their slot in the shared army line.
  const x = socketX + lineSlotOffset(slot, def.lineSpacing);
  const z = guardZFor(def, wall);
  return { x, z };
}

/** Where the army should mass right now: the average x of the enemies that actually matter —
 *  those at or near the front wall — eased toward, so the line drifts rather than twitching as
 *  enemies die. Falls back to the wall's centre when nothing is engaged yet.
 *
 *  This is what makes the army concentrate on the fight instead of holding assigned patches of
 *  wall. Module-level smoothing state (deterministic under command replay, same pattern as the
 *  wave scheduler's) rather than GameState, which is frozen. */
let rallyX = 0;

function updateRally(game: GameState, frontWall: Wall): void {
  let sum = 0;
  let n = 0;
  for (const e of game.enemies) {
    if (!e.alive) continue;
    if (e.pos.z < frontWall.z - ARMY_RALLY_LOOKAHEAD) continue; // still marching in, not the fight yet
    sum += e.pos.x;
    n += 1;
  }
  const target = n === 0 ? 0 : Math.max(-ARMY_RALLY_MAX_X, Math.min(ARMY_RALLY_MAX_X, sum / n));
  rallyX += (target - rallyX) * ARMY_RALLY_SMOOTHING;
}

/** Per-rank fill counters, reused every tick so the hot loop allocates nothing. */
const rankSlots: Record<string, number> = { melee: 0, ranged: 0, caster: 0, support: 0 };

/** Give every reanchoring ally its slot in the shared army line for its behaviour rank.
 *  Ranks keep their distinct DEPTH (tanks ahead of swordsmen, archers behind both, support in
 *  the courtyard) — this only unifies them LATERALLY, which is what "the whole army groups
 *  together in front" means. Slots are handed out in list order, so when an ally dies the line
 *  simply compacts instead of leaving a hole. */
function rebuildFormation(list: AllyUnit[], frontWall: Wall): void {
  rankSlots.melee = 0;
  rankSlots.ranged = 0;
  rankSlots.caster = 0;
  rankSlots.support = 0;
  for (const ally of list) {
    const def = ally.def;
    if (!def.reanchorToFront) continue; // engineer holds its own wall on purpose
    const slot = rankSlots[def.behavior]++;
    const x = rallyX + lineSlotOffset(slot, def.lineSpacing);
    ally.guardX = Math.max(-ARMY_RALLY_MAX_X - 4, Math.min(ARMY_RALLY_MAX_X + 4, x));
    ally.guardZ = guardZFor(def, frontWall);
  }
}

export function spawnAlly(game: GameState, def: AllyDef, pos: Vector3, guard: { x: number; z: number }, homeTier: WallTier): AllyUnit {
  const hp = Math.round(def.hp);
  const unit: AllyUnit = {
    id: allocId(),
    team: 'defender',
    pos: pos.clone(),
    radius: def.radius,
    height: def.height,
    hp,
    maxHp: hp,
    alive: true,
    def,
    yaw: Math.PI, // face the field (-Z) by default, like a guard at the door
    guardX: guard.x,
    guardZ: guard.z,
    homeTier,
    nextAttackAt: 0,
    nextActionAt: 0,
    targetId: null,
    nextThornsAt: 0,
    nextReviveAt: 0,
    takeDamage(amount: number, g: GameState): void {
      if (!unit.alive) return;
      const nextHp = unit.hp - amount * (1 - (unit.def.damageReductionPct ?? 0));
      if (nextHp > 0) {
        unit.hp = nextHp;
      } else {
        const saved = tryMedicSave(unit, g);
        if (saved !== null) {
          unit.hp = saved;
        } else {
          unit.hp = 0;
          unit.alive = false;
        }
      }
      if (unit.alive) pulseThornsIfReady(unit, g);
    },
  };
  game.allies.push(unit);
  return unit;
}

export function initAllies(game: GameState): void {
  const repairBudget = new Map<WallTier, number>();
  // Field Hospital's Emergency Patching: last wave number each wall tier's once-per-wave burst
  // fired on, shared across every engineer touching that wall (mirrors repairBudget's per-tier
  // sharing) so multiple engineers on the same wall can't each trigger their own burst.
  const emergencyPatchedWave = new Map<WallTier, number>();

  game.addSystem({
    tick(dt) {
      // cull the dead every tick, in every phase
      if (game.allies.some((a) => !a.alive)) {
        game.allies = game.allies.filter((a) => a.alive);
      }
      if (game.phase !== 'build' && game.phase !== 'combat') return;

      const list = game.allies as AllyUnit[]; // everything in game.allies today is one of these
      const enemies: Enemy[] = game.enemies.filter((e) => e.alive); // same living-only filter unitsOfTeam('attacker') applies
      const frontWall = game.castle.outermostIntactWall();
      repairBudget.clear();

      // Rebuild the shared army formation every tick: one line per rank, centred on the fight,
      // anchored to the current front wall. This replaces the old "each spawner holds its own
      // banded patch of wall" placement, which scattered the army into disconnected pockets and
      // left whole squads idle because target acquisition measures from an ally's own post.
      if (frontWall) {
        updateRally(game, frontWall);
        rebuildFormation(list, frontWall);
      }

      for (const ally of list) {
        if (isStunned(ally, game)) continue; // symmetry with enemies.ts — allies can be CC'd too
        switch (ally.def.behavior) {
          case 'melee':
            stepMelee(ally, dt, game, enemies);
            break;
          case 'ranged':
          case 'caster':
            stepRangedOrCaster(ally, dt, game, enemies);
            break;
          case 'support':
            stepSupport(ally, dt, game, repairBudget, emergencyPatchedWave);
            break;
        }
      }

      separateAllies(list, dt);

      for (const ally of list) {
        ally.pos.z = Math.max(ally.pos.z, ALLY_BOUNDS.minZ);
        ally.pos.x = Math.min(Math.max(ally.pos.x, -ALLY_BOUNDS.maxAbsX), ALLY_BOUNDS.maxAbsX);
        ally.pos.y = game.castle.worldHeight(ally.pos.x, ally.pos.z);
      }
    },
  });
}
