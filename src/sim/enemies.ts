import { Vector3 } from 'three';
import type { GameState } from './GameState';
import { allocId, type Enemy, type EnemyDef, type Unit, type Wall } from './types';
import { ELITE, ENEMY_AI, getEnemyDef, isFlyerDef } from '../data/enemies';
import { ENEMY_SPAWN_Z, FIELD_MAX_X, FIELD_MIN_X, WALL_HALF_WIDTH } from '../data/castle';
import { isStunned, moveMultiplier } from './status';
import { isVulnerable } from './abilityEffects';
import { recordEnemyDamage } from './damageEvents';
import { stepFlyer } from './flyers';

/** Owned by [enemies-waves]. Enemy spawning + AI.
 *  - Melee/boss: march down their spawn lane toward the outermost intact wall and batter it;
 *    divert to nearby field-level defender units (allies sortieing out).
 *  - Ranged: advance to a firing line a fixed standoff from the WALL, then shoot whatever
 *    defender is in bow range from there (arrows arc up to walls; projectiles ignore walls —
 *    accepted v1); with nothing to shoot, chip the wall. The standoff is deliberately measured
 *    from the wall rather than from the nearest defender — see stepRanged's standZ for why
 *    the latter made ranged attackers unanswerable by the entire defending army.
 *  - Flyers (isFlyerDef, any defId in data/enemies.ts's FLYER_AI — hot air balloon, dragon):
 *    ignore walls and the above entirely, dispatched to sim/flyers.ts's stepFlyer() instead.
 *    See that file's header for the full flight/attack model and design rationale.
 *  Sim-only: no rendering, no Math.random() (game.rng only). */

export interface SpawnMods {
  hpMult?: number;
  speedMult?: number;
  goldMult?: number;
}

/** Concrete enemy created by spawnEnemy. Everything in game.enemies is one of these;
 *  render code may read the extra fields (yaw etc.) but must never write them. */
export interface SimEnemy extends Enemy {
  def: EnemyDef;
  moveSpeed: number; // def.speed × wave speedMult × per-enemy jitter
  goldMult: number;
  laneX: number; // spawn x — kept as the marching lane / wall attack slot
  nextAttackAt: number; // game.time when the next unit-hit / arrow is allowed
  yaw: number; // facing (radians, atan2(dx, dz)); updated by movement
  /** Elite multiplier on everything this enemy DEALS — its melee hit and its wall chipping (1 =
   *  ordinary). Kept per-enemy rather than as a separate elite EnemyDef so an elite is genuinely
   *  the same creature, just a far more dangerous one, and so any future enemy type can be
   *  promoted without authoring a parallel def. See ELITE in data/enemies.ts. */
  powerMult: number;
  /** Render-only size tell for elites, read by render/enemyView.ts through a narrow cast. An
   *  enemy that takes three times the killing has to look like it will. */
  eliteScale: number;
}

/** An explicit slot in a marching formation, replacing the default random lane + spawn line.
 *  `speed` is the column's shared march pace: every member of a column moves at the same speed or
 *  the ranks invert within seconds (see FORMATION in data/enemies.ts), which also means the usual
 *  per-enemy speed jitter is deliberately skipped for formed-up troops — jitter is what smears a
 *  formation back into a crowd. Flyers pass no placement and keep the old scattered behaviour;
 *  they are airborne and a ground formation means nothing to them. */
export interface SpawnPlacement {
  x: number;
  z: number;
  speed: number;
}

export function spawnEnemy(
  game: GameState,
  defId: string,
  mods?: SpawnMods,
  placement?: SpawnPlacement,
  elite = false
): Enemy | null {
  const def = getEnemyDef(defId);
  const hpMult = mods?.hpMult ?? 1;
  const speedMult = mods?.speedMult ?? 1;
  const goldMult = mods?.goldMult ?? 1;

  const spawnX = placement ? placement.x : game.rng.range(-ENEMY_AI.spawnXRange, ENEMY_AI.spawnXRange);
  const spawnZ = placement ? placement.z : ENEMY_SPAWN_Z;
  const jitter = placement ? 1 : game.rng.range(ENEMY_AI.speedJitterMin, ENEMY_AI.speedJitterMax);
  const baseSpeed = placement ? placement.speed : def.speed;
  const hp = Math.round(def.hp * hpMult);

  const e: SimEnemy = {
    id: allocId(),
    team: 'attacker',
    defId,
    def,
    pos: new Vector3(spawnX, 0, spawnZ),
    radius: def.radius,
    height: def.height,
    hp,
    maxHp: hp,
    alive: true,
    moveSpeed: baseSpeed * speedMult * jitter,
    goldMult,
    laneX: spawnX,
    // small stagger so simultaneous spawns don't attack/shoot in lockstep
    nextAttackAt: game.time + game.rng.range(0, def.attackInterval * 0.5),
    yaw: 0,
    powerMult: elite ? ELITE.powerMult : 1,
    eliteScale: elite ? ELITE.scale : 1,
    takeDamage(amount: number, g: GameState): void {
      if (!e.alive) return;
      // ability-clarity task (2026-08-27): record every hit for floating combat text before
      // mutating hp, using the isVulnerable status read from sim/abilityEffects.ts — this is
      // what lets a marked (Curse of Agony etc.) enemy's numbers visibly run hotter/bigger than
      // an unmarked one's, without this closure needing to know which ability caused the hit.
      // See sim/damageEvents.ts for how the single call below fans out into hit/dot/kill
      // categories and stays bounded under an 80-enemy load.
      const amplified = isVulnerable(e, g);
      e.hp -= amount;
      const dying = e.hp <= 0;
      recordEnemyDamage(g, e.id, e.pos.x, e.pos.y + e.height * 0.85, e.pos.z, amount, amplified, dying);
      if (!dying) return;
      e.hp = 0;
      e.alive = false;
      g.kills++;
      const gold = Math.round(def.gold * e.goldMult);
      g.addGold(gold);
      g.events.emit('enemy:killed', { defId, pos: e.pos.clone(), gold });
    },
  };

  game.enemies.push(e);
  game.events.emit('enemy:spawned', { defId });
  return e;
}

// ---------- AI internals ----------

interface TrackedVel {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

const arrowOrigin = new Vector3();
const arrowVel = new Vector3();

/** Movement multiplier from every active debuff. Delegates to sim/status.ts so slow and stun
 *  stacking behave identically here, in ally AI, and in anything added later. */
function slowMult(e: SimEnemy, game: GameState): number {
  return moveMultiplier(e, game);
}

function distXZ(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function moveToward(e: SimEnemy, tx: number, tz: number, speed: number, dt: number): void {
  const dx = tx - e.pos.x;
  const dz = tz - e.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-4) return;
  const step = Math.min(speed * dt, d);
  e.pos.x += (dx / d) * step;
  e.pos.z += (dz / d) * step;
  e.yaw = Math.atan2(dx, dz);
}

function faceToward(e: SimEnemy, p: Vector3): void {
  const dx = p.x - e.pos.x;
  const dz = p.z - e.pos.z;
  if (dx * dx + dz * dz > 1e-6) e.yaw = Math.atan2(dx, dz);
}

function laneSlotX(e: SimEnemy): number {
  const max = WALL_HALF_WIDTH - e.radius;
  return Math.min(Math.max(e.laneX, -max), max);
}

function tryHitUnit(e: SimEnemy, target: Unit, game: GameState): void {
  if (game.time < e.nextAttackAt) return;
  e.nextAttackAt = game.time + e.def.attackInterval;
  target.takeDamage(e.def.unitDamage * e.powerMult, game);
}

function shootArrow(e: SimEnemy, target: Unit, vel: TrackedVel | undefined, game: GameState): void {
  if (game.time < e.nextAttackAt) return;
  e.nextAttackAt = game.time + e.def.attackInterval;
  arrowOrigin.set(e.pos.x, e.pos.y + e.height * 0.6, e.pos.z);
  const aimY = target.pos.y + target.height * 0.5;
  // simple linear lead: predict where the target will be after the flight time
  const flight = Math.min(
    Math.sqrt(
      (target.pos.x - arrowOrigin.x) ** 2 +
        (aimY - arrowOrigin.y) ** 2 +
        (target.pos.z - arrowOrigin.z) ** 2,
    ) / ENEMY_AI.arrowSpeed,
    ENEMY_AI.arrowMaxLeadTime,
  );
  const ax = target.pos.x + (vel?.vx ?? 0) * flight;
  const az = target.pos.z + (vel?.vz ?? 0) * flight;
  arrowVel.set(ax - arrowOrigin.x, aimY - arrowOrigin.y, az - arrowOrigin.z);
  if (arrowVel.lengthSq() < 1e-6) return;
  arrowVel.normalize().multiplyScalar(ENEMY_AI.arrowSpeed);
  game.projectiles.spawn({
    pos: arrowOrigin,
    vel: arrowVel,
    team: 'attacker',
    damage: e.def.unitDamage,
    radius: ENEMY_AI.arrowRadius,
    kind: 'arrow',
  });
}

function stepMelee(e: SimEnemy, dt: number, game: GameState, wall: Wall | null, defenders: Unit[]): void {
  const speed = e.moveSpeed * slowMult(e, game);

  // Divert to a nearby reachable defender unit (on the field, not up on a wall)
  let target: Unit | null = null;
  let bestD = ENEMY_AI.aggroRange;
  for (const u of defenders) {
    if (Math.abs(u.pos.y - e.pos.y) >= ENEMY_AI.aggroMaxDy) continue;
    const d = distXZ(e.pos, u.pos);
    if (d < bestD) {
      bestD = d;
      target = u;
    }
  }
  if (target) {
    faceToward(e, target.pos);
    if (bestD > e.def.range + target.radius) {
      moveToward(e, target.pos.x, target.pos.z, speed, dt);
    } else {
      tryHitUnit(e, target, game);
    }
    return;
  }

  if (!wall) return; // keep is down — castle module handles game over; just stand
  const stopZ = wall.z - e.radius - ENEMY_AI.wallStopGap;
  if (e.pos.z < stopZ - 0.05) {
    moveToward(e, laneSlotX(e), stopZ, speed, dt);
  } else {
    e.yaw = 0; // face the wall
    game.castle.damageWall(wall.tier, e.def.wallDps * e.powerMult * dt, game);
  }
}

function stepRanged(
  e: SimEnemy,
  dt: number,
  game: GameState,
  wall: Wall | null,
  defenders: Unit[],
  vels: Map<number, TrackedVel>,
): void {
  const speed = e.moveSpeed * slowMult(e, game);
  const barrierZ = wall ? wall.z - e.radius - ENEMY_AI.wallStopGap : Infinity;

  // Prefer any shootable defender unit (any height — arrows arc up to walls)
  let target: Unit | null = null;
  let bestD = Infinity;
  for (const u of defenders) {
    const d = distXZ(e.pos, u.pos);
    if (d < bestD) {
      bestD = d;
      target = u;
    }
  }

  // The firing line: how far back a ranged attacker is willing to stand. Measured from the WALL,
  // its actual objective — never from whichever defender happens to be closest.
  //
  // This clamp is the whole reason ranged enemies are answerable. Without it, an archer stopped
  // the instant ANY defender came within its own 22-unit range, and since it measures that from
  // the frontmost ally (the tank line, 8.5 out from the wall) it parked ~30 from the wall. Every
  // defending rank sits behind that tank: swordsman posts ended up 24.5 away against an aggro
  // range of 24, ally archers 27.5 away against a reach of 20. So the entire army was out of
  // range by construction — melee stood and took arrows without ever acquiring, and the archers
  // who were supposed to answer could not. Holding the same standoff in both branches means a
  // ranged attacker always closes into the defending line's engagement envelope.
  const standZ = wall ? Math.min(barrierZ, wall.z - e.def.range + ENEMY_AI.archerStandback) : -Infinity;

  if (target) {
    faceToward(e, target.pos);
    if (bestD <= e.def.range && e.pos.z >= standZ - 0.05) {
      shootArrow(e, target, vels.get(target.id), game);
      return;
    }
    if (e.pos.z < barrierZ - 0.05) {
      moveToward(e, target.pos.x, Math.min(target.pos.z, barrierZ), speed, dt);
      return;
    }
    // pinned at the wall with the target still out of range — chip the wall instead
    if (wall) game.castle.damageWall(wall.tier, e.def.wallDps * e.powerMult * dt, game);
    return;
  }

  if (!wall) return;
  if (e.pos.z < standZ - 0.05) {
    moveToward(e, laneSlotX(e), standZ, speed, dt);
  } else {
    e.yaw = 0;
    game.castle.damageWall(wall.tier, e.def.wallDps * e.powerMult * dt, game);
  }
}

/** Gentle pairwise push-apart so enemies don't stack (single pass, positional). Flyers are
 *  excluded on either side of the pair — there's no 3D separation model here, and an airborne
 *  flyer overlapping a ground unit's XZ footprint isn't actually touching it (see sim/flyers.ts). */
function separate(list: SimEnemy[]): void {
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    if (!a.alive || isFlyerDef(a.defId)) continue;
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      if (!b.alive || isFlyerDef(b.defId)) continue;
      let dx = b.pos.x - a.pos.x;
      let dz = b.pos.z - a.pos.z;
      const minD = a.radius + b.radius;
      if (dx > minD || dx < -minD || dz > minD || dz < -minD) continue; // cheap reject
      let d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      if (d2 < 1e-6) {
        // perfectly stacked: deterministic nudge from ids
        dx = a.id % 2 === 0 ? 0.01 : -0.01;
        dz = b.id % 2 === 0 ? 0.01 : -0.01;
        d2 = dx * dx + dz * dz;
      }
      const d = Math.sqrt(d2);
      const push = (minD - d) * 0.5 * ENEMY_AI.separationFactor;
      const px = (dx / d) * push;
      const pz = (dz / d) * push;
      a.pos.x -= px;
      a.pos.z -= pz;
      b.pos.x += px;
      b.pos.z += pz;
    }
  }
}

export function initEnemies(game: GameState): void {
  // Defender velocity tracker (for archer lead) — sim-local, rebuilt every tick
  const vels = new Map<number, TrackedVel>();
  const seen = new Set<number>();

  game.addSystem({
    tick(dt) {
      // cull the dead every tick, in every phase
      if (game.enemies.some((e) => !e.alive)) {
        game.enemies = game.enemies.filter((e) => e.alive);
      }
      if (game.phase !== 'combat') return;

      const defenders = game.unitsOfTeam('defender');

      // update defender velocities
      seen.clear();
      for (const u of defenders) {
        seen.add(u.id);
        const t = vels.get(u.id);
        if (t) {
          t.vx = (u.pos.x - t.x) / dt;
          t.vz = (u.pos.z - t.z) / dt;
          t.x = u.pos.x;
          t.z = u.pos.z;
        } else {
          vels.set(u.id, { x: u.pos.x, z: u.pos.z, vx: 0, vz: 0 });
        }
      }
      for (const id of vels.keys()) if (!seen.has(id)) vels.delete(id);

      const wall = game.castle.outermostIntactWall();
      const list = game.enemies as SimEnemy[];
      for (const e of list) {
        // Stunned enemies do nothing at all — no marching, no attacks, no wall damage. Flyers
        // included: a stunned flyer just hovers in place (see sim/flyers.ts's file header).
        if (isStunned(e, game)) continue;
        if (isFlyerDef(e.defId)) stepFlyer(e, dt, game);
        else if (e.def.behavior === 'ranged') stepRanged(e, dt, game, wall, defenders, vels);
        else stepMelee(e, dt, game, wall, defenders);
      }

      separate(list);

      // final clamps + walk on the terrain height (0 on field, crosses rubble) — ground-walkers
      // only. Flyers own their entire position update inside stepFlyer and must never be
      // snapped to worldHeight (the walking-unit ground clamp) or stopped short of the wall face.
      for (const e of list) {
        if (isFlyerDef(e.defId)) continue;
        e.pos.x = Math.min(Math.max(e.pos.x, FIELD_MIN_X + e.radius), FIELD_MAX_X - e.radius);
        e.pos.z = Math.max(e.pos.z, ENEMY_SPAWN_Z - 2);
        if (wall) e.pos.z = Math.min(e.pos.z, wall.z - e.radius - ENEMY_AI.wallStopGap);
        e.pos.y = game.castle.worldHeight(e.pos.x, e.pos.z);
      }
    },
  });
}
