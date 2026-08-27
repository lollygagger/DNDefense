import { Vector3 } from 'three';
import type { GameState } from './GameState';
import { allocId, type Unit, type Wall, type WallTier } from './types';
import { isStunned, moveMultiplier, applySlow } from './status';
import { ALLY_BOUNDS, ENGINEER_WALL_REPAIR_CAP } from '../data/allies';
import { WALL_THICKNESS } from '../data/castle';

/** Owned by [structures-allies]. Generic ally AI: every spawner structure (armory, archer
 *  barracks, mage tower, tank barracks, field hospital) produces a `Unit` carrying a fully
 *  computed `AllyDef` snapshot (base stats + that structure's purchased upgrades, baked in at
 *  spawn time — future upgrades only affect allies spawned afterward, same rule the original
 *  Swordsman Armory already used). One tick loop below dispatches on `def.behavior`.
 *  Sim-only: no Math.random() (game.rng only), never touch THREE/DOM.
 *
 *  ---- Melee re-anchoring to the forwardmost wall ----
 *  Per the roadmap, melee allies (swordsman, tank) must fight at the CURRENT front, not their
 *  spawning structure's own wall — a keep armory should still send its swordsmen to the outer
 *  wall while it stands. `AllyDef.reanchorToFront` marks which behaviours do this. Each tick,
 *  every such ally's `guardZ` (only Z — see below) is recomputed from
 *  `game.castle.outermostIntactWall()` instead of its home wall. `guardX` is fixed at spawn and
 *  never re-derived, which is what keeps this from turning into a stampede:
 *   - Each ally still only walks toward its OWN guard post (a point), never toward "the front"
 *     as a region, so when the front changes every ally independently retargets a new point and
 *     walks a straight line to it — there is no shared corridor for units to funnel through and
 *     no leader-follower chain, so nothing can conga-line.
 *   - A mid-fight ally keeps fighting its current target exactly as it always did (see
 *     stepMelee): the guard post only matters once it goes idle. A wall falling doesn't yank
 *     anyone out of a swing; it just changes where they walk back to afterward.
 *   - The one real hazard is lateral: two DIFFERENT structures (e.g. a tier-1 and a tier-3
 *     armory, both at chamber x = -6) re-anchoring to the same front wall would otherwise
 *     compute the *identical* guard post for their "slot 0" units and pile them on each other.
 *     `guardPostFor` avoids this with a small per-tier lateral band (`TIER_LATERAL_BAND`) baked
 *     into `guardX` at spawn, so squads from different tiers form adjacent parallel lines at the
 *     new front instead of stacking — on top of the existing per-ally `separate()` push-apart,
 *     which still runs every tick as a last-resort safety net.
 *  Ranged/caster/support allies do NOT reanchor — see ALLY_DEFS in data/allies.ts for why. */

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
  lineDistance: number; // offset from the home wall's relevant face
  lineSide?: 'front' | 'back'; // 'front' (default) = out in the field; 'back' = sheltered courtyard
  lineSpacing: number; // lateral gap between this structure's own allies on the line
  separationRadius: number;
  separationStrength: number;
  guardTolerance: number;
  /** true = re-anchor guardZ to the CURRENT outermost intact wall every tick instead of the
   *  ally's own home wall. Melee-only (see module doc comment above). */
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

/** Forward (or, for 'back'-sided allies, rearward) guard post for the `slot`-th ally of a
 *  structure whose home wall tier is `homeTier` and chamber socket sits at `socketX`, measured
 *  against `wall` — the ally's OWN home wall for non-reanchoring behaviours, or the current
 *  outermost intact wall for reanchoring ones (the caller decides which `Wall` to pass; this
 *  function only knows how to place a post relative to whichever wall it's given). Exported so
 *  structure code (which owns socket/slot bookkeeping) can hand each spawned ally its post
 *  without duplicating the formation math here. */
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
  const z = def.lineSide === 'back' ? wall.z + WALL_THICKNESS + def.lineDistance : wall.z - def.lineDistance;
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

// ---------- AI internals ----------

function distXZ(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function moveToward(u: AllyUnit, tx: number, tz: number, speed: number, dt: number): void {
  const dx = tx - u.pos.x;
  const dz = tz - u.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-4) return;
  const step = Math.min(speed * dt, d);
  u.pos.x += (dx / d) * step;
  u.pos.z += (dz / d) * step;
  u.yaw = Math.atan2(dx, dz);
}

function faceToward(u: AllyUnit, px: number, pz: number): void {
  const dx = px - u.pos.x;
  const dz = pz - u.pos.z;
  if (dx * dx + dz * dz > 1e-6) u.yaw = Math.atan2(dx, dz);
}

/** Narrow view of the castle sim for line-of-sight checks — same local-interface trick
 *  sim/projectiles.ts and sim/structures.ts use so the frozen CastleApi never has to know about
 *  battlement geometry. Ranged/caster allies can end up stationed behind an intact wall that
 *  isn't the front (e.g. an archer barracks on the keep while the outer wall still stands), so
 *  they need the exact same "is there stone in the way" check the crossbow uses. */
interface CastleBlocking {
  blocksProjectile(from: Vector3, to: Vector3, outHit: Vector3): boolean;
}
const tmpMuzzle = new Vector3();
const tmpAim = new Vector3();
const tmpLosHit = new Vector3();
const tmpVel = new Vector3();

function muzzleOf(u: AllyUnit): Vector3 {
  tmpMuzzle.set(u.pos.x, u.pos.y + u.height * (u.def.muzzleHeightFrac ?? 0.85), u.pos.z);
  return tmpMuzzle;
}

function shotBlocked(game: GameState, u: AllyUnit, target: Unit): boolean {
  tmpAim.set(target.pos.x, target.pos.y + target.height * 0.5, target.pos.z);
  return (game.castle as unknown as CastleBlocking).blocksProjectile(muzzleOf(u), tmpAim, tmpLosHit);
}

/** Melee: chase the nearest enemy within aggro range of the guard post, otherwise return to it.
 *  Byte-identical logic to the original spawnSwordsman AI, just reading stats off `ally.def`
 *  instead of the SWORDSMAN constant so it now also drives the Tank Barracks. */
function stepMelee(ally: AllyUnit, dt: number, game: GameState, enemies: Unit[]): void {
  const def = ally.def;
  const speed = def.speed * moveMultiplier(ally, game);
  let target: Unit | null = null;
  let bestD = def.aggroRange;
  for (const e of enemies) {
    const d = distXZ(e.pos.x, e.pos.z, ally.guardX, ally.guardZ);
    if (d < bestD) {
      bestD = d;
      target = e;
    }
  }

  if (target) {
    ally.targetId = target.id;
    const d = distXZ(ally.pos.x, ally.pos.z, target.pos.x, target.pos.z);
    const reach = def.attackRange + target.radius;
    if (d > reach) {
      moveToward(ally, target.pos.x, target.pos.z, speed, dt);
    } else {
      faceToward(ally, target.pos.x, target.pos.z);
      if (game.time >= ally.nextAttackAt) {
        ally.nextAttackAt = game.time + def.attackInterval;
        target.takeDamage(def.damage, game);
      }
    }
    return;
  }
  ally.targetId = null;
  const d = distXZ(ally.pos.x, ally.pos.z, ally.guardX, ally.guardZ);
  if (d > def.guardTolerance) moveToward(ally, ally.guardX, ally.guardZ, speed, dt);
}

/** Ranged/caster: hold the guard post — never chase — and shoot whatever's in range and in
 *  sight from wherever that post is. "Archer allies: hold position" per the task; caster
 *  (ally mage) reuses the exact same shape, just with a heavier/slower shot. */
function stepRangedOrCaster(ally: AllyUnit, dt: number, game: GameState, enemies: Unit[]): void {
  const def = ally.def;
  const speed = def.speed * moveMultiplier(ally, game);
  const dPost = distXZ(ally.pos.x, ally.pos.z, ally.guardX, ally.guardZ);
  if (dPost > def.guardTolerance) moveToward(ally, ally.guardX, ally.guardZ, speed, dt);

  let target: Unit | null = null;
  let bestD = def.aggroRange;
  for (const e of enemies) {
    const d = distXZ(e.pos.x, e.pos.z, ally.guardX, ally.guardZ);
    if (d < bestD) {
      bestD = d;
      target = e;
    }
  }
  if (!target) {
    ally.targetId = null;
    return;
  }
  ally.targetId = target.id;
  faceToward(ally, target.pos.x, target.pos.z);
  if (distXZ(ally.pos.x, ally.pos.z, target.pos.x, target.pos.z) > def.attackRange) return;
  if (game.time < ally.nextAttackAt) return;
  if (shotBlocked(game, ally, target)) return; // wall in the way — don't feed shots into stone
  ally.nextAttackAt = game.time + def.attackInterval;
  fireAt(ally, def, target, game);
}

function fireAt(ally: AllyUnit, def: AllyDef, target: Unit, game: GameState): void {
  const muzzle = muzzleOf(ally).clone();
  const aimY = target.pos.y + target.height * 0.5;
  tmpVel.set(target.pos.x - muzzle.x, aimY - muzzle.y, target.pos.z - muzzle.z);
  if (tmpVel.lengthSq() < 1e-6) return;
  tmpVel.normalize().multiplyScalar(def.projectileSpeed ?? 30);

  const slowPct = def.slowPct;
  const slowDuration = def.slowDuration ?? 2;
  const aoeRadius = def.aoeRadius;
  game.projectiles.spawn({
    pos: muzzle,
    vel: tmpVel.clone(),
    team: 'defender',
    damage: def.damage,
    radius: def.projectileRadius ?? 0.2,
    aoeRadius,
    ttl: def.projectileTtl ?? 1.5,
    // Reuse existing render styles rather than adding new ones to render/fx.ts (owned by
    // [ability-fx], not this task): 'arrow' already renders a plain fletched shaft (archer
    // allies), 'frost' already renders an icy impact + lingering field sized to aoeRadius
    // (ally mage's slow-on-hit caster bolt).
    kind: def.behavior === 'caster' ? 'frost' : 'arrow',
    onImpact:
      slowPct && aoeRadius
        ? (g, at) => {
            const factor = 1 - slowPct / 100;
            for (const e of g.enemies) {
              if (!e.alive) continue;
              const dx = e.pos.x - at.x;
              const dz = e.pos.z - at.z;
              if (dx * dx + dz * dz <= aoeRadius * aoeRadius) applySlow(e, g, factor, slowDuration);
            }
          }
        : undefined,
  });
}

/** Support (medic/engineer): hold the guard post, never engage enemies. Per the roadmap, both
 *  are "active only during combat" — DECISION: that means they only ACT (heal/repair) during
 *  the combat phase; they still exist, sortie, and walk to their post during the build phase
 *  (matching every other ally's existing build+combat tick gating in initAllies below), they
 *  just do nothing useful until the horn sounds. Spawning itself is not phase-gated — a Field
 *  Hospital raised mid-build immediately starts training its first medic/engineer, same as an
 *  Armory does, so the player sees their gold take effect right away instead of a building that
 *  visibly does nothing until combat starts. */
function stepSupport(ally: AllyUnit, dt: number, game: GameState, repairBudget: Map<WallTier, number>): void {
  const def = ally.def;
  const speed = def.speed * moveMultiplier(ally, game);
  const dPost = distXZ(ally.pos.x, ally.pos.z, ally.guardX, ally.guardZ);
  if (dPost > def.guardTolerance) moveToward(ally, ally.guardX, ally.guardZ, speed, dt);
  ally.targetId = null;
  if (game.phase !== 'combat') return;

  if (def.supportKind === 'medic') stepMedic(ally, def, game);
  else if (def.supportKind === 'engineer') stepEngineer(ally, def, dt, game, repairBudget);
}

function stepMedic(ally: AllyUnit, def: AllyDef, game: GameState): void {
  if (game.time < ally.nextActionAt) return;
  ally.nextActionAt = game.time + (def.healInterval ?? 1.5);
  const range = def.healRange ?? 8;
  const amount = def.healAmount ?? 8;
  let healedAny = false;
  for (const u of game.unitsOfTeam('defender')) {
    if (!u.alive || u.hp >= u.maxHp) continue;
    const dx = u.pos.x - ally.pos.x;
    const dz = u.pos.z - ally.pos.z;
    if (dx * dx + dz * dz > range * range) continue;
    u.hp = Math.min(u.maxHp, u.hp + amount);
    healedAny = true;
  }
  // Reuse Second Wind's rose heal-glow (render/fx.ts) rather than adding a new impact kind.
  if (healedAny) game.projectiles.impacts.push({ pos: ally.pos.clone(), kind: 'secondWind', aoe: false });
}

/** Repairs the engineer's OWN home wall only (no pathfinding to "nearest damaged wall" —
 *  engineers hold position, same as every other support/ranged ally). Heals wall.hp directly
 *  rather than going through castle.repairWall(), which is the whole point: repairWall() spends
 *  player gold and instantly tops the wall to full, while this is a slow, free, passive trickle
 *  that only runs during combat. `repairBudget` is a per-tick, per-wall-tier ceiling
 *  (ENGINEER_WALL_REPAIR_CAP, see data/allies.ts) shared across every engineer touching that
 *  wall this tick, regardless of how many Field Hospitals/upgrades exist — the hard cap that
 *  keeps a maxed-out setup from making a wall effectively invincible under sustained assault. */
function stepEngineer(ally: AllyUnit, def: AllyDef, dt: number, game: GameState, repairBudget: Map<WallTier, number>): void {
  const wall = game.castle.walls[ally.homeTier - 1];
  if (!wall.built || wall.hp <= 0 || wall.hp >= wall.maxHp) return;
  // Budget is expressed in hp/sec (ENGINEER_WALL_REPAIR_CAP) but tracked in hp actually applied
  // this tick, so scale the ceiling by dt to compare like with like.
  const tickCap = ENGINEER_WALL_REPAIR_CAP * dt;
  const already = repairBudget.get(wall.tier) ?? 0;
  const capRemaining = tickCap - already;
  if (capRemaining <= 0) return;
  const applied = Math.min((def.repairRate ?? 10) * dt, capRemaining);
  wall.hp = Math.min(wall.maxHp, wall.hp + applied);
  repairBudget.set(wall.tier, already + applied);
}

/** Gentle pairwise push-apart so allies don't stack. Averages the two combatants' own
 *  separation stats, so mixed squads (e.g. a tank and a swordsman both fighting the same front)
 *  behave sensibly without one type's numbers dominating. */
function separate(list: AllyUnit[], dt: number): void {
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      if (!b.alive) continue;
      const minD = (a.def.separationRadius + b.def.separationRadius) / 2;
      let dx = b.pos.x - a.pos.x;
      let dz = b.pos.z - a.pos.z;
      if (dx > minD || dx < -minD || dz > minD || dz < -minD) continue; // cheap reject
      let d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      if (d2 < 1e-6) {
        dx = a.id % 2 === 0 ? 0.01 : -0.01;
        dz = b.id % 2 === 0 ? 0.01 : -0.01;
        d2 = dx * dx + dz * dz;
      }
      const d = Math.sqrt(d2);
      const overlap = (minD - d) / minD; // 0..1, 1 = fully stacked
      const push = overlap * ((a.def.separationStrength + b.def.separationStrength) / 2) * dt;
      const nx = dx / d;
      const nz = dz / d;
      a.pos.x -= nx * push * 0.5;
      a.pos.z -= nz * push * 0.5;
      b.pos.x += nx * push * 0.5;
      b.pos.z += nz * push * 0.5;
    }
  }
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

      // Re-anchor reanchoring (melee) allies' guard Z to the current front every tick — see the
      // module doc comment for why this can't turn into a stampede. guardX is untouched: it was
      // already banded/fanned at spawn time (see guardPostFor) and never needs to move again.
      if (frontWall) {
        for (const ally of list) {
          if (ally.def.reanchorToFront) ally.guardZ = frontWall.z - ally.def.lineDistance;
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

      separate(list, dt);

      for (const ally of list) {
        ally.pos.z = Math.max(ally.pos.z, ALLY_BOUNDS.minZ);
        ally.pos.x = Math.min(Math.max(ally.pos.x, -ALLY_BOUNDS.maxAbsX), ALLY_BOUNDS.maxAbsX);
        ally.pos.y = game.castle.worldHeight(ally.pos.x, ally.pos.z);
      }
    },
  });
}
