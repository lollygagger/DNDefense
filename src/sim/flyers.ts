import { Vector3 } from 'three';
import type { GameState } from './GameState';
import type { SimEnemy } from './enemies';
import { FLYER_AI } from '../data/enemies';
import { FIELD_MAX_X, FIELD_MIN_X, WALL_THICKNESS } from '../data/castle';
import { moveMultiplier } from './status';

/** Owned by [enemies-waves]. Flying-enemy AI (hot air balloon, dragon — docs/ROADMAP.md Phase
 *  1's "flying enemy support"). Split out of sim/enemies.ts to keep that file under the
 *  ~400-line budget (ARCHITECTURE.md: "split rather than grow").
 *
 *  WHAT THEY ATTACK, AND WHY. Flyers ignore walls and the melee/ranged march-and-batter AI
 *  entirely — sim/enemies.ts's tick loop dispatches any defId present in FLYER_AI here instead
 *  of stepMelee/stepRanged. Every attackInterval a flyer hits every defender (player + allies)
 *  within `range` of its current ground-projected position with `unitDamage`, AND chips
 *  whatever wall's z-footprint it happens to be over with a flat `wallDps` burst (see
 *  data/enemies.ts's doc comment on that field's reused meaning for flyers). That means a flyer
 *  is a threat for the entire time it's inbound, not just once it "arrives" somewhere: crossing
 *  each wall in turn is itself the danger — siege pressure that can't be blocked by turtling
 *  behind an intact lower tier the way ground sieges can, plus unit damage to anyone standing
 *  under its current position. This was the deliberate choice over "descend to attack one
 *  target" or "drop something and leave": it keeps every wall (not just the outermost) exposed
 *  to a real siege vector once flyers are in the mix, without ever bypassing the whole castle to
 *  instant-hit the keep the way a "fly straight to the keep and melee it" design would.
 *
 *  THE TWO ENEMIES CREATE DIFFERENT PRESSURE. The hot air balloon (diveDepth 0, cruiseAltitude
 *  10 — permanently above MERLON_TOP 8.2) is never blocked by battlement geometry and never
 *  dodges: the only lever the player has is raw DPS before its bombs add up, i.e. "prioritize
 *  killing it." The dragon (diveDepth 3, cruising at 9.5 and diving to 6.5 once per
 *  attackInterval, patrolling x once parked via sweepAmplitude) sweeps its breath across a wide
 *  band of the wall and hits anyone standing there — the only way to avoid repeated ticks is to
 *  physically move off whatever stretch it's currently over, i.e. "reposition," which no amount
 *  of extra DPS substitutes for.
 *
 *  FLIGHT MODEL (deliberately not physics, matching the rest of the sim's "assign position
 *  directly" style — see stepMelee/moveToward in sim/enemies.ts for the ground equivalent):
 *  each flyer advances toward FLYER_AI[id].holdZ at moveSpeed (still subject to slows/stuns via
 *  moveMultiplier, exactly like every other enemy), holding a fixed or oscillating world-space y
 *  that is NEVER sampled from game.castle.worldHeight — that query is the ground clamp for
 *  walking units and would yank a flyer down to 0 (or wall-top height) the instant it ran.
 *  sim/enemies.ts's tick loop skips flyers entirely in that final ground-clamp block.
 *
 *  NEVER UNREACHABLE / ALWAYS KILLABLE. Once at holdZ a flyer parks (or, if sweepAmplitude > 0,
 *  patrols x in a bounded sine sweep) — so it can never wander past FIELD_MIN_X/MAX_X or beyond
 *  holdZ. At every moment it is in exactly one of two states, "still approaching down its spawn
 *  lane" or "holding/patrolling at a fixed, in-bounds spot" — both always inside the box the
 *  player can walk right up to (see MAX_Z in player/controller.ts, well past holdZ) and shoot at
 *  directly with an aimed attack, even if every structure in the game were destroyed. It also
 *  never becomes invulnerable or untargetable: takeDamage is the same generic closure every
 *  enemy gets from spawnEnemy(), so a flyer dies exactly like anything else and the existing
 *  `!game.enemies.some(e => e.alive)` wave-clear check in sim/waves.ts already accounts for it
 *  with zero changes needed there.
 *
 *  STUNS. sim/enemies.ts's tick loop skips isStunned() enemies before ever calling stepFlyer,
 *  exactly like every other enemy — a stunned flyer simply hovers (freezes in place, mid-air,
 *  attack timer included) rather than falling. That's the simplest choice, and the one
 *  consistent with how every other unit type treats a stun ("does nothing at all" per
 *  sim/status.ts's isStunned doc) — a falling/crashing stunned flyer would need real vertical
 *  physics this sim doesn't have anywhere else. */

/** Cosmetic-only lookup: which render/fx.ts impact kind each flyer's area attack should draw.
 *  Both entries are enemy-attack looks (dirty smoke/soot palette, never the player's clean
 *  orange/violet/icy-blue), kept data-driven here instead of an `if (defId === ...)` chain so a
 *  future flyer just needs a row. Anything absent falls back to 'fireball' (safe, if generic). */
const FLYER_ATTACK_FX: Record<string, string> = {
  hotAirBalloon: 'bombBlast',
  dragon: 'dragonBreath',
};

/** Seconds of visible fall a non-diving flyer's bomb prop gets before the real detonation.
 *  Purely a render cue (see spawnFallingBomb): the sim's actual damage/timing below is
 *  completely unaffected by this constant. A diving flyer (dragon) doesn't need one — the dive
 *  itself, synced to land exactly on the attack tick, is already the telegraph. */
const BOMB_LEAD_TIME = 0.8;

/** Drop a harmless, physics-driven bomb prop toward the ground under `e`, timed to land right
 *  as the real attack (still fired unconditionally, on schedule, by `attack()` below) resolves.
 *  This is a real `Projectile` (so it gets the existing instanced rendering + gravity/ground
 *  collision for free) but `damage: 0` / no `aoeRadius` means it can never affect sim outcomes —
 *  a stray unit collision can't even end it early, since `pierce` lets it fall straight through.
 *  Telegraphing *before* the hit is the point: a player who sees this falling has a beat to move
 *  before HP disappears, instead of only learning about the bomb after taking it. */
function spawnFallingBomb(e: SimEnemy, game: GameState): void {
  const groundY = game.castle.worldHeight(e.pos.x, e.pos.z);
  const dropHeight = Math.max(1, e.pos.y - groundY);
  // Zero initial vertical speed; solve gravity so a straight drop covers dropHeight in exactly
  // BOMB_LEAD_TIME seconds (h = 1/2 g t^2) so it visually lands right on the real detonation.
  const gravity = (2 * dropHeight) / (BOMB_LEAD_TIME * BOMB_LEAD_TIME);
  game.projectiles.spawn({
    pos: e.pos.clone(),
    vel: new Vector3(0, 0, 0),
    team: e.team,
    damage: 0,
    radius: 0.35,
    pierce: 8, // never lets an incidental unit overlap end the fall early
    gravity,
    ttl: BOMB_LEAD_TIME + 0.5,
    kind: 'bombFall',
  });
}

function attack(e: SimEnemy, dt: number, game: GameState): void {
  const ai = FLYER_AI[e.defId];

  // Telegraph the next hit before it lands, for flyers that hold a constant altitude (their
  // dive isn't already doing this job). Fires exactly once per attack cycle: `nextAttackAt`
  // already holds the real deadline (set below, on the actual attack tick), so watching the
  // countdown cross BOMB_LEAD_TIME needs no extra per-enemy state.
  if (ai.diveDepth === 0) {
    const timeToAttack = e.nextAttackAt - game.time;
    if (timeToAttack <= BOMB_LEAD_TIME && timeToAttack > BOMB_LEAD_TIME - dt) {
      spawnFallingBomb(e, game);
    }
  }

  if (game.time < e.nextAttackAt) return;
  e.nextAttackAt = game.time + e.def.attackInterval;

  const r2 = e.def.range * e.def.range;
  for (const u of game.unitsOfTeam('defender')) {
    const dx = u.pos.x - e.pos.x;
    const dz = u.pos.z - e.pos.z;
    if (dx * dx + dz * dz <= r2) u.takeDamage(e.def.unitDamage, game);
  }

  // Siege chip: whichever wall's z-span the flyer is currently over (if any) takes a flat
  // burst, bypassing the "batter the outermost wall's face" gate ground sieges are limited to.
  // damageWall() no-ops safely on a wall that isn't built or already at 0 HP.
  for (const w of game.castle.walls) {
    if (e.pos.z >= w.z && e.pos.z <= w.z + WALL_THICKNESS) {
      game.castle.damageWall(w.tier, e.def.wallDps, game);
      break;
    }
  }

  // Ground point directly beneath the flyer: where the burst/ring/beam actually draws, instead
  // of at e.pos (up at cruise/dive altitude, i.e. floating in the air where no defender stands).
  // The unit-damage check above is XZ-only by design (see file header), so this is a purely
  // cosmetic placement fix, not a hit-test change. `originY` (dragon only) is e.pos.y at the
  // exact instant of the attack tick — for the dragon that's always the dive's low point (see
  // stepFlyer), a real gameplay value, not a guess — so the fx layer can draw a beam connecting
  // the attacker's actual altitude to the point it hit, per render/fx.ts's Impact augmentation.
  const groundPos = e.pos.clone();
  groundPos.y = game.castle.worldHeight(e.pos.x, e.pos.z);
  const kind = FLYER_ATTACK_FX[e.defId] ?? 'fireball';
  game.projectiles.impacts.push({
    pos: groundPos,
    kind,
    aoe: true,
    radius: e.def.range,
    originY: ai.diveDepth > 0 ? e.pos.y : undefined,
  });
}

export function stepFlyer(e: SimEnemy, dt: number, game: GameState): void {
  const ai = FLYER_AI[e.defId];
  const speed = e.moveSpeed * moveMultiplier(e, game);
  const oldX = e.pos.x;
  const oldZ = e.pos.z;

  if (e.pos.z < ai.holdZ) {
    e.pos.z = Math.min(e.pos.z + speed * dt, ai.holdZ);
  } else if (ai.sweepAmplitude > 0) {
    // Bounded, time-driven patrol once parked — no RNG needed, so a pack of the same flyer
    // type doesn't fly in lockstep, phase-shifted by id instead.
    e.pos.x = Math.sin(game.time * 0.6 + e.id) * ai.sweepAmplitude;
  }
  e.pos.x = Math.min(Math.max(e.pos.x, FIELD_MIN_X + e.radius), FIELD_MAX_X - e.radius);

  if (ai.diveDepth > 0) {
    // Smooth dive-and-climb synced to its own attack cadence: the low point of every dive
    // lands exactly on an attack tick (phase 0 = just fired = top of the climb-out).
    const phase = ((game.time % e.def.attackInterval) / e.def.attackInterval) * Math.PI * 2;
    e.pos.y = ai.cruiseAltitude - ai.diveDepth * (0.5 - 0.5 * Math.cos(phase));
  } else {
    e.pos.y = ai.cruiseAltitude;
  }

  const dx = e.pos.x - oldX;
  const dz = e.pos.z - oldZ;
  if (dx * dx + dz * dz > 1e-6) e.yaw = Math.atan2(dx, dz);

  attack(e, dt, game);
}
