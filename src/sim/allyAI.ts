import { Vector3 } from 'three';
import type { GameState } from './GameState';
import type { Unit, WallTier } from './types';
import { moveMultiplier, applySlow } from './status';
import { ENGINEER_WALL_REPAIR_CAP, MELEE_TARGET_MAX_DY } from '../data/allies';
import type { AllyDef, AllyUnit } from './allies';

/** Owned by [structures-allies]. The four per-behavior step functions `initAllies` (sim/allies.ts)
 *  dispatches on, plus the shared movement/targeting helpers they use. Split out of allies.ts
 *  purely to keep that file under the ~400-line guideline — this module has no public surface
 *  other than what allies.ts imports; nothing outside sim/allies.ts should import from here. */

function distXZ(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function dist3D(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
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
 *  battlement geometry. Ranged/caster allies now reanchor to the CURRENT front wall (see
 *  data/allies.ts's anchoring doc comment) and stand in front of it, same field-side half-space
 *  as every enemy they'd target, so this mostly guards against their OWN front wall's merlon
 *  geometry blocking a low-angle shot (a diving dragon below merlon height, or a shooter whose
 *  post ends up tucked squarely behind a merlon) — not the old "stationed at an inner wall that
 *  isn't the front" case, which reanchoring now prevents. Still the exact same "is there stone
 *  in the way" check the crossbow uses. */
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

/** Melee: chase the nearest (roughly-same-level) enemy within aggro range of the guard post,
 *  otherwise return to it. Byte-identical to the original spawnSwordsman AI, plus a height gate
 *  (MELEE_TARGET_MAX_DY, mirroring ENEMY_AI.aggroMaxDy's ground-vs-wall-top precedent) added
 *  once flying enemies landed: without it, a melee ally standing under a hot air balloon or
 *  cruising dragon would lock onto it as "nearest" and stand there swinging at the sky, ignoring
 *  the ground enemies actually attacking it — melee has no way to reach an airborne target at
 *  all, unlike ranged/caster allies (see stepRangedOrCaster), so it should never even try. */
export function stepMelee(ally: AllyUnit, dt: number, game: GameState, enemies: Unit[]): void {
  const def = ally.def;
  const speed = def.speed * moveMultiplier(ally, game);
  let target: Unit | null = null;
  let bestD = def.aggroRange;
  for (const e of enemies) {
    if (Math.abs(e.pos.y - ally.pos.y) >= MELEE_TARGET_MAX_DY) continue;
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

/** Ranged/caster: hold the guard post — never chase — and shoot whatever's in range and in
 *  sight from wherever that post is. "Archer allies: hold position" per the task; caster
 *  (ally mage) reuses the exact same shape, just with a heavier/slower shot.
 *
 *  DECISION: ranged/caster allies CAN engage flying enemies (hot air balloon, dragon — see
 *  isFlyerDef/FLYER_AI in data/enemies.ts) — unlike melee (see stepMelee), which is gated out
 *  entirely by height. This gives the player a buildable anti-air answer beyond their own class
 *  and the crossbow towers, matching the roadmap principle that air units need a real counter.
 *  Two things had to actually work for that, not just "not crash": (1) the final range check
 *  below is a true 3D distance (dist3D), not the guard-post XZ distance used for target
 *  *selection* — a flyer at cruise altitude (~10) directly overhead reads as XZ-adjacent but may
 *  still be out of real attackRange, and a flyer far off laterally but low would otherwise be
 *  wrongly rejected; (2) shotBlocked/fireAt below already build a genuinely 3D muzzle-to-target
 *  vector and feed it through castle.blocksProjectile (also fully 3D — see sim/castle.ts), so a
 *  balloon well above the merlon line is correctly unblocked while a diving dragon below it is
 *  correctly blockable, with no changes needed there. */
export function stepRangedOrCaster(ally: AllyUnit, dt: number, game: GameState, enemies: Unit[]): void {
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
  if (dist3D(ally.pos.x, ally.pos.y, ally.pos.z, target.pos.x, target.pos.y, target.pos.z) > def.attackRange) return;
  if (game.time < ally.nextAttackAt) return;
  if (shotBlocked(game, ally, target)) return; // wall in the way — don't feed shots into stone
  ally.nextAttackAt = game.time + def.attackInterval;
  fireAt(ally, def, target, game);
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
 *  engineers hold position, same as every other support/ranged ally). This is exactly why
 *  engineer, alone among every ally behavior, does NOT set `reanchorToFront` (see data/allies.ts's
 *  anchoring doc comment): its post is a fixed reference to `ally.homeTier`'s wall, so wandering
 *  off to the current front — possibly a different wall entirely — would only disconnect it from
 *  the wall it actually repairs, for zero mechanical benefit (repair here isn't proximity-gated,
 *  it just reads `ally.homeTier` directly below). Heals wall.hp directly rather than going
 *  through castle.repairWall(), which is the whole point: repairWall() spends
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

/** Support (medic/engineer): hold the guard post, never engage enemies. Both use this exact same
 *  movement shape; only what the post itself resolves to differs (medic's follows the current
 *  front, engineer's stays pinned to its own home wall — see data/allies.ts / stepEngineer above).
 *  Per the roadmap, both are "active only during combat" — DECISION: that means they only ACT
 *  (heal/repair) during the combat phase; they still exist, sortie, and walk to their post
 *  during the build phase (matching every other ally's existing build+combat tick gating in
 *  initAllies), they just do nothing useful until the horn sounds. Spawning itself is not
 *  phase-gated — a Field Hospital
 *  raised mid-build immediately starts training its first medic/engineer, same as an Armory
 *  does, so the player sees their gold take effect right away instead of a building that
 *  visibly does nothing until combat starts. */
export function stepSupport(ally: AllyUnit, dt: number, game: GameState, repairBudget: Map<WallTier, number>): void {
  const def = ally.def;
  const speed = def.speed * moveMultiplier(ally, game);
  const dPost = distXZ(ally.pos.x, ally.pos.z, ally.guardX, ally.guardZ);
  if (dPost > def.guardTolerance) moveToward(ally, ally.guardX, ally.guardZ, speed, dt);
  ally.targetId = null;
  if (game.phase !== 'combat') return;

  if (def.supportKind === 'medic') stepMedic(ally, def, game);
  else if (def.supportKind === 'engineer') stepEngineer(ally, def, dt, game, repairBudget);
}

/** Gentle pairwise push-apart so allies don't stack. Averages the two combatants' own
 *  separation stats, so mixed squads (e.g. a tank and a swordsman both fighting the same front)
 *  behave sensibly without one type's numbers dominating. */
export function separateAllies(list: AllyUnit[], dt: number): void {
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
