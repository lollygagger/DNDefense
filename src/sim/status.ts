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

// ---------- read-only status queries (ability-clarity task, 2026-08-27) ----------
// Everything below only READS the public stunUntil/slowUntil/slowFactor fields above — it
// cannot change what applyStun/applySlow do, how they stack, or when they expire. Added so
// render code (enemyView.ts's status icons, hud.ts's optional player status row) has a single
// canonical place to ask "is this active right now" instead of re-deriving the game.time
// comparison inline in every file that wants to draw one. Every function here returns a
// primitive (boolean or number) — no allocation, safe to call every render frame for every
// unit on screen (up to ~80 enemies).

/** Seconds of stun left, or 0 if not currently stunned. */
export function stunRemaining(u: Unit, game: GameState): number {
  return u.stunUntil !== undefined && game.time < u.stunUntil ? u.stunUntil - game.time : 0;
}

/** True while a slow is active AND actually reducing speed (a 0%-strength slow, if one were ever
 *  applied, wouldn't be worth drawing an icon for). */
export function isSlowed(u: Unit, game: GameState): boolean {
  return u.slowUntil !== undefined && game.time < u.slowUntil && (u.slowFactor ?? 1) < 1;
}

/** Seconds of slow left, or 0 if not currently slowed. */
export function slowRemaining(u: Unit, game: GameState): number {
  return u.slowUntil !== undefined && game.time < u.slowUntil ? u.slowUntil - game.time : 0;
}

/** 0 (no slow) .. just-under-1 (nearly immobile). Lets render distinguish a mild chill from a
 *  heavy root/snare without sim code having to know about "root" as a concept — it's just how
 *  strong today's slow happens to be. See render/statusIcons.ts's ROOT_SEVERITY_THRESHOLD for
 *  where the render layer draws the mild-vs-severe line. */
export function slowSeverity(u: Unit, game: GameState): number {
  if (!isSlowed(u, game)) return 0;
  return 1 - (u.slowFactor ?? 1);
}
