import type { GameState } from './GameState';

/** Owned by [enemies-waves] (combat-legibility task, 2026-08-27). Sim -> render damage-event
 *  channel: the exact "plain array sim pushes to, render drains every frame" shape
 *  `ProjectileSystem.impacts` already establishes (see render/fx.ts) — but `GameState` is
 *  FROZEN, so this channel can't live as a `game.something` field the way
 *  `game.projectiles.impacts` does. Instead it's a per-GameState queue kept in a WeakMap here,
 *  the same idiom `sim/abilityEffects.ts`'s `groundEffectsByGame` already uses for exactly this
 *  reason (a thing that isn't naturally a field on a pre-existing long-lived object).
 *
 *  Single call site: `sim/enemies.ts`'s `takeDamage` closure. Every enemy hit, from every damage
 *  source in the game — the player's own attacks, structures, allies, wall passives, DoT ticks —
 *  calls `enemy.takeDamage(amount, game)`, and that closure is the one place all of them funnel
 *  through. Hooking it there captures the whole game's enemy damage without touching any of the
 *  many files (mage/warrior/archer/tank ability data, structures, ally AI) that actually call it.
 *
 *  READABILITY UNDER LOAD. A wave of 80 enemies, several bleeding or standing in a damage zone,
 *  would otherwise push a fresh render event on every 60Hz sim tick per affected enemy — a wall
 *  of overlapping tiny numbers, the opposite of legible. Rather than trust every call site to
 *  flag itself as "this is a DoT tick" (several real tick sources — the Flamethrower structure,
 *  the wall's Machicolations/Boiling Oil base damage — live in files this task doesn't own and
 *  can't tag), classification is purely time-based: any hit landing on the same enemy within
 *  RAPID_TICK_WINDOW of the previous one is assumed to be part of the same continuous-tick
 *  stream. Every 60Hz continuous effect lands ~16ms apart; every discrete, deliberately-paced
 *  attack in the game clears that window with room to spare — even the fastest, Soul Siphon's
 *  150ms channel tick, is 25% above it. Rapid hits accumulate into a running per-enemy bucket
 *  that flushes as ONE number every DOT_AGGREGATE_WINDOW seconds instead of one number per tick.
 *  A kill is never bucketed: it always renders immediately, on its own, at full priority. */

export type DamageEventKind = 'hit' | 'dot' | 'kill';

export interface DamageEvent {
  x: number;
  y: number;
  z: number;
  amount: number;
  kind: DamageEventKind;
  amplified: boolean; // target was vulnerable/marked (isVulnerable) at the moment of this hit
}

const MAX_DAMAGE_EVENTS = 220; // one render frame's worth of pooled entries; overflow is
// dropped rather than the queue growing — see pushEvent below.
const RAPID_TICK_WINDOW = 0.12; // seconds — see file doc comment
const DOT_AGGREGATE_WINDOW = 0.4; // seconds a bucket accumulates before it flushes on its own

interface DotBucket {
  amount: number;
  x: number;
  y: number;
  z: number;
  amplified: boolean;
  flushAt: number; // game.time this bucket must flush by, even with no further ticks
}

interface DamageQueue {
  events: DamageEvent[]; // fixed-size pool; [0, count) are this frame's pending events
  count: number;
  lastHitAt: Map<number, number>; // enemy id -> game.time of its last hit (rapid-tick detection)
  buckets: Map<number, DotBucket>; // enemy id -> in-progress DoT accumulation
}

const queues = new WeakMap<GameState, DamageQueue>();

function queueFor(game: GameState): DamageQueue {
  let q = queues.get(game);
  if (!q) {
    const events: DamageEvent[] = [];
    for (let i = 0; i < MAX_DAMAGE_EVENTS; i++) {
      events.push({ x: 0, y: 0, z: 0, amount: 0, kind: 'hit', amplified: false });
    }
    q = { events, count: 0, lastHitAt: new Map(), buckets: new Map() };
    queues.set(game, q);
  }
  return q;
}

/** Writes into the next pooled slot in place — no allocation per hit, the hot-path requirement
 *  the task calls out explicitly. Bounded: once a frame's 220 slots are full, further events are
 *  silently dropped rather than the array growing, exactly like fx.ts's MAX_BURSTS/MAX_RINGS. */
function pushEvent(
  q: DamageQueue,
  x: number,
  y: number,
  z: number,
  amount: number,
  kind: DamageEventKind,
  amplified: boolean,
): void {
  if (q.count >= MAX_DAMAGE_EVENTS) return;
  const e = q.events[q.count++];
  e.x = x;
  e.y = y;
  e.z = z;
  e.amount = amount;
  e.kind = kind;
  e.amplified = amplified;
}

function flushBucket(q: DamageQueue, id: number): void {
  const b = q.buckets.get(id);
  if (!b) return;
  q.buckets.delete(id);
  if (b.amount >= 1) pushEvent(q, b.x, b.y, b.z, b.amount, 'dot', b.amplified);
}

/** Record one enemy taking damage. Called once per `takeDamage()` invocation, from every source
 *  in the game (see file doc comment). `dying` marks the hit that actually reduced the enemy to
 *  0 hp — it always renders immediately, full-size, never bucketed, and its id's bookkeeping is
 *  cleaned up immediately after (ids from `allocId()` are never reused, so nothing to reconcile
 *  later; this just keeps the two Maps from growing across a long endless-mode session). */
export function recordEnemyDamage(
  game: GameState,
  enemyId: number,
  x: number,
  y: number,
  z: number,
  amount: number,
  amplified: boolean,
  dying: boolean,
): void {
  if (amount <= 0) return;
  const q = queueFor(game);

  if (dying) {
    q.lastHitAt.delete(enemyId);
    q.buckets.delete(enemyId);
    pushEvent(q, x, y, z, amount, 'kill', amplified);
    return;
  }

  const last = q.lastHitAt.get(enemyId);
  q.lastHitAt.set(enemyId, game.time);
  const rapid = last !== undefined && game.time - last < RAPID_TICK_WINDOW;

  if (!rapid) {
    // A fresh, deliberately-paced hit: flush anything still accumulating for this enemy first
    // (a DoT that just ended shouldn't silently lose its last partial bucket), then show this
    // hit on its own, immediately, at full weight.
    flushBucket(q, enemyId);
    pushEvent(q, x, y, z, amount, 'hit', amplified);
    return;
  }

  let bucket = q.buckets.get(enemyId);
  if (!bucket) {
    bucket = { amount: 0, x, y, z, amplified, flushAt: game.time + DOT_AGGREGATE_WINDOW };
    q.buckets.set(enemyId, bucket);
  }
  bucket.amount += amount;
  bucket.x = x;
  bucket.y = y;
  bucket.z = z;
  bucket.amplified = bucket.amplified || amplified;
}

/** Called once per render frame (render/floatingText.ts), before draining, so a DoT bucket with
 *  no fresh ticks this frame (the zone expired, the enemy walked out, the bleed ran out) still
 *  shows its last partial accumulation instead of silently vanishing. */
export function flushDueBuckets(game: GameState): void {
  const q = queues.get(game);
  if (!q) return;
  for (const [id, b] of q.buckets) {
    if (game.time >= b.flushAt) {
      q.buckets.delete(id);
      if (b.amount >= 1) pushEvent(q, b.x, b.y, b.z, b.amount, 'dot', b.amplified);
    }
  }
}

/** This frame's pending events (`events[0..count)`) plus the mutable `count` render resets to 0
 *  after consuming them — mirrors `game.projectiles.impacts`' "drain, then clear" shape without
 *  allocating a fresh array every frame (the pooled entries are overwritten in place instead). */
export function getDamageQueue(game: GameState): DamageQueue {
  return queueFor(game);
}
