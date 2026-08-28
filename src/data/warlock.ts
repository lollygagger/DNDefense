import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { Enemy, PlayerClassDef, PlayerState } from '../sim/types';
import type { AbilityWithTree } from '../sim/abilityTree';
import { clampToPlayfield, resetFall } from '../player/controller';
import { actionState } from '../player/actionState';
import { applyStun } from '../sim/status';
import { applyVulnerability, spawnGroundEffect, vulnerabilityMultiplier } from '../sim/abilityEffects';
import { abyssalGraspTree, curseOfAgonyTree, soulSiphonTree, voidstepTree } from './warlockTree';

/** Warlock class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  Identity: a second caster, but sustained and committed where the Mage is burst artillery —
 *  the primary is a channelled beam that hits harder the longer it stays locked on ONE target,
 *  at a medium range (shorter than the Archer's reach, longer than the Warrior's melee) with a
 *  real movement penalty while held. Losing the lock (target dies, you look away, cover blocks
 *  the shot, or you let go) resets the ramp, so the whole kit rewards standing your ground and
 *  punishes constantly repositioning — the opposite tension from the Mage's poke-and-move bolt.
 *  Curse of Agony and Abyssal Grasp both exist to protect that commitment (a debuff that pays
 *  off the beam, a rift that roots a target still), and Voidstep is the escape valve when
 *  commitment stops paying off. cast() implementations are sim-side only: hitscan + state, no
 *  rendering — the beam's cover-check reaches game.castle through the same narrow local
 *  interface + cast that sim/projectiles.ts uses (see docs/ARCHITECTURE.md), never through the
 *  frozen CastleApi. Every ability also carries a late-game "Mastery" tree (data/warlockTree.ts)
 *  hanging off its linear ranks. */

// ---------- channelling mechanism ----------
// Generic on the input side (player/casting.ts): any ability whose current-rank stats include a
// truthy `channel` flag turns LMB into hold-to-fire-continuously starting immediately (no draw),
// re-casting every tick for as long as it's held, throttled purely by this ability's own
// `cooldown` — exactly the same "tryCast's cooldown gates the actual rate" trick the Archer's
// autoFire already uses, just starting on press instead of after a full draw. Everything below
// this line (the ramp, the target lock, cover, lifesteal) is Warlock-specific and lives entirely
// in this file, same as autoFire's chain-lightning/cannonball specifics live in archer.ts.

/** Narrow view of the castle sim needed for the beam's cover check — not part of the frozen
 *  CastleApi (types.ts); reached via a local interface + cast, the exact pattern
 *  sim/projectiles.ts's muzzlePoint() uses. A beam that poured through your own battlements
 *  would contradict the whole "cover matters" mechanic the castle design rests on. */
interface CastleBlocking {
  blocksProjectile(from: Vector3, to: Vector3, outHit: Vector3): boolean;
}

const BEAM_HIT_RADIUS = 1.3; // matches the perpendicular-distance hitscan radius pinningShot/piercingShot's mark-check use
const hitScratch = new Vector3(); // module-scope: the beam ticks every ~0.15s, never allocate in that path

/** Per-caster "am I still locked onto the same target, uninterrupted?" state — PlayerState
 *  (sim/types.ts) is FROZEN and has no room for this, so it lives here the same WeakMap-off-to-
 *  the-side way every other Mastery/combat side-effect does (see sim/classes.ts's
 *  damageReduction, data/tank.ts's stunFatigue). Reset whenever the hit target changes OR
 *  whenever real time between ticks exceeds a couple of tick intervals — the second condition is
 *  what makes releasing-then-repressing on the very same enemy correctly restart the ramp instead
 *  of picking up where a stale lock left off. */
interface ChannelLock {
  targetId: number | null;
  rampStart: number;
  lastTickAt: number;
}
const channelLocks = new WeakMap<PlayerState, ChannelLock>();

const soulSiphon: AbilityWithTree = {
  id: 'soulSiphon',
  name: 'Soul Siphon',
  desc: 'Channel a beam of eldritch power at medium range. Hold it on one target and it hits harder the longer it stays locked on — lose the lock and the ramp resets.',
  icon: '🩸',
  targeting: 'aimed',
  cooldown: 0.15, // the beam's own tick interval — see the `channel` doc comment above
  ranks: [
    // Base rank carries every constant the higher ranks don't restate: medium range (shorter
    // than the Archer's reach, longer than the Warrior's melee — close enough that cover and
    // enemy melee both matter, unlike the Mage's safer bolt range), the tick interval itself
    // (read back out in cast() so a future retune of the cooldown can't silently desync the
    // dps->per-tick-damage conversion), and the ramp shape.
    { cost: 0, stats: { dps: 30, range: 25, tickInterval: 0.15, rampTime: 3, rampBonusPct: 80, channel: 1, moveSpeedMult: 0.6 } },
    { cost: 40, stats: { dps: 46 } },
    { cost: 80, stats: { dps: 66 } },
    { cost: 140, stats: { dps: 92 } },
    // Rank V (late-game gold sink, unlocks behaviour): "Soul Drain" — once a target is fully
    // ramped, a third of the damage you're already dealing comes back as healing. Nothing new to
    // aim or press; a well-held beam simply starts sustaining you too.
    { cost: 220, stats: { dps: 118, lifestealPct: 35 } },
  ],
  tree: soulSiphonTree,
  cast(game: GameState, caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const dir = aimPoint.clone().sub(origin);
    const len = dir.length();
    if (len < 1e-4) dir.set(0, 0, -1);
    else dir.divideScalar(len);

    const range = stats.range;
    const far = origin.clone().addScaledVector(dir, range);
    const castle = game.castle as unknown as CastleBlocking;
    let maxDist = range;
    if (castle.blocksProjectile(origin, far, hitScratch)) {
      maxDist = origin.distanceTo(hitScratch);
    }

    let best: Enemy | null = null;
    let bestT = Infinity;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const toE = e.pos.clone().sub(origin);
      const t = toE.dot(dir);
      if (t < 0 || t > maxDist) continue;
      const perpSq = toE.lengthSq() - t * t;
      const rr = BEAM_HIT_RADIUS + e.radius;
      if (perpSq > rr * rr) continue;
      if (t < bestT) {
        bestT = t;
        best = e;
      }
    }

    // Target lock + ramp: see ChannelLock's doc comment for why a stale gap resets it, not just
    // a changed target.
    const hitId = best?.id ?? null;
    const staleGap = stats.tickInterval * 2.5;
    let lock = channelLocks.get(caster);
    if (!lock || lock.targetId !== hitId || game.time - lock.lastTickAt > staleGap) {
      lock = { targetId: hitId, rampStart: game.time, lastTickAt: game.time };
    } else {
      lock.lastTickAt = game.time;
    }
    channelLocks.set(caster, lock);

    const heldFor = hitId !== null ? game.time - lock.rampStart : 0;
    const ramp01 = Math.min(1, heldFor / stats.rampTime);
    const endPoint = best ? origin.clone().addScaledVector(dir, bestT) : maxDist < range ? hitScratch.clone() : far;

    // Presentation-only side channel for the viewmodel/beam FX — cast() is sim-only, but writing
    // to actionState (not the scene/DOM) from here is the exact precedent the Archer's Grapple
    // Hook already establishes (it sets actionState.grappleAnchor directly from its own cast()).
    actionState.channelRamp01 = ramp01;
    actionState.channelEndPoint = endPoint;

    if (best) {
      const rampMult = 1 + ramp01 * ((stats.rampBonusPct ?? 0) / 100);
      const dmg = stats.dps * stats.tickInterval * rampMult * vulnerabilityMultiplier(best, game);
      best.takeDamage(dmg, game);

      const lifestealPct = stats.lifestealPct ?? 0;
      if (lifestealPct > 0 && (stats.lifestealAlways || ramp01 >= 1)) {
        caster.hp = Math.min(caster.maxHp, caster.hp + dmg * (lifestealPct / 100));
      }
      if (stats.residueDps && ramp01 >= 1) {
        // Withering/Blighted Beam: a lingering burn at the target's current position, using the
        // exact same generic ground-effect helper Mage's Volcanic Rupture/Killing Frost use —
        // "spreads to nearby enemies" at the higher rank is just a bigger residueRadius, no new
        // mechanism needed.
        spawnGroundEffect(game, best.pos, stats.residueRadius ?? 1, stats.residueDuration ?? 2, { dps: stats.residueDps });
      }
      game.projectiles.impacts.push({ pos: endPoint.clone(), kind: 'soulSiphon', aoe: false });
    }
  },
};

// ---- Focused Curse (skill combo: cast Curse of Agony while Soul Siphon is locked on) ----
// Hotkey abilities never interrupt the channel (player/casting.ts doesn't cancel it for any
// reason except release/menu/death/phase-change), so a player who knows the kit can hold the
// beam and weave Curse of Agony in with the other hand. This reads the LIVE channel ramp exactly
// the way the Archer's Steady Aim reads a live bow draw (piercingShot in archer.ts) — the same
// shape, reused for a different class's channel instead of a draw. Costs nothing but knowing you
// can do it; a Curse cast with no channel running (or one that just started) gets none of it.
const FOCUSED_CURSE_MAX_BONUS = 0.5; // +50% at a fully-ramped lock — the same number Steady Aim uses

const curseOfAgony: AbilityWithTree = {
  id: 'curseOfAgony',
  name: 'Curse of Agony',
  desc: "Wrack an area with agony: a damage-over-time curse that marks everything it touches to take extra damage from your whole kit. Cast it while your beam is fully locked on and the curse hits harder.",
  icon: '☠️',
  targeting: 'ground',
  cooldown: 9,
  castRange: 45,
  ranks: [
    { cost: 0, stats: { radius: 5, dps: 14, duration: 5, vulnPct: 20 } },
    { cost: 40, stats: { dps: 20 } },
    { cost: 80, stats: { dps: 28, radius: 5.5 } },
    { cost: 140, stats: { dps: 38, duration: 6, vulnPct: 30, radius: 6 } },
  ],
  tree: curseOfAgonyTree,
  cast(game: GameState, _caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const focusRamp = actionState.channelId === 'soulSiphon' ? actionState.channelRamp01 : 0;
    const focusMult = 1 + FOCUSED_CURSE_MAX_BONUS * focusRamp;
    const dps = stats.dps * focusMult;
    const vulnPct = stats.vulnPct * focusMult;

    spawnGroundEffect(game, aimPoint, stats.radius, stats.duration, { dps });
    const r2 = stats.radius * stats.radius;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - aimPoint.x;
      const dz = e.pos.z - aimPoint.z;
      if (dx * dx + dz * dz > r2) continue;
      applyVulnerability(e, game, 1 + vulnPct / 100, stats.duration);
      if (stats.slowPct) {
        e.slowFactor = 1 - stats.slowPct / 100;
        e.slowUntil = game.time + stats.duration;
      }
    }
    game.projectiles.impacts.push({ pos: aimPoint.clone(), kind: 'curse', aoe: true, radius: stats.radius, duration: stats.duration });
  },
};

/** Ground-target utility/control: yanks everything nearby together and roots it in place — the
 *  stillness a channel actually wants, bought at range instead of hoped for. Deliberately not
 *  "Frost Field with different numbers": the payoff is clustering + a hard root option (via its
 *  Mastery branch), not just an area slow. */
const abyssalGrasp: AbilityWithTree = {
  id: 'abyssalGrasp',
  name: 'Abyssal Grasp',
  desc: 'Rip open a rift that drags nearby enemies together and roots them in place — the stillness your beam needs.',
  icon: '⛓️',
  targeting: 'ground',
  cooldown: 12,
  castRange: 45,
  ranks: [
    { cost: 0, stats: { radius: 5, pullAmount: 3, slowPct: 60, duration: 2 } },
    { cost: 40, stats: { pullAmount: 3.6, slowPct: 68 } },
    { cost: 80, stats: { pullAmount: 4.2, slowPct: 76, duration: 2.5 } },
    { cost: 140, stats: { radius: 6, pullAmount: 5, slowPct: 85, duration: 3 } },
  ],
  tree: abyssalGraspTree,
  cast(game: GameState, _caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const r2 = stats.radius * stats.radius;
    const slowFactor = 1 - stats.slowPct / 100;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - aimPoint.x;
      const dz = e.pos.z - aimPoint.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const dist = Math.sqrt(d2);
      if (dist > 0.05) {
        const pull = Math.min(stats.pullAmount, dist);
        const s = pull / dist;
        e.pos.x -= dx * s;
        e.pos.z -= dz * s;
      }
      e.slowFactor = slowFactor;
      e.slowUntil = game.time + stats.duration;
      if (stats.stunDuration) applyStun(e, game, stats.stunDuration);
      if (stats.damage) e.takeDamage(stats.damage, game);
    }
    game.projectiles.impacts.push({ pos: aimPoint.clone(), kind: 'grasp', aoe: true, radius: stats.radius, duration: stats.duration });
  },
};

/** Mobility: a short instant teleport, the same physical shape as the Mage's Blink (per
 *  docs/GAME_DESIGN.md's mobility note, reusing one of the three sanctioned shapes is expected —
 *  distinctiveness comes from the kit around it, not from inventing new movement code). Shorter
 *  base range than Blink and a longer cooldown, since the Warlock leans on standing its ground
 *  and channelling rather than constant repositioning; its Mastery branch can trade that back for
 *  either a banked second charge or an aggressive arrival nova, same shape as Blink's own tree. */
const VOIDSTEP_COOLDOWN = 14;
const voidCharges = new WeakMap<PlayerState, { charges: number; lastRegenAt: number }>();

const voidstep: AbilityWithTree = {
  id: 'voidstep',
  name: 'Voidstep',
  desc: 'Tear a short path through the void and step out the other side — even straight onto a wall top.',
  icon: '🕳️',
  targeting: 'ground',
  cooldown: VOIDSTEP_COOLDOWN,
  castRange: 22,
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { range: 16 } },
    { cost: 40, stats: { range: 18 } },
    { cost: 80, stats: { range: 20 } },
    { cost: 140, stats: { range: 22 } },
  ],
  tree: voidstepTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const { x, z } = clampToPlayfield(game, aimPoint.x, aimPoint.z);
    const y = game.castle.worldHeight(x, z);
    const departure = caster.pos.clone();

    game.projectiles.impacts.push({ pos: departure, kind: 'voidstep', aoe: false });
    caster.pos.set(x, y, z);
    resetFall();
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'voidstep', aoe: false });

    if (stats.collapseDamage) {
      // Void Collapse/Implosion: the void erupts where you ARRIVE (not where you left, unlike
      // Mage's Arcane Rebound) — an aggressive re-engage instead of a defensive parting shot.
      const r2 = stats.collapseRadius * stats.collapseRadius;
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - caster.pos.x;
        const dz = e.pos.z - caster.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        e.takeDamage(stats.collapseDamage, game);
        const dist = Math.sqrt(d2);
        if (dist > 0.05 && stats.collapsePull) {
          const pull = Math.min(stats.collapsePull, dist);
          const s = pull / dist;
          e.pos.x -= dx * s;
          e.pos.z -= dz * s;
        }
      }
      game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'grasp', aoe: true, radius: stats.collapseRadius });
    }

    const maxCharges = Math.round(stats.charges ?? 1);
    if (maxCharges > 1) {
      // Echoing/Doubled Step: identical banked-charge mechanism to Mage's Blink Cascade — see
      // mage.ts's blink cast() for the reasoning behind refunding the just-set cooldown instead
      // of granting a parallel one.
      const now = game.time;
      let cs = voidCharges.get(caster);
      if (!cs) cs = { charges: maxCharges, lastRegenAt: now };
      const regenInterval = VOIDSTEP_COOLDOWN / maxCharges;
      const regened = Math.floor((now - cs.lastRegenAt) / regenInterval);
      if (regened > 0) {
        cs.charges = Math.min(maxCharges, cs.charges + regened);
        cs.lastRegenAt += regened * regenInterval;
      }
      if (cs.charges > 0) {
        cs.charges -= 1;
        caster.cooldowns['voidstep'] = now;
      }
      voidCharges.set(caster, cs);
    }
  },
};

export const WARLOCK: PlayerClassDef = {
  id: 'warlock',
  name: 'Warlock',
  desc: 'Channeler of forbidden power: a sustained beam that hits harder the longer it stays locked on, backed by curses, binding chains, and a step through the void.',
  maxHp: 100,
  moveSpeed: 6,
  primary: soulSiphon,
  abilities: [curseOfAgony, abyssalGrasp, voidstep],
};
