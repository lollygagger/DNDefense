import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { PlayerClassDef, PlayerState } from '../sim/types';
import type { AbilityWithTree } from '../sim/abilityTree';
import { applyDamageReduction } from '../sim/classes';
import { launchPlayer, playerMotion, slamDown } from '../player/controller';
import { actionState } from '../player/actionState';
import { applyStun } from '../sim/status';
import {
  applyBleed,
  applyEmpower,
  applyVulnerability,
  empowerMultiplier,
  vulnerabilityMultiplier,
} from '../sim/abilityEffects';
import { cleaveTree, groundSlamTree, leapTree, secondWindTree } from './warriorTree';

/** Warrior class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  Identity: sustained melee pressure and survivability — high HP, short reach, fast/cheap
 *  primary that can hit a whole cluster of enemies at once, a hybrid damage+stagger AoE for
 *  when you're surrounded, a self-heal to keep fighting instead of retreating, and a punchy
 *  short-cooldown leap to close the gap (or hop up a wall). cast() implementations are
 *  sim-side only: they scan game.enemies / mutate state, no rendering. Every ability also
 *  carries a late-game "Mastery" tree (data/warriorTree.ts) hanging off its linear ranks. */

/** Melee "aimed" primary: no projectile — scans a cone in front of the caster's feet and
 *  hits everything inside it directly, the same generic pattern frostField uses for a ground
 *  circle (scan game.enemies, call takeDamage()), just cone-shaped and centered on the caster
 *  instead of a ground point. Rewards standing in the middle of a pack. */
const cleave: AbilityWithTree = {
  id: 'cleave',
  name: 'Cleave',
  desc: 'A fast, wide sword swing. Hits every enemy in front of you.',
  icon: '⚔️',
  targeting: 'aimed',
  cooldown: 0.35,
  ranks: [
    { cost: 0, stats: { damage: 16, range: 4, arcDeg: 100 } },
    { cost: 40, stats: { damage: 24, range: 4.4 } },
    { cost: 80, stats: { damage: 34, range: 4.8 } },
    { cost: 140, stats: { damage: 46, range: 5.2 } },
    // Rank V (late-game gold sink, unlocks behaviour): "Whirlwind" — the arc opens all the way
    // to 360°, so Cleave now hits everything around you instead of just what's in front. Needs
    // zero new cast() logic: the existing cone-scan's dot-product check against cos(180°) = -1
    // is trivially true for every direction, so a full circle just falls out of the same math.
    // Pure damage, no CC, and still the fastest cooldown in the game (0.35s) — safe to make
    // omnidirectional because it was never a control ability.
    { cost: 220, stats: { damage: 58, range: 5.5, arcDeg: 360 } },
  ],
  tree: cleaveTree,
  cast(game: GameState, caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    // origin shares caster.pos's x/z (it's just the eye height above the feet), so it doubles
    // as both the cone apex and the direction source.
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
    const empower = empowerMultiplier(caster, game);
    let kills = 0;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const ex = e.pos.x - origin.x;
      const ez = e.pos.z - origin.z;
      const distSq = ex * ex + ez * ez;
      if (distSq > rangeSq) continue;
      if (Math.abs(caster.pos.y - e.pos.y) > 3) continue; // don't hit a different wall tier
      const dist = Math.sqrt(distSq);
      const within = dist < 1e-4 || (ex * dx + ez * dz) / dist >= cosHalfArc;
      if (!within) continue;
      const dmg = stats.damage * empower * vulnerabilityMultiplier(e, game);
      e.takeDamage(dmg, game);
      if (stats.bleedDps) applyBleed(e, game, stats.bleedDps, stats.bleedDuration, stats.bleedMaxStacks);
      if (!e.alive) kills++;
    }
    if (stats.killRefund && kills > 0) {
      // Momentum/Unstoppable: chain kills through a swarm to bring Cleave right back up.
      caster.cooldowns['cleave'] = Math.max(game.time, (caster.cooldowns['cleave'] ?? 0) - stats.killRefund * kills);
    }
    const fx = origin.x + dx * Math.min(stats.range, 2.5);
    const fz = origin.z + dz * Math.min(stats.range, 2.5);
    game.projectiles.impacts.push({ pos: new Vector3(fx, caster.pos.y + 1, fz), kind: 'slash', aoe: false });
  },
};

/** Ground-target damage + brief stagger. Short range on purpose — it's a shockwave stomped
 *  into the ground at your feet, not artillery. Hybrid damage/control like the mage's kit has
 *  (Fireball = damage, Frost Field = control) but compressed into one melee-range tool. */
// ---- Aerial Ground Slam (skill combo: jump or Leap, then slam) ----
// Slamming from height is the Warrior's signature bit of player expression: it costs nothing but
// timing, and rewards knowing the kit. Numbers deliberately modest — this is a flourish for a
// player who sets it up, not a damage rotation that makes the grounded cast obsolete.
const SLAM_DIVE_SPEED = 34; // downward velocity when slamming from the air — fast enough to read as a slam, not a fall
const SLAM_HEIGHT_FOR_MAX = 8; // fall height (units) at which the aerial bonus is fully earned
const SLAM_MAX_BONUS = 0.75; // +75% damage at full height
const SLAM_MIN_HEIGHT = 1.2; // below this the player is basically grounded — no bonus, no dive

const groundSlam: AbilityWithTree = {
  id: 'groundSlam',
  name: 'Ground Slam',
  desc: 'Smash the ground, damaging and staggering nearby enemies.',
  icon: '💥',
  targeting: 'ground',
  cooldown: 7,
  castRange: 6,
  ranks: [
    { cost: 0, stats: { damage: 45, radius: 3, slowPct: 35, duration: 1.2 } },
    { cost: 40, stats: { damage: 65 } },
    { cost: 80, stats: { damage: 95 } },
    { cost: 140, stats: { damage: 130, radius: 4, slowPct: 45, duration: 1.6 } },
  ],
  tree: groundSlamTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    // Airborne cast: drive the Warrior straight down and resolve the slam where they actually
    // land, rather than at a reticle they aimed from mid-air. Damage scales with how far they
    // fell, so leaping first and slamming on the way down is a real (and learnable) payoff.
    const groundY = game.castle.worldHeight(caster.pos.x, caster.pos.z);
    const height = caster.pos.y - groundY;
    if (!playerMotion.grounded && height > SLAM_MIN_HEIGHT) {
      const startY = caster.pos.y;
      slamDown(SLAM_DIVE_SPEED, () => {
        const fell = Math.max(0, startY - caster.pos.y);
        const bonus = 1 + SLAM_MAX_BONUS * Math.min(1, fell / SLAM_HEIGHT_FOR_MAX);
        resolveSlam(game, caster, caster.pos.clone(), stats, bonus);
      });
      return;
    }
    resolveSlam(game, caster, aimPoint.clone(), stats, 1);
  },
};

/** The slam's actual effect, shared by the grounded (reticle-targeted) and aerial (resolve-on-
 *  landing) paths so the two can never drift apart. `bonus` multiplies damage only — the radius
 *  and stagger a player reads off the indicator stay honest at every height. */
function resolveSlam(
  game: GameState,
  caster: PlayerState,
  aimPoint: Vector3,
  stats: Record<string, number>,
  bonus: number
): void {
  {
    const slowFactor = 1 - stats.slowPct / 100;
    const empower = empowerMultiplier(caster, game) * bonus;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - aimPoint.x;
      const dz = e.pos.z - aimPoint.z;
      if (dx * dx + dz * dz > stats.radius * stats.radius) continue;
      e.takeDamage(stats.damage * empower, game);
      e.slowFactor = slowFactor;
      e.slowUntil = game.time + stats.duration;
      if (stats.vulnPct) applyVulnerability(e, game, 1 + stats.vulnPct / 100, stats.vulnDuration);
    }
    if (stats.outerRadius) {
      // Aftershock/Seismic Aftershock: a weaker donut beyond the main blast — enemies inside
      // the inner radius already got the full hit above, this only reaches further out.
      const innerSq = stats.radius * stats.radius;
      const outerSq = stats.outerRadius * stats.outerRadius;
      const outerSlow = 1 - stats.outerSlowPct / 100;
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - aimPoint.x;
        const dz = e.pos.z - aimPoint.z;
        const d2 = dx * dx + dz * dz;
        if (d2 <= innerSq || d2 > outerSq) continue;
        e.takeDamage(stats.outerDamage * empower, game);
        e.slowFactor = outerSlow;
        e.slowUntil = game.time + stats.duration;
      }
      game.projectiles.impacts.push({
        pos: aimPoint.clone(),
        kind: 'slam',
        aoe: true,
        radius: stats.outerRadius,
        duration: stats.duration,
      });
    } else {
      game.projectiles.impacts.push({
        pos: aimPoint.clone(),
        kind: 'slam',
        aoe: true,
        radius: stats.radius,
        duration: stats.duration,
      });
    }
  }
}

/** Self-heal. 'aimed' targeting is used purely so pressing the hotkey casts it instantly (see
 *  casting.ts: non-'ground' hotkey abilities skip the reticle and cast immediately) — it
 *  ignores aimPoint entirely and always affects the caster. The survivability half of the
 *  Warrior's identity: stay in the fight instead of retreating to regen. */
const secondWind: AbilityWithTree = {
  id: 'secondWind',
  name: 'Second Wind',
  desc: 'Dig in and heal yourself.',
  icon: '❤',
  targeting: 'aimed',
  cooldown: 20,
  ranks: [
    { cost: 0, stats: { heal: 40 } },
    { cost: 40, stats: { heal: 60 } },
    { cost: 80, stats: { heal: 85 } },
    { cost: 140, stats: { heal: 120 } },
  ],
  tree: secondWindTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, _aimPoint: Vector3, stats: Record<string, number>) {
    caster.hp = Math.min(caster.maxHp, caster.hp + stats.heal);
    if (stats.dmgBuffPct) applyEmpower(caster, game, 1 + stats.dmgBuffPct / 100, stats.dmgBuffDuration);
    if (stats.reductionPct) applyDamageReduction(caster, game, 1 - stats.reductionPct / 100, stats.reductionDuration);
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'secondWind', aoe: false });
  },
};

/** Mobility: an instant, directional leap — no reticle, no confirm click. Pressing the key
 *  launches the Warrior up and forward along their current facing (yaw only, so looking up/down
 *  doesn't change the jump), punchier and far faster-cooldown than the mage's Blink (per
 *  docs/GAME_DESIGN.md's mobility note), and — unlike Blink, which is pure repositioning — it
 *  slams down for AoE damage the instant it actually lands, since a Warrior's mobility tool
 *  should feel like an aggressive weapon, not just a utility teleport.
 *
 *  The physics live in player/controller.ts's launchPlayer(): it owns vy/gravity/ground
 *  collision, so it's what actually enforces the playfield clamp and the wall step-up check —
 *  this cast() only picks a direction and a speed pair, then lets the controller fly it out.
 *
 *  Arc math (LEAP_VSPEED=18, GRAVITY=14, constant across ranks so clearance is rank-independent —
 *  only horizontal `speed` scales with rank, kept as a rank stat since it's genuinely balance
 *  data the Tab menu should show):
 *  apex height = LEAP_VSPEED^2 / (2*GRAVITY) = 324/28 ≈ 11.57 — comfortably clears the 6-unit wall.
 *  Time above 6 units solves 18t - 7t^2 = 6 -> t ∈ [0.394s, 2.178s], an 8.03-unit-wide window at
 *  the slowest rank's 4.5 speed (wider still at higher ranks) — that's more than the wall's own
 *  6-unit thickness, so a leap that starts anywhere in roughly the first ~1.8-3.8 units in front
 *  of a wall clears it outright; starting further back, the horizontal step-up check (shared
 *  with WASD collision) simply holds the player at the wall's base gaining height until they
 *  clear it, so worst case they mount the wall top instead of stalling. Total flight time
 *  T = 2*LEAP_VSPEED/GRAVITY ≈ 2.571s, giving horizontal ranges of ~11.6/14.1/16.7/19.3 across ranks. */
const LEAP_VSPEED = 18; // constant across ranks: clearance shouldn't depend on which rank you own
const LEAP_COOLDOWN = 5;
const leap: AbilityWithTree = {
  id: 'leap',
  name: 'Leap',
  desc: 'Launch yourself up and forward — no aiming, just jump — and slam down for damage on landing.',
  icon: '🦘',
  targeting: 'aimed', // instant on keypress; aimPoint is ignored, direction comes from caster.yaw
  cooldown: LEAP_COOLDOWN,
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { speed: 4.5, damage: 20, radius: 2.5 } },
    { cost: 40, stats: { speed: 5.5, damage: 30 } },
    { cost: 80, stats: { speed: 6.5, damage: 40 } },
    { cost: 140, stats: { speed: 7.5, damage: 55, radius: 3 } },
    // Rank V (late-game gold sink, unlocks behaviour): "Seismic Leap" — pure scaling first,
    // per the roadmap's "scales, eventually gaining a stun" ask. Bigger blast, still no CC.
    { cost: 220, stats: { speed: 8.2, damage: 75, radius: 3.4 } },
    // Rank VI: "Earthshaker" — the landing slam now stuns too. 1.3s stun on Leap's 5s cooldown
    // is a real but bounded ~26% uptime if you keep leaping onto the same spot — a flinch, not
    // a lock — and the radius (4) is cluster-sized, not wave-sized.
    { cost: 320, stats: { speed: 8.8, damage: 95, radius: 4, stunDuration: 1.3 } },
  ],
  tree: leapTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, _aimPoint: Vector3, stats: Record<string, number>) {
    // Horizontal-only facing direction (matches controller.ts's forward basis at strafe=0), so
    // camera pitch never affects the jump — looking up/down doesn't change where you land.
    const dirX = -Math.sin(caster.yaw);
    const dirZ = -Math.cos(caster.yaw);

    actionState.leaping = true;
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'leap', aoe: false });

    if (stats.cooldownMult) {
      // War Leap/Restless War Leap: tryCast() already set the full 5s cooldown before this
      // cast() ran — cut it down to a fraction so Leap comes back much sooner.
      caster.cooldowns['leap'] = game.time + LEAP_COOLDOWN * stats.cooldownMult;
    }

    launchPlayer(dirX, dirZ, stats.speed, LEAP_VSPEED, () => {
      // Fires the tick the controller detects the feet touching ground again — never a timer —
      // so the slam always lines up with the real landing point, whatever the arc did.
      actionState.leaping = false;
      const empower = empowerMultiplier(caster, game);
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - caster.pos.x;
        const dz = e.pos.z - caster.pos.z;
        if (dx * dx + dz * dz <= stats.radius * stats.radius) {
          e.takeDamage(stats.damage * empower, game);
          // Absent below rank VI — old behaviour (damage-only landing) is unchanged.
          if (stats.stunDuration) applyStun(e, game, stats.stunDuration);
          if (stats.knockback) {
            // Rolling Thunder/Thunderclap: push everything hit away from the landing point.
            const d = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
            e.pos.x += (dx / d) * stats.knockback;
            e.pos.z += (dz / d) * stats.knockback;
          }
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

export const WARRIOR: PlayerClassDef = {
  id: 'warrior',
  name: 'Warrior',
  desc: 'Frontline brawler: a wide cleaving blade, a ground-shaking slam, and the grit to keep swinging.',
  maxHp: 150,
  moveSpeed: 6,
  primary: cleave,
  abilities: [groundSlam, secondWind, leap],
};
