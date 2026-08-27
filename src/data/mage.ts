import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { AbilityDef, PlayerClassDef, PlayerState } from '../sim/types';
import { clampToPlayfield, resetFall } from '../player/controller';
import { muzzlePoint } from '../sim/projectiles';
import { applyStun } from '../sim/status';

/** Mage class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  cast() implementations are sim-side: projectiles + state only, no rendering. */

const arcaneBolt: AbilityDef = {
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
  ],
  cast(game: GameState, _caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const dir = aimPoint.clone().sub(origin).normalize();
    game.projectiles.spawn({
      pos: muzzlePoint(game, origin, dir, 0.8),
      vel: dir.multiplyScalar(stats.speed),
      team: 'defender',
      damage: stats.damage,
      radius: 0.35,
      pierce: stats.pierce, // undefined below rank V — spawn() defaults that to 0, unchanged
      kind: 'bolt',
    });
  },
};

const fireball: AbilityDef = {
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
      // Below rank V, stats.stunRadius is undefined and this never fires — byte-for-byte the
      // old behaviour. onImpact is the sanctioned extension point on the frozen ProjectileSpec
      // (see sim/types.ts) for exactly this: reacting to the real impact point without needing
      // anything from sim/projectiles.ts itself.
      onImpact: stats.stunRadius
        ? (g: GameState, at: Vector3) => {
            const stunRadiusSq = stats.stunRadius * stats.stunRadius;
            for (const e of g.enemies) {
              if (!e.alive) continue;
              const dx = e.pos.x - at.x;
              const dz = e.pos.z - at.z;
              if (dx * dx + dz * dz <= stunRadiusSq) applyStun(e, g, stats.stunDuration);
            }
            // 'slam' is the closest fit in the frozen fx.ts kind table for "a wide shockwave
            // ring beyond the blast" — fireball itself already drew the fiery burst+ring at the
            // damage radius via the projectile system's own impact() call, right before this.
            g.projectiles.impacts.push({
              pos: at.clone(),
              kind: 'slam',
              aoe: true,
              radius: stats.stunRadius,
              duration: stats.stunDuration,
            });
          }
        : undefined,
    });
  },
};

const frostField: AbilityDef = {
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

const blink: AbilityDef = {
  id: 'blink',
  name: 'Blink',
  desc: 'Teleport to a targeted point — even straight onto a wall top. Your mobility tool.',
  icon: '🌀',
  targeting: 'ground',
  cooldown: 12,
  castRange: 28, // matches the maxed-out rank; casting.ts prefers the rank's own `range` stat
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { range: 22 } },
    { cost: 40, stats: { range: 24 } },
    { cost: 80, stats: { range: 26 } },
    { cost: 140, stats: { range: 28 } },
  ],
  cast(game: GameState, caster: PlayerState, _origin: Vector3, aimPoint: Vector3, _stats: Record<string, number>) {
    // Safety clamp: never land past the forward barrier or off the playfield edges — the
    // exact same rule the WASD controller enforces every tick (see player/controller.ts).
    // casting.ts already limited the raw aim point to this rank's range before we get here,
    // so this clamp only ever matters for the barrier/edges, not distance.
    const { x, z } = clampToPlayfield(game, aimPoint.x, aimPoint.z);
    const y = game.castle.worldHeight(x, z);

    // Cosmetic flash at the departure point, then move the caster and clear fall velocity
    // so gravity doesn't carry over from wherever they were before the blink.
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'blink', aoe: false });
    caster.pos.set(x, y, z);
    resetFall();
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'blink', aoe: false });
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
