import type { GameState } from './GameState';
import type { Unit } from './types';

/** Central status-effect helpers. Every source of crowd control — class abilities, tower
 *  weapons, enemy specials — goes through these so the rules live in one place and a new
 *  content author never has to rediscover how a debuff is stored.
 *
 *  Effects are stored as an expiry timestamp on the Unit rather than a list of ticking
 *  objects: it is allocation-free, trivially serializable for a future multiplayer server,
 *  and cheap to test in a hot AI loop that runs for every unit every tick. */

/** Longer wins. A fresh stun never cuts an existing longer one short — otherwise chaining a
 *  weak stun onto a strong one would be a downgrade, which reads as a bug to a player. */
export function applyStun(u: Unit, game: GameState, seconds: number): void {
  const until = game.time + seconds;
  if (u.stunUntil === undefined || until > u.stunUntil) u.stunUntil = until;
}

/** A stunned unit does nothing at all: no movement, no attacks, no target acquisition. */
export function isStunned(u: Unit, game: GameState): boolean {
  return u.stunUntil !== undefined && game.time < u.stunUntil;
}

/** Slow, as a movement multiplier (0.6 = 40% slower). Strongest slow wins, and a stronger
 *  slow always refreshes the timer; a weaker one may only extend an already-expiring one. */
export function applySlow(u: Unit, game: GameState, factor: number, seconds: number): void {
  const until = game.time + seconds;
  const current = u.slowUntil !== undefined && game.time < u.slowUntil ? (u.slowFactor ?? 1) : 1;
  if (factor <= current) {
    u.slowFactor = factor;
    u.slowUntil = Math.max(until, u.slowUntil ?? 0);
  } else if (until > (u.slowUntil ?? 0)) {
    u.slowUntil = until;
  }
}

/** Movement multiplier from all active movement debuffs. Stun wins outright at 0. */
export function moveMultiplier(u: Unit, game: GameState): number {
  if (isStunned(u, game)) return 0;
  return u.slowUntil !== undefined && game.time < u.slowUntil ? (u.slowFactor ?? 1) : 1;
}
