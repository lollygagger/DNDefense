import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { AbilityDef, Enemy, PlayerClassDef, PlayerState } from '../sim/types';
import { applyDamageReduction } from '../sim/classes';
import { applyStun } from '../sim/status';
import { launchPlayer } from '../player/controller';
import { actionState } from '../player/actionState';

/** Tank class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  Identity: the highest HP in the game and the slowest boots, built to *stop* a swarm rather
 *  than kill or delete it — where the Warrior kills and the Mage deletes groups with raw
 *  damage, the Tank buys time and space. Only ONE ability (Shield Slam) is a real stun, its
 *  cooldown is long relative to its own duration (~22% uptime on a single target if spammed
 *  at max rank), and the mobility charge adds a second, weaker stun source on an equally long
 *  cooldown. The shared stunWithFatigue() helper below makes repeat stuns on the *same* enemy
 *  from *either* source progressively shorter within a rolling window, so a player who
 *  deliberately chains both cooldowns onto one target (e.g. a boss) still can't lock it down
 *  forever — see its doc comment for the exact mechanic. The primary and Bulwark deal zero
 *  crowd control on purpose: a class this tanky must not also be the best CC engine with no
 *  downside. cast() implementations are sim-side only: they scan game.enemies / mutate state,
 *  no rendering. */

// ---------- shared diminishing-returns stun helper ----------

const STUN_FATIGUE_WINDOW = 6; // seconds since the last Tank-caused stun before fatigue resets
const STUN_FATIGUE_DECAY = 0.5; // each repeat stun inside the window is half as long as the last
const STUN_FATIGUE_FLOOR = 0.35; // never shorter than this — still a real, noticeable flinch

// WeakMap keyed by the Enemy object itself: no manual cleanup needed anywhere — an entry falls
// out of memory naturally once the enemy is dead and dropped, same reasoning as sim/classes.ts's
// damageReduction map.
const stunFatigue = new WeakMap<Enemy, { resetAt: number; nextFactor: number }>();

/** Apply a stun to `e` with diminishing duration if a Tank ability already stunned it recently.
 *  The first stun inside a rolling STUN_FATIGUE_WINDOW is full strength; every repeat within
 *  that window (from Shield Slam, Shield Charge, or a future Tank ability — the fatigue is
 *  per-target, not per-ability) is halved from the last, floored at STUN_FATIGUE_FLOOR, and
 *  landing one always refreshes the window. A target left alone for the full window is treated
 *  as fresh again. This is the mechanism that makes "permanent lockdown" impossible even for a
 *  player deliberately focusing one enemy with everything on cooldown. */
function stunWithFatigue(e: Enemy, game: GameState, baseDuration: number): void {
  const mem = stunFatigue.get(e);
  let duration = baseDuration;
  let nextFactor = STUN_FATIGUE_DECAY;
  if (mem && game.time < mem.resetAt) {
    duration = Math.max(STUN_FATIGUE_FLOOR, baseDuration * mem.nextFactor);
    nextFactor = mem.nextFactor * STUN_FATIGUE_DECAY;
  }
  stunFatigue.set(e, { resetAt: game.time + STUN_FATIGUE_WINDOW, nextFactor });
  applyStun(e, game, duration);
}

/** Melee "aimed" primary: cone scan in front of the caster, same generic pattern as the
 *  Warrior's Cleave — but narrower, shorter, slower, and noticeably weaker, since the Tank's
 *  primary is a chip-damage poke, not a damage identity. */
const shieldBash: AbilityDef = {
  id: 'shieldBash',
  name: 'Shield Bash',
  desc: 'A quick bash with your shield. Modest damage — your real tools are the ones on cooldown.',
  icon: '🛡️',
  targeting: 'aimed',
  cooldown: 0.6,
  ranks: [
    { cost: 0, stats: { damage: 10, range: 3, arcDeg: 70 } },
    { cost: 40, stats: { damage: 15, range: 3.3 } },
    { cost: 80, stats: { damage: 21, range: 3.6 } },
    { cost: 140, stats: { damage: 28, range: 3.9 } },
  ],
  cast(game: GameState, caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    let dx = aimPoint.x - origin.x;
    let dz = aimPoint.z - origin.z;
    const dlen = Math.hypot(dx, dz);
    if (dlen < 1e-4) {
      dx = 0;
      dz = -1;
    } else {
      dx /= dlen;
      dz /= dlen;
    }
    const cosHalfArc = Math.cos((stats.arcDeg * Math.PI) / 360);
    const rangeSq = stats.range * stats.range;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const ex = e.pos.x - origin.x;
      const ez = e.pos.z - origin.z;
      const distSq = ex * ex + ez * ez;
      if (distSq > rangeSq) continue;
      if (Math.abs(caster.pos.y - e.pos.y) > 3) continue;
      const dist = Math.sqrt(distSq);
      const within = dist < 1e-4 || (ex * dx + ez * dz) / dist >= cosHalfArc;
      if (!within) continue;
      e.takeDamage(stats.damage, game);
    }
    const fx = origin.x + dx * Math.min(stats.range, 2.2);
    const fz = origin.z + dz * Math.min(stats.range, 2.2);
    game.projectiles.impacts.push({ pos: new Vector3(fx, caster.pos.y + 1, fz), kind: 'slash', aoe: false });
  },
};

/** The CC centerpiece: a ground-target shockwave that damages and stuns everything in radius.
 *  Long cooldown relative to its own stun duration on purpose (see the module doc comment) —
 *  this is the "stop a cluster for a couple of seconds" button, not an on-demand lock. */
const shieldSlam: AbilityDef = {
  id: 'shieldSlam',
  name: 'Shield Slam',
  desc: 'Slam your shield into the ground, damaging and stunning everything nearby.',
  icon: '🔨',
  targeting: 'ground',
  cooldown: 9,
  castRange: 6,
  ranks: [
    { cost: 0, stats: { damage: 25, radius: 3.5, stunDuration: 1.0 } },
    { cost: 40, stats: { damage: 38, stunDuration: 1.3 } },
    { cost: 80, stats: { damage: 52, stunDuration: 1.6 } },
    { cost: 140, stats: { damage: 70, radius: 4.2, stunDuration: 2.0 } },
  ],
  cast(game: GameState, _caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - aimPoint.x;
      const dz = e.pos.z - aimPoint.z;
      if (dx * dx + dz * dz > stats.radius * stats.radius) continue;
      e.takeDamage(stats.damage, game);
      stunWithFatigue(e, game, stats.stunDuration);
    }
    // Reuses Ground Slam's earthy-shockwave look — the closest fit in the frozen fx.ts kind
    // table for "a shield slammed into the ground" — at this ability's own real radius/duration.
    game.projectiles.impacts.push({
      pos: aimPoint.clone(),
      kind: 'slam',
      aoe: true,
      radius: stats.radius,
      duration: stats.stunDuration,
    });
  },
};

/** Pure survivability: no damage, no CC, just a hard damage-reduction window via
 *  sim/classes.ts's generic applyDamageReduction (any class could use it — it just happens
 *  that only the Tank does today). Differentiates from the Warrior's Second Wind: this
 *  mitigates the next few seconds of incoming damage instead of restoring HP already lost. */
const bulwark: AbilityDef = {
  id: 'bulwark',
  name: 'Bulwark',
  desc: 'Brace behind your shield, sharply reducing incoming damage for a few seconds.',
  icon: '🔰',
  targeting: 'aimed', // instant, self-targeted — aimPoint is ignored, same trick as Second Wind
  cooldown: 18,
  ranks: [
    { cost: 0, stats: { reductionPct: 40, duration: 4 } },
    { cost: 40, stats: { reductionPct: 50, duration: 4.5 } },
    { cost: 80, stats: { reductionPct: 60, duration: 5 } },
    { cost: 140, stats: { reductionPct: 70, duration: 6 } },
  ],
  cast(game: GameState, caster: PlayerState, _origin: Vector3, _aimPoint: Vector3, stats: Record<string, number>) {
    applyDamageReduction(caster, game, 1 - stats.reductionPct / 100, stats.duration);
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'bulwark', aoe: false });
  },
};

/** Mobility: an instant, directional shoulder charge — no reticle, no confirm click, same
 *  input shape as the Warrior's Leap (role: 'mobility' + targeting: 'aimed' so casting.ts
 *  fires it immediately on keypress). Built on the same launchPlayer() ballistic arc for the
 *  same reason Leap is: the controller owns gravity/ground-collision/the playfield clamp, so
 *  this cast() only ever has to pick a direction and a speed pair. A lower, flatter arc than
 *  Leap's (CHARGE_VSPEED=16 vs Leap's 18) reads as a barge rather than a jump, while still
 *  comfortably clearing the 6-unit wall: apex = 16^2/(2*14) ≈ 9.1. Slams down for damage AND
 *  a (weaker, fatigue-tracked) stun the instant it actually lands — the Tank's second, smaller
 *  CC source. */
const CHARGE_VSPEED = 16;
const shieldCharge: AbilityDef = {
  id: 'shieldCharge',
  name: 'Shield Charge',
  desc: 'Barrel forward behind your shield — no aiming, just charge — and flatten what you land on.',
  icon: '🐗',
  targeting: 'aimed',
  cooldown: 11,
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { speed: 5.5, damage: 20, radius: 3, stunDuration: 0.8 } },
    { cost: 40, stats: { speed: 6.5, damage: 30 } },
    { cost: 80, stats: { speed: 7.5, damage: 42 } },
    { cost: 140, stats: { speed: 8.5, damage: 58, radius: 3.6, stunDuration: 1.2 } },
  ],
  cast(game: GameState, caster: PlayerState, _origin: Vector3, _aimPoint: Vector3, stats: Record<string, number>) {
    const dirX = -Math.sin(caster.yaw);
    const dirZ = -Math.cos(caster.yaw);

    actionState.leaping = true; // reuses the generic airborne viewmodel pose, same as Leap
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'leap', aoe: false });

    launchPlayer(dirX, dirZ, stats.speed, CHARGE_VSPEED, () => {
      actionState.leaping = false;
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - caster.pos.x;
        const dz = e.pos.z - caster.pos.z;
        if (dx * dx + dz * dz <= stats.radius * stats.radius) {
          e.takeDamage(stats.damage, game);
          stunWithFatigue(e, game, stats.stunDuration);
        }
      }
      game.projectiles.impacts.push({
        pos: caster.pos.clone(),
        kind: 'leap',
        aoe: true,
        radius: stats.radius,
        duration: stats.stunDuration,
      });
    });
  },
};

export const TANK: PlayerClassDef = {
  id: 'tank',
  name: 'Tank',
  desc: 'The bulwark of the wall: the most HP in the game, the slowest boots, and a shield full of stuns to lock a swarm down while your allies clean up.',
  maxHp: 220,
  moveSpeed: 4.8,
  primary: shieldBash,
  abilities: [shieldSlam, bulwark, shieldCharge],
};
