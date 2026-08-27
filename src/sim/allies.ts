import { Vector3 } from 'three';
import type { GameState } from './GameState';
import { allocId, type Unit, type Wall, type WallTier } from './types';
import { isStunned } from './status';
import { ALLY_BOUNDS } from '../data/allies';
import { WALL_THICKNESS } from '../data/castle';
import { separateAllies, stepMelee, stepRangedOrCaster, stepSupport } from './allyAI';

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
 *     each other — and this now applies to every reanchoring behavior, not just melee, since
 *     spawners of any kind can sit on any of the three tiers. `guardPostFor` avoids this with a
 *     small per-tier lateral band (`TIER_LATERAL_BAND`) baked into `guardX` at spawn, so squads
 *     from different tiers form adjacent parallel lines at the new front instead of stacking —
 *     on top of the existing per-ally `separateAllies()` push-apart (sim/allyAI.ts), which still
 *     runs every tick as a last-resort safety net. Because the band is keyed on (socketX,
 *     homeTier) alone, it separates same-behavior squads from different tiers exactly the same
 *     way regardless of which behavior they are — melee, ranged, caster, and medic squads from
 *     three different walls' spawners all converging on one front line each get their own
 *     lateral slot without any behavior-specific casing.
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
  healRange?: number; // medic: radius around the medic's OWN position counted as "nearby"
  repairRate?: number; // engineer: home-wall hp/sec restored while stationed, combat phase only
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

/** Extra lateral shift applied per home wall tier, only for allies that reanchor to the front.
 *  Keeps a tier-3 armory's squad from landing exactly on top of a tier-1 armory's squad (same
 *  chamber x, -6 or +6) when both end up forming on the same front wall — see the module doc
 *  comment. 0 for a tier-1 structure (the common case is completely unaffected), so nothing
 *  changes until a wall actually falls and a further-back squad gets redirected. */
const TIER_LATERAL_BAND = 3;

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
  const band = def.reanchorToFront
    ? socketX + Math.sign(socketX || 1) * (homeTier - 1) * TIER_LATERAL_BAND
    : socketX;
  const x = band + lineSlotOffset(slot, def.lineSpacing);
  const z = guardZFor(def, wall);
  return { x, z };
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
    takeDamage(amount: number, _g: GameState): void {
      if (!unit.alive) return;
      unit.hp -= amount * (1 - (unit.def.damageReductionPct ?? 0));
      if (unit.hp > 0) return;
      unit.hp = 0;
      unit.alive = false;
    },
  };
  game.allies.push(unit);
  return unit;
}

export function initAllies(game: GameState): void {
  const repairBudget = new Map<WallTier, number>();

  game.addSystem({
    tick(dt) {
      // cull the dead every tick, in every phase
      if (game.allies.some((a) => !a.alive)) {
        game.allies = game.allies.filter((a) => a.alive);
      }
      if (game.phase !== 'build' && game.phase !== 'combat') return;

      const list = game.allies as AllyUnit[]; // everything in game.allies today is one of these
      const enemies = game.unitsOfTeam('attacker');
      const frontWall = game.castle.outermostIntactWall();
      repairBudget.clear();

      // Re-anchor every reanchoring ally's guard Z to the current front every tick — see the
      // module doc comment for why this can't turn into a stampede. guardZFor honors lineSide,
      // so 'back'-sided allies (medic) land in the courtyard behind the new front wall, not out
      // in front of it, exactly like guardPostFor computes at spawn. guardX is untouched: it was
      // already banded/fanned at spawn time (see guardPostFor) and never needs to move again.
      if (frontWall) {
        for (const ally of list) {
          if (ally.def.reanchorToFront) ally.guardZ = guardZFor(ally.def, frontWall);
        }
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
            stepSupport(ally, dt, game, repairBudget);
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
