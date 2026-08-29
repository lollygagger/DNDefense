import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { Enemy, PlayerClassDef, PlayerState } from '../sim/types';
import type { AbilityWithTree } from '../sim/abilityTree';
import { applyDamageReduction } from '../sim/classes';
import { applyStun } from '../sim/status';
import { dashPlayer } from '../player/controller';
import { actionState } from '../player/actionState';
import { applyShield, applyThorns, startDamageSweep, stopDamageSweep } from '../sim/abilityEffects';
import { bulwarkTree, shieldBashTree, shieldChargeTree, shieldSlamTree } from './tankTree';

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
 *  downside — their late-game Mastery branches (data/tankTree.ts) add self-sustain instead of
 *  CC, keeping that rule intact all the way to the deepest upgrades. cast() implementations are
 *  sim-side only: they scan game.enemies / mutate state, no rendering. */

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
const shieldBash: AbilityWithTree = {
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
    // Ranks V-X: the Tank's basic attack was the only primary that stopped at four ranks, which
    // is exactly why it felt like a chip-damage button forever. It now scales like the rest —
    // still the shortest reach of the melee primaries, since its job is holding ground rather
    // than clearing it, but no longer irrelevant once the waves get big.
    { cost: 220, stats: { damage: 38, range: 4.2, arcDeg: 90 } },
    { cost: 600, stats: { damage: 54, range: 4.6 } },
    { cost: 1500, stats: { damage: 78, range: 5 } },
    { cost: 3500, stats: { damage: 112, range: 5.5 } },
    { cost: 7500, stats: { damage: 162, range: 6, arcDeg: 120 } },
    { cost: 16000, stats: { damage: 235, range: 6.5, arcDeg: 360 } },
  ],
  tree: shieldBashTree,
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
    let hits = 0;
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
      hits++;
    }
    if (hits > 0) {
      // Riposte/Perfect Riposte: stacking self-mitigation scaled by how many you hit at once.
      if (stats.reductionPerHitPct) {
        const factor = Math.max(0.4, 1 - (stats.reductionPerHitPct * hits) / 100);
        applyDamageReduction(caster, game, factor, stats.reductionDuration);
      }
      // Vanguard's Resolve/Fortitude: sustain via healing instead of mitigation.
      if (stats.healPerHit) caster.hp = Math.min(caster.maxHp, caster.hp + stats.healPerHit * hits);
    }
    const fx = origin.x + dx * Math.min(stats.range, 2.2);
    const fz = origin.z + dz * Math.min(stats.range, 2.2);
    game.projectiles.impacts.push({ pos: new Vector3(fx, caster.pos.y + 1, fz), kind: 'slash', aoe: false });
  },
};

/** The CC centerpiece: a ground-target shockwave that damages and stuns everything in radius.
 *  Long cooldown relative to its own stun duration on purpose (see the module doc comment) —
 *  this is the "stop a cluster for a couple of seconds" button, not an on-demand lock. */
const shieldSlam: AbilityWithTree = {
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
    // Deep ranks: a slam wide enough to stun a whole arriving rank, not just the ones on top of you.
    { cost: 400, stats: { damage: 105, radius: 5 } },
    { cost: 1000, stats: { damage: 150, radius: 6, stunDuration: 2.4 } },
    { cost: 2500, stats: { damage: 215, radius: 7.2, focusBonusDamage: 120 } },
    { cost: 6000, stats: { damage: 310, radius: 8.5, stunDuration: 3, focusBonusDamage: 220 } },
  ],
  tree: shieldSlamTree,
  cast(game: GameState, _caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const radiusSq = stats.radius * stats.radius;
    const hits: Enemy[] = [];
    let closest: Enemy | null = null;
    let closestSq = Infinity;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - aimPoint.x;
      const dz = e.pos.z - aimPoint.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > radiusSq) continue;
      hits.push(e);
      if (d2 < closestSq) {
        closestSq = d2;
        closest = e;
      }
    }
    // Concussive/Shattering Slam: stun scales with how many enemies the blast actually caught.
    const bonusStun = stats.stunPerTarget
      ? Math.min(stats.stunCap, stats.stunDuration + stats.stunPerTarget * (hits.length - 1))
      : stats.stunDuration;
    for (const e of hits) {
      let dmg = stats.damage;
      let stun = bonusStun;
      // Focused/Executioner's Slam: the single closest target eats a big bonus on top.
      if (stats.focusBonusDamage && e === closest) {
        dmg += stats.focusBonusDamage;
        stun += stats.focusStunBonus;
      }
      e.takeDamage(dmg, game);
      stunWithFatigue(e, game, stun);
    }
    // Reuses Ground Slam's earthy-shockwave look — the closest fit in the frozen fx.ts kind
    // table for "a shield slammed into the ground" — at this ability's own real radius/duration.
    game.projectiles.impacts.push({
      pos: aimPoint.clone(),
      kind: 'slam',
      aoe: true,
      radius: stats.radius,
      duration: bonusStun,
    });
  },
};

/** Pure survivability: no damage, no CC, just a hard damage-reduction window via
 *  sim/classes.ts's generic applyDamageReduction (any class could use it — it just happens
 *  that only the Tank does today). Differentiates from the Warrior's Second Wind: this
 *  mitigates the next few seconds of incoming damage instead of restoring HP already lost. */
const bulwark: AbilityWithTree = {
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
    // Deep ranks: reduction alone has a ceiling (you cannot go past 100%), so these add an
    // absorb shield on top of it and eventually make standing in the middle of a swarm hurt it.
    { cost: 400, stats: { reductionPct: 78, duration: 7, shieldAmount: 120, shieldDuration: 6 } },
    { cost: 1000, stats: { reductionPct: 84, duration: 8, shieldAmount: 220 } },
    { cost: 2500, stats: { reductionPct: 89, duration: 9, shieldAmount: 360, thornsDamage: 60, thornsRadius: 5 } },
    { cost: 6000, stats: { reductionPct: 93, duration: 11, shieldAmount: 560, thornsDamage: 120, thornsRadius: 6.5 } },
  ],
  tree: bulwarkTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, _aimPoint: Vector3, stats: Record<string, number>) {
    applyDamageReduction(caster, game, 1 - stats.reductionPct / 100, stats.duration);
    // Aegis/Bastion Overflow: a flat absorb shield on top of the percentage reduction.
    if (stats.shieldAmount) applyShield(caster, game, stats.shieldAmount, stats.shieldDuration);
    // Retaliation/Vengeful Retaliation: punish anyone still hitting you through the mitigation.
    if (stats.thornsRadius) applyThorns(caster, game, stats.thornsRadius, stats.thornsDamage, stats.duration);
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'bulwark', aoe: false });
  },
};

/** Mobility: an instant, directional shoulder charge — no reticle, no confirm click, same input
 *  shape as the Warrior's Leap (role: 'mobility' + targeting: 'aimed', so casting.ts fires it
 *  immediately on keypress).
 *
 *  Explicitly NOT a jump. This used to be a ballistic arc like Leap, which meant the Tank sailed
 *  upward every time it charged — wrong for a shoulder-barge, and it made the two classes' mobility
 *  feel like the same move. It now runs on dashPlayer(): a flat horizontal charge along the ground
 *  with no vertical impulse, hugging terrain (up ramps, off ledges) rather than flying over it.
 *  The Tank keeps its own identity — Leap goes OVER things, the Charge goes THROUGH them — and the
 *  cooldown came down to match, since a grounded reposition is a far smaller commitment than a leap.
 *  Still slams for damage and a (weaker, fatigue-tracked) stun when the charge ends — the Tank's
 *  second, smaller CC source. The controller owns gravity, collision and the playfield clamp, so
 *  this cast() only picks a direction. */
// The dash's own speed multiplier and duration. `stats.speed` was tuned as a LAUNCH speed (a
// value that only had to hold up for the airtime of an arc); a ground dash runs for a fixed
// window, so it gets its own multiplier rather than silently reinterpreting that number.
const CHARGE_DASH_SPEED_MULT = 2.6;
const CHARGE_DASH_TIME = 0.42; // seconds of charge — long enough to cross a melee line, short enough to feel like a barge
const shieldCharge: AbilityWithTree = {
  id: 'shieldCharge',
  name: 'Shield Charge',
  desc: 'Barrel forward behind your shield — no aiming, just charge — and flatten what you land on.',
  icon: '🐗',
  targeting: 'aimed',
  cooldown: 7, // shorter than the Warrior's Leap: a flat barge is a repositioning tool, not a leap
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { speed: 5.5, damage: 20, radius: 3, stunDuration: 0.8 } },
    { cost: 40, stats: { speed: 6.5, damage: 30 } },
    { cost: 80, stats: { speed: 7.5, damage: 42 } },
    { cost: 140, stats: { speed: 8.5, damage: 58, radius: 3.6, stunDuration: 1.2 } },
    // Deep ranks: the charge starts carving a path as it travels, not just where it stops.
    { cost: 400, stats: { damage: 90, radius: 4.2, speed: 9.2 } },
    { cost: 1000, stats: { damage: 130, radius: 5, stunDuration: 1.6, sweepDamage: 60, sweepRadius: 4 } },
    { cost: 2500, stats: { damage: 190, radius: 6, sweepDamage: 110, sweepRadius: 5.5, chargeReductionPct: 30, chargeReductionDuration: 4 } },
    { cost: 6000, stats: { damage: 280, radius: 7, stunDuration: 2.2, sweepDamage: 190, sweepRadius: 7, chargeReductionPct: 45 } },
  ],
  tree: shieldChargeTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, _aimPoint: Vector3, stats: Record<string, number>) {
    const dirX = -Math.sin(caster.yaw);
    const dirZ = -Math.cos(caster.yaw);

    actionState.leaping = true; // reuses the generic 'committed movement' viewmodel pose
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'leap', aoe: false });

    // Bulwark/Aegis Charge: safe to barge into danger — mitigation covers the whole flight.
    if (stats.chargeReductionPct) {
      applyDamageReduction(caster, game, 1 - stats.chargeReductionPct / 100, stats.chargeReductionDuration);
    }
    // Juggernaut/Rampage: damages everything the charge passes over, not just the landing.
    if (stats.sweepRadius) startDamageSweep(caster, stats.sweepRadius, stats.sweepDamage);

    // A flat charge, not a jump: dashPlayer holds a horizontal velocity for a fixed duration and
    // leaves gravity/ground-clamping untouched, so the Tank barges along the ground (riding stair
    // ramps, dropping off ledges) instead of arcing over things. launchPlayer can't express this —
    // with no vertical impulse its landing check fires on the very next tick.
    dashPlayer(dirX, dirZ, stats.speed * CHARGE_DASH_SPEED_MULT, CHARGE_DASH_TIME, () => {
      actionState.leaping = false;
      if (stats.sweepRadius) stopDamageSweep(caster);
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
