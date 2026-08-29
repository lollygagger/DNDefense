import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { PlayerClassDef, PlayerState } from '../sim/types';
import type { AbilityWithTree } from '../sim/abilityTree';
import { clampToPlayfield, resetFall } from '../player/controller';
import { muzzlePoint } from '../sim/projectiles';
import { applyStun } from '../sim/status';
import { spawnGroundEffect } from '../sim/abilityEffects';
import { arcaneBoltTree, blinkTree, fireballTree, frostFieldTree } from './mageTree';

/** Mage class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  cast() implementations are sim-side: projectiles + state only, no rendering. Every ability
 *  also carries a late-game "Mastery" tree (see sim/abilityTree.ts) hanging off its linear ranks —
 *  the branch data/costs live in data/mageTree.ts, this file only implements what each branch's
 *  stats actually do. */

const UP = new Vector3(0, 1, 0);

const arcaneBolt: AbilityWithTree = {
  id: 'arcaneBolt',
  name: 'Arcane Bolt',
  desc: 'Aimed magic projectile. Your bread and butter.',
  icon: '✨',
  targeting: 'aimed',
  cooldown: 0.4,
  ranks: [
    { cost: 0, stats: { damage: 20, speed: 40 } },
    { cost: 40, stats: { damage: 30 } },
    { cost: 80, stats: { damage: 45 } },
    { cost: 140, stats: { damage: 65 } },
    // Rank V (late-game gold sink, unlocks behaviour): the bolt punches through one extra
    // enemy instead of stopping dead on the first hit — a real shape change on the class's
    // cheapest, most-spammed attack, not just a bigger number.
    { cost: 220, stats: { damage: 80, pierce: 1 } },
    // Ranks VI-X: the bolt keeps growing and keeps punching through more bodies, so a single
    // click eventually skewers most of a file rather than one enemy in it.
    { cost: 600, stats: { damage: 110, pierce: 2 } },
    { cost: 1500, stats: { damage: 155, pierce: 3 } },
    { cost: 3500, stats: { damage: 215, pierce: 4 } },
    { cost: 7500, stats: { damage: 300, pierce: 5 } },
    { cost: 16000, stats: { damage: 420, pierce: 8 } },
  ],
  tree: arcaneBoltTree,
  cast(game: GameState, _caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const baseDir = aimPoint.clone().sub(origin).normalize();
    // count/spreadDeg only exist once Fork Bolt is purchased (see mageTree.ts) — undefined below
    // that means a single bolt straight down the aim ray, byte-for-byte the old behaviour.
    const count = Math.max(1, Math.round(stats.count ?? 1));
    const spreadRad = ((stats.spreadDeg ?? 0) * Math.PI) / 180;
    for (let i = 0; i < count; i++) {
      const offset = count > 1 ? (i - (count - 1) / 2) * spreadRad : 0;
      const dir = offset !== 0 ? baseDir.clone().applyAxisAngle(UP, offset) : baseDir.clone();
      game.projectiles.spawn({
        pos: muzzlePoint(game, origin, dir, 0.8),
        vel: dir.multiplyScalar(stats.speed),
        team: 'defender',
        damage: stats.damage,
        radius: 0.35,
        pierce: stats.pierce, // undefined below rank V — spawn() defaults that to 0, unchanged
        kind: 'bolt',
        // Empowered Bolt's slow: onImpact only gets a position (not the hit unit), so it scans a
        // tight radius around the impact point — the same position-based trick fireball's own
        // stun ring uses, just tuned tight enough to only ever catch the one thing that was hit.
        onImpact: stats.slowPct
          ? (g: GameState, at: Vector3) => {
              const r2 = 1.5 * 1.5;
              for (const e of g.enemies) {
                if (!e.alive) continue;
                const dx = e.pos.x - at.x;
                const dz = e.pos.z - at.z;
                if (dx * dx + dz * dz <= r2) {
                  e.slowFactor = 1 - stats.slowPct / 100;
                  e.slowUntil = g.time + stats.slowDuration;
                }
              }
            }
          : undefined,
      });
    }
  },
};

const fireball: AbilityWithTree = {
  id: 'fireball',
  name: 'Fireball',
  desc: 'Call down a fiery explosion at a targeted point.',
  icon: '🔥',
  targeting: 'ground',
  cooldown: 6,
  castRange: 45,
  ranks: [
    { cost: 0, stats: { damage: 60, radius: 4 } },
    { cost: 40, stats: { damage: 90, radius: 5 } },
    { cost: 80, stats: { damage: 130, radius: 6 } },
    { cost: 140, stats: { damage: 180, radius: 6.5 } },
    // Rank V (late-game gold sink, unlocks behaviour): the damage radius stays put — this rank
    // isn't "bigger boom" — but the shockwave now stuns everything in a MUCH wider ring beyond
    // the flames. Cooldown (6s) stays far above the stun (1.6s), so one caster can't approach
    // lockdown even spamming it on the same spot.
    { cost: 220, stats: { damage: 210, stunRadius: 10, stunDuration: 1.6 } },
  ],
  tree: fireballTree,
  cast(game: GameState, _caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    // meteor falls from above the target point; explodes on ground impact via aoeRadius
    game.projectiles.spawn({
      pos: new Vector3(aimPoint.x, aimPoint.y + 14, aimPoint.z),
      vel: new Vector3(0, -26, 0),
      team: 'defender',
      damage: stats.damage,
      radius: 0.6,
      aoeRadius: stats.radius,
      kind: 'fireball',
      ttl: 2,
      // Below rank V none of stunRadius/stormCount/burnDps are set and this is a no-op — byte-
      // for-byte the old behaviour. onImpact is the sanctioned extension point on the frozen
      // ProjectileSpec (see sim/types.ts) for reacting to the real impact point.
      onImpact(g: GameState, at: Vector3) {
        if (stats.stunRadius) {
          const stunRadiusSq = stats.stunRadius * stats.stunRadius;
          for (const e of g.enemies) {
            if (!e.alive) continue;
            const dx = e.pos.x - at.x;
            const dz = e.pos.z - at.z;
            if (dx * dx + dz * dz <= stunRadiusSq) applyStun(e, g, stats.stunDuration);
          }
          // 'slam' is the closest fit in the frozen fx.ts kind table for "a wide shockwave ring
          // beyond the blast" — fireball itself already drew the fiery burst+ring at the damage
          // radius via the projectile system's own impact() call, right before this.
          g.projectiles.impacts.push({
            pos: at.clone(),
            kind: 'slam',
            aoe: true,
            radius: stats.stunRadius,
            duration: stats.stunDuration,
          });
        }
        if (stats.stormCount) {
          // Meteor Storm/Swarm: several smaller fragments scattered around the main blast,
          // applied instantly rather than genuinely delayed (the sim has no projectile-timeline
          // scheduler to hang a real delay off) — still reads as "hits a much wider area" than
          // the single point the base ability covers.
          const count = Math.round(stats.stormCount);
          for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2 + game.rng.next() * 0.6;
            const dist = game.rng.next() * stats.stormScatter;
            const fx = at.x + Math.cos(angle) * dist;
            const fz = at.z + Math.sin(angle) * dist;
            const r2 = stats.stormRadius * stats.stormRadius;
            for (const e of g.enemies) {
              if (!e.alive) continue;
              const dx = e.pos.x - fx;
              const dz = e.pos.z - fz;
              if (dx * dx + dz * dz <= r2) e.takeDamage(stats.stormDamage, g);
            }
            g.projectiles.impacts.push({
              pos: new Vector3(fx, at.y, fz),
              kind: 'fireball',
              aoe: true,
              radius: stats.stormRadius,
            });
          }
        }
        if (stats.burnDps) {
          // Volcanic/Molten Rupture: a lingering burning crater at the impact point.
          spawnGroundEffect(g, at, stats.burnRadius, stats.burnDuration, { dps: stats.burnDps });
        }
      },
    });
  },
};

const frostField: AbilityWithTree = {
  id: 'frostField',
  name: 'Frost Field',
  desc: 'Chill an area, slowing enemies inside.',
  icon: '❄️',
  targeting: 'ground',
  cooldown: 10,
  castRange: 45,
  ranks: [
    { cost: 0, stats: { radius: 5, slowPct: 40, duration: 4 } },
    { cost: 40, stats: { slowPct: 50, duration: 5 } },
    { cost: 80, stats: { slowPct: 60, duration: 6 } },
    { cost: 140, stats: { radius: 6.5, slowPct: 65, duration: 7 } },
    // Rank V (late-game gold sink, unlocks behaviour): "Deep Freeze" — the field now also
    // stuns everyone caught in it for a brief moment on cast, on top of the long slow. Short
    // relative to the 10s cooldown on purpose, same reasoning as Fireball's rank V.
    { cost: 220, stats: { radius: 7.5, slowPct: 70, duration: 8, stunDuration: 1.2 } },
  ],
  tree: frostFieldTree,
  cast(game: GameState, _caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const slowFactor = 1 - stats.slowPct / 100;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - aimPoint.x;
      const dz = e.pos.z - aimPoint.z;
      if (dx * dx + dz * dz <= stats.radius * stats.radius) {
        e.slowFactor = slowFactor;
        e.slowUntil = game.time + stats.duration;
        if (stats.stunDuration) applyStun(e, game, stats.stunDuration);
      }
    }
    if (stats.frostDps) {
      // Killing Frost/Hoarfrost: the field itself burns for the same window as the slow.
      spawnGroundEffect(game, aimPoint, stats.radius, stats.duration, { dps: stats.frostDps });
    }
    if (stats.lingerSlowPct) {
      // Permafrost/Eternal Frost: a weaker slow zone that outlasts the main duration. Spawned
      // for the FULL window (duration + lingerDuration) — while the strong cast-time slow above
      // is still active, sim/status.ts's applySlow stacking rule (stronger wins) keeps this
      // weaker reapplication from downgrading it; once the strong slow's own timer lapses, this
      // is what's left ticking the enemies still standing in the zone.
      spawnGroundEffect(game, aimPoint, stats.radius, stats.duration + stats.lingerDuration, {
        slowFactor: 1 - stats.lingerSlowPct / 100,
      });
    }
    // cosmetic ring via the impacts channel (fx layer renders it)
    game.projectiles.impacts.push({
      pos: aimPoint.clone(),
      kind: 'frost',
      aoe: true,
      radius: stats.radius,
      duration: stats.duration,
    });
  },
};

/** Blink Cascade's charge-bank state: PlayerState (sim/types.ts) is FROZEN and has no room for
 *  "how many banked blinks does this caster have," so it's kept here the same WeakMap-off-to-
 *  the-side way every other Mastery side-effect is (see sim/abilityEffects.ts's header). Local to
 *  this file (not sim/abilityEffects.ts) since it hardcodes Blink's own cooldown constant and id —
 *  nothing else needs an N-charge-with-passive-regen mechanism today. */
const BLINK_COOLDOWN = 12;
const blinkCharges = new WeakMap<PlayerState, { charges: number; lastRegenAt: number }>();

const blink: AbilityWithTree = {
  id: 'blink',
  name: 'Blink',
  desc: 'Teleport to a targeted point — even straight onto a wall top. Your mobility tool.',
  icon: '🌀',
  targeting: 'ground',
  cooldown: BLINK_COOLDOWN,
  castRange: 28, // matches the maxed-out rank; casting.ts prefers the rank's own `range` stat
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { range: 22 } },
    { cost: 40, stats: { range: 24 } },
    { cost: 80, stats: { range: 26 } },
    { cost: 140, stats: { range: 28 } },
  ],
  tree: blinkTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    // Safety clamp: never land past the forward barrier or off the playfield edges — the
    // exact same rule the WASD controller enforces every tick (see player/controller.ts).
    // casting.ts already limited the raw aim point to this rank's range before we get here,
    // so this clamp only ever matters for the barrier/edges, not distance.
    const { x, z } = clampToPlayfield(game, aimPoint.x, aimPoint.z);
    const y = game.castle.worldHeight(x, z);
    const departure = caster.pos.clone();

    // Cosmetic flash at the departure point, then move the caster and clear fall velocity
    // so gravity doesn't carry over from wherever they were before the blink.
    game.projectiles.impacts.push({ pos: departure, kind: 'blink', aoe: false });
    caster.pos.set(x, y, z);
    resetFall();
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'blink', aoe: false });

    if (stats.reboundDamage) {
      // Arcane Rebound: punish anyone chasing you into the spot you just left.
      const r2 = stats.reboundRadius * stats.reboundRadius;
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - departure.x;
        const dz = e.pos.z - departure.z;
        if (dx * dx + dz * dz > r2) continue;
        e.takeDamage(stats.reboundDamage, game);
        e.slowFactor = 1 - stats.reboundSlowPct / 100;
        e.slowUntil = game.time + stats.reboundSlowDuration;
      }
      game.projectiles.impacts.push({
        pos: departure,
        kind: 'frost',
        aoe: true,
        radius: stats.reboundRadius,
        duration: stats.reboundSlowDuration,
      });
    }

    const maxCharges = Math.round(stats.charges ?? 1);
    if (maxCharges > 1) {
      // Blink Cascade/Torrent: tryCast() already set the normal 12s cooldown before this cast()
      // ran (see sim/classes.ts) — if a charge is still banked, refund that cooldown to "ready
      // now" instead, and let the passive regen below slowly refill the bank over time.
      const now = game.time;
      let cs = blinkCharges.get(caster);
      if (!cs) cs = { charges: maxCharges, lastRegenAt: now };
      const regenInterval = BLINK_COOLDOWN / maxCharges;
      const regened = Math.floor((now - cs.lastRegenAt) / regenInterval);
      if (regened > 0) {
        cs.charges = Math.min(maxCharges, cs.charges + regened);
        cs.lastRegenAt += regened * regenInterval;
      }
      if (cs.charges > 0) {
        cs.charges -= 1;
        caster.cooldowns['blink'] = now;
      }
      blinkCharges.set(caster, cs);
    }
  },
};

export const MAGE: PlayerClassDef = {
  id: 'mage',
  name: 'Mage',
  desc: 'Master of arcane artillery: aimed bolts, devastating area magic, and a short-range blink.',
  maxHp: 100,
  moveSpeed: 6,
  primary: arcaneBolt,
  abilities: [fireball, frostField, blink],
};
