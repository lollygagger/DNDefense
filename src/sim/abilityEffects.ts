import type { Vector3 } from 'three';
import type { GameState } from './GameState';
import type { Enemy, PlayerState } from './types';
import { applySlow } from './status';

/** Owned by [player-classes]. Generic, class-agnostic combat side-effects used by the late-game
 *  ability Mastery trees (sim/abilityTree.ts) — split out of sim/classes.ts to keep that file
 *  under the ~400-line guideline. Every effect here is stored off to the side (WeakMap keyed by
 *  the Enemy/PlayerState/GameState object itself), the same allocation-free, no-manual-cleanup
 *  shape sim/classes.ts's damageReduction and data/tank.ts's stunFatigue already use — an entry
 *  just falls out of memory once its owner does, and nothing here needs a field on the frozen
 *  Unit/PlayerState contracts. None of this is tied to one class mechanically; it happens that
 *  today's callers are spread across mage/warrior/archer/tank data files, exactly like
 *  applyDamageReduction was written once for the Tank but is genuinely generic. */

// ---------- vulnerability: this unit takes bonus damage from the source that applied it ----------
// (Warrior's Fracture, Archer's Hunter's Mark / Crippling Shot.) Stronger-or-longer wins, same
// stacking rule as sim/status.ts's applySlow, so re-applying a weaker mark never downgrades one
// already active.

interface Amp {
  mult: number;
  until: number;
}

const vulnerable = new WeakMap<Enemy, Amp>();

export function applyVulnerability(e: Enemy, game: GameState, mult: number, seconds: number): void {
  const until = game.time + seconds;
  const cur = vulnerable.get(e);
  const curMult = cur && game.time < cur.until ? cur.mult : 1;
  if (mult >= curMult) vulnerable.set(e, { mult, until: Math.max(until, cur?.until ?? 0) });
  else if (until > (cur?.until ?? 0)) vulnerable.set(e, { mult: curMult, until });
}

export function vulnerabilityMultiplier(e: Enemy, game: GameState): number {
  const v = vulnerable.get(e);
  return v && game.time < v.until ? v.mult : 1;
}

/** Read-only: is `e` currently marked vulnerable? (render/enemyView.ts's status icons — the
 *  multiplier alone can't tell a caller "is this worth an icon" since it returns 1, a valid
 *  value on its own, when nothing is active.) */
export function isVulnerable(e: Enemy, game: GameState): boolean {
  const v = vulnerable.get(e);
  return !!v && game.time < v.until;
}

// ---------- empower: this caster deals bonus damage for a while ----------
// (Warrior's Adrenaline Surge.) Mirrors vulnerability but keyed on the attacker instead.

const empower = new WeakMap<PlayerState, Amp>();

export function applyEmpower(caster: PlayerState, game: GameState, mult: number, seconds: number): void {
  const until = game.time + seconds;
  const cur = empower.get(caster);
  const curMult = cur && game.time < cur.until ? cur.mult : 1;
  if (mult >= curMult) empower.set(caster, { mult, until: Math.max(until, cur?.until ?? 0) });
  else if (until > (cur?.until ?? 0)) empower.set(caster, { mult: curMult, until });
}

export function empowerMultiplier(caster: PlayerState, game: GameState): number {
  const e = empower.get(caster);
  return e && game.time < e.until ? e.mult : 1;
}

/** Read-only: is `caster` currently empowered? (optional ui/hud.ts player-status row.) */
export function isEmpowered(caster: PlayerState, game: GameState): boolean {
  const e = empower.get(caster);
  return !!e && game.time < e.until;
}

/** Read-only: seconds of empower left, or 0. */
export function empowerRemaining(caster: PlayerState, game: GameState): number {
  const e = empower.get(caster);
  return e && game.time < e.until ? e.until - game.time : 0;
}

// ---------- bleed: stacking per-enemy damage-over-time ----------
// (Warrior's Bloodletting.) Ticked reactively off the existing game.enemies list in
// tickAbilityEffects — no separate index to maintain or prune.

interface BleedState {
  dps: number;
  until: number;
  stacks: number;
}

const DEFAULT_MAX_STACKS = 5;
const bleedState = new WeakMap<Enemy, BleedState>();

export function applyBleed(
  e: Enemy,
  game: GameState,
  dpsPerStack: number,
  duration: number,
  maxStacks = DEFAULT_MAX_STACKS
): void {
  const cur = bleedState.get(e);
  const activeStacks = cur && game.time < cur.until ? cur.stacks : 0;
  const stacks = Math.min(maxStacks, activeStacks + 1);
  bleedState.set(e, { dps: dpsPerStack * stacks, until: game.time + duration, stacks });
}

/** Read-only: is `e` currently bleeding? (render/enemyView.ts's status icons.) */
export function isBleeding(e: Enemy, game: GameState): boolean {
  const b = bleedState.get(e);
  return !!b && game.time < b.until;
}

/** Read-only: current stack count (1..maxStacks), or 0 if not bleeding. */
export function bleedStackCount(e: Enemy, game: GameState): number {
  const b = bleedState.get(e);
  return b && game.time < b.until ? b.stacks : 0;
}

// ---------- ground effect zones: persistent AoE damage-over-time and/or slow ----------
// (Mage's Volcanic Rupture burn, Permafrost's lingering chill, Killing Frost.) A plain array,
// per-GameState (WeakMap-keyed, same reasoning sim/waves.ts's scheduler map uses) since these
// aren't naturally attached to a pre-existing long-lived object the way bleed/vulnerability are.

export interface GroundEffect {
  pos: Vector3;
  radius: number;
  dps: number; // 0 = damage-free (a pure lingering slow zone)
  slowFactor?: number; // continuously re-applied to anyone inside, undefined = no slow
  until: number;
}

/** Read-only: was `e` standing in a damaging ground zone as of the last tick? (render/
 *  enemyView.ts's "burning" status icon.) Zones aren't naturally attached to the enemies inside
 *  them the way bleed/vulnerability are (an enemy can wander in or out of one at any moment), so
 *  this is a lightweight per-enemy marker set alongside the real damage tick in
 *  tickAbilityEffects below — it changes nothing about how much damage a zone deals, its radius,
 *  or its expiry, it just records the already-true fact that the enemy was just hit by one. The
 *  short grace window (longer than one 60Hz tick) is so a render frame landing between two ticks
 *  never sees a false one-frame gap while the enemy is still standing in the zone. */
const burningUntil = new WeakMap<Enemy, number>();
const BURN_MARK_GRACE = 0.2;

export function isBurning(e: Enemy, game: GameState): boolean {
  const until = burningUntil.get(e);
  return until !== undefined && game.time < until;
}

const groundEffectsByGame = new WeakMap<GameState, GroundEffect[]>();

function groundEffectsFor(game: GameState): GroundEffect[] {
  let list = groundEffectsByGame.get(game);
  if (!list) {
    list = [];
    groundEffectsByGame.set(game, list);
  }
  return list;
}

export function spawnGroundEffect(
  game: GameState,
  pos: Vector3,
  radius: number,
  duration: number,
  opts: { dps?: number; slowFactor?: number }
): void {
  groundEffectsFor(game).push({
    pos: pos.clone(),
    radius,
    dps: opts.dps ?? 0,
    slowFactor: opts.slowFactor,
    until: game.time + duration,
  });

  // Auto-emit an honest visual for this exact zone (ability-clarity task, 2026-08-27). Before
  // this, a caller had to remember to separately push a matching `impacts` entry sized to the
  // same radius/duration — most did (Curse of Agony, the ally Mage Tower's Arcane Residue), but
  // three real callers didn't: Volcanic/Molten Rupture's burning crater and the Warlock's
  // Withering/Blighted Beam residue were completely invisible, and Frost Field's Permafrost/
  // Eternal Frost lingering chill drew its ring for only `duration` while the real zone (passed
  // `duration + lingerDuration` here) kept slowing for several seconds after the indicator had
  // already faded — a visual that quietly undersold its own real duration. Pushing straight from
  // here, using the exact radius/duration/dps/slowFactor this call was given, makes the indicator
  // right by construction for every caller, present and future, without each one having to
  // remember to pair it by hand.
  //
  // The cost: the couple of callers that already paired their own richer, ability-specific visual
  // (Curse of Agony's violet mark, Arcane Residue's reused 'frost' ring) now get this generic ring
  // ADDITIONALLY, overlapping at the same spot. Never wrong — both are sourced from the same real
  // numbers — just a little redundant. render/fx.ts's 'zoneBurn'/'zoneSlow' handlers deliberately
  // draw this generic ring lighter (see spawnField's opacityMul) than a hand-authored one, so
  // where it's genuinely new information it still reads clearly, and where it's stacked on an
  // existing ring it just reinforces rather than competing with it.
  game.projectiles.impacts.push({
    pos: pos.clone(),
    kind: (opts.dps ?? 0) > 0 ? 'zoneBurn' : 'zoneSlow',
    aoe: true,
    radius,
    duration,
  });
}

// ---------- shield: flat damage absorb, consumed before HP ----------
// (Tank's Aegis Overflow.) Re-casting before the old shield breaks tops up the remaining amount
// rather than replacing it, and always extends to the longer of the two expiries.

interface ShieldState {
  amount: number;
  until: number;
}

const shields = new WeakMap<PlayerState, ShieldState>();

export function applyShield(caster: PlayerState, game: GameState, amount: number, seconds: number): void {
  const until = game.time + seconds;
  const cur = shields.get(caster);
  const remaining = cur && game.time < cur.until ? cur.amount : 0;
  shields.set(caster, { amount: remaining + amount, until: Math.max(until, cur?.until ?? 0) });
}

/** Consumes shield HP against an incoming hit, returning the damage still left to apply. Called
 *  from sim/classes.ts's takeDamage, after the existing damageReduction multiplier. */
export function consumeShield(caster: PlayerState, game: GameState, incoming: number): number {
  const s = shields.get(caster);
  if (!s || game.time >= s.until || s.amount <= 0 || incoming <= 0) return incoming;
  const absorbed = Math.min(s.amount, incoming);
  s.amount -= absorbed;
  return incoming - absorbed;
}

/** Read-only: HP still absorbed by `caster`'s shield, or 0. (optional ui/hud.ts status row.) */
export function shieldAmountRemaining(caster: PlayerState, game: GameState): number {
  const s = shields.get(caster);
  return s && game.time < s.until ? s.amount : 0;
}

// ---------- thorns: retaliation pulse whenever this caster is hit ----------
// (Tank's Retaliation.) Rate-limited independently of how many attackers hit the caster in the
// same tick, so a swarm of goblins can't chain it into an instant AoE nuke of themselves.

interface ThornsState {
  radius: number;
  damage: number;
  until: number;
  nextPulseAt: number;
}

const THORNS_PULSE_COOLDOWN = 0.4;
const thorns = new WeakMap<PlayerState, ThornsState>();

export function applyThorns(caster: PlayerState, game: GameState, radius: number, damage: number, seconds: number): void {
  thorns.set(caster, { radius, damage, until: game.time + seconds, nextPulseAt: 0 });
}

/** Read-only: is `caster`'s thorns retaliation currently active? (optional ui/hud.ts status row.) */
export function isThornsActive(caster: PlayerState, game: GameState): boolean {
  const t = thorns.get(caster);
  return !!t && game.time < t.until;
}

/** Called from sim/classes.ts's takeDamage whenever the caster actually takes a hit. */
export function pulseThornsIfReady(caster: PlayerState, game: GameState): void {
  const t = thorns.get(caster);
  if (!t || game.time >= t.until || game.time < t.nextPulseAt) return;
  t.nextPulseAt = game.time + THORNS_PULSE_COOLDOWN;
  const r2 = t.radius * t.radius;
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const dx = e.pos.x - caster.pos.x;
    const dz = e.pos.z - caster.pos.z;
    if (dx * dx + dz * dz > r2) continue;
    e.takeDamage(t.damage, game);
  }
}

// ---------- damage sweep: a moving hitbox that follows the caster while flagged ----------
// (Tank's Juggernaut charge — damages everything the charge passes over, not just the landing.)
// Each enemy is only ever hit once per sweep (hitIds), so it reads as "plowed through," not a
// continuous damage-per-second field.

interface SweepState {
  radius: number;
  damage: number;
  hitIds: Set<number>;
  active: boolean;
}

const sweeps = new WeakMap<PlayerState, SweepState>();

export function startDamageSweep(caster: PlayerState, radius: number, damage: number): void {
  sweeps.set(caster, { radius, damage, hitIds: new Set(), active: true });
}

export function stopDamageSweep(caster: PlayerState): void {
  const s = sweeps.get(caster);
  if (s) s.active = false;
}

/** One central tick, called from sim/classes.ts's initClasses system, for every effect above
 *  that needs to act every frame rather than purely reactively (bleed DoT, ground zones, the
 *  moving sweep hitbox). Vulnerability/empower/shield/thorns are all read reactively at the
 *  moment damage happens instead, so they need no per-tick work here. */
export function tickAbilityEffects(dt: number, game: GameState): void {
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const b = bleedState.get(e);
    if (b && game.time < b.until) e.takeDamage(b.dps * dt, game);
  }

  const zones = groundEffectsFor(game);
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    if (game.time >= z.until) {
      zones.splice(i, 1);
      continue;
    }
    if (z.dps <= 0 && z.slowFactor === undefined) continue;
    const r2 = z.radius * z.radius;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - z.pos.x;
      const dz = e.pos.z - z.pos.z;
      if (dx * dx + dz * dz > r2) continue;
      if (z.dps > 0) {
        e.takeDamage(z.dps * dt, game);
        burningUntil.set(e, game.time + BURN_MARK_GRACE);
      }
      if (z.slowFactor !== undefined) applySlow(e, game, z.slowFactor, 0.3);
    }
  }

  for (const p of game.players) {
    const s = sweeps.get(p);
    if (!s || !s.active) continue;
    const r2 = s.radius * s.radius;
    for (const e of game.enemies) {
      if (!e.alive || s.hitIds.has(e.id)) continue;
      const dx = e.pos.x - p.pos.x;
      const dz = e.pos.z - p.pos.z;
      if (dx * dx + dz * dz > r2) continue;
      e.takeDamage(s.damage, game);
      s.hitIds.add(e.id);
    }
  }
}
