import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { Enemy, PlayerClassDef, PlayerState } from '../sim/types';
import type { AbilityWithTree } from '../sim/abilityTree';
import { flyPlayer } from '../player/controller';
import { actionState } from '../player/actionState';
import { applyStun } from '../sim/status';
import { applyVulnerability, spawnGroundEffect, vulnerabilityMultiplier } from '../sim/abilityEffects';
import { abyssalGraspTree, curseOfAgonyTree, soulSiphonTree, umbralFlightTree } from './warlockTree';

/** Warlock class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  Identity: a second caster, but sustained and committed where the Mage is burst artillery —
 *  the primary is a channelled beam that hits harder the longer it stays locked on ONE target,
 *  at a medium range (shorter than the Archer's reach, longer than the Warrior's melee) with a
 *  real movement penalty while held. Losing the lock (target dies, you look away, cover blocks
 *  the shot, or you let go) resets the ramp, so the whole kit rewards standing your ground and
 *  punishes constantly repositioning — the opposite tension from the Mage's poke-and-move bolt.
 *  Curse of Agony and Abyssal Grasp both exist to protect that commitment (a debuff that pays
 *  off the beam, a rift that roots a target still), and Umbral Flight resolves the tension a
 *  different way again: rather than an escape valve, it buys a position a melee horde simply
 *  cannot reach, so the commitment can continue instead of being abandoned. cast() implementations are sim-side only: hitscan + state, no
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

/** Base acquisition radius of the beam: how far off-centre an enemy can be and still be caught
 *  by the hitscan. Matches the perpendicular-distance radius pinningShot/piercingShot's
 *  mark-check use. Now a per-rank `beamRadius` stat rather than a fixed constant (rank V widens
 *  it), but the base value stays here because the render layer needs a reference to express the
 *  beam's on-screen girth as a multiple of "normal" — see actionState.channelGirth below. */
const BEAM_BASE_RADIUS = 1.3;
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
    { cost: 0, stats: { dps: 30, range: 25, beamRadius: BEAM_BASE_RADIUS, tickInterval: 0.15, rampTime: 3, rampBonusPct: 80, channel: 1, moveSpeedMult: 0.6 } },
    { cost: 40, stats: { dps: 46 } },
    { cost: 80, stats: { dps: 66 } },
    { cost: 140, stats: { dps: 92 } },
    // Rank V (late-game gold sink, unlocks behaviour): "Soul Drain" — once a target is fully
    // ramped, a third of the damage you're already dealing comes back as healing. Nothing new to
    // aim or press; a well-held beam simply starts sustaining you too.
    //
    // It also widens the beam (1.3 -> 2.2) and reaches 5 further (25 -> 30). Both serve the same
    // end as the lifesteal: the ramp is the whole ability, and everything that breaks the lock —
    // a target sidestepping out of a narrow beam, or walking just past the edge of your reach —
    // resets it to zero. A wider, longer beam doesn't hit more enemies at once (the hitscan still
    // locks the single nearest one, by design), it makes the lock you already have much harder to
    // lose, which is where a maxed channel's damage actually comes from.
    { cost: 220, stats: { dps: 118, lifestealPct: 35, beamRadius: 2.2, range: 30 } },
  ],
  tree: soulSiphonTree,
  cast(game: GameState, caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const dir = aimPoint.clone().sub(origin);
    const len = dir.length();
    if (len < 1e-4) dir.set(0, 0, -1);
    else dir.divideScalar(len);

    const range = stats.range;
    const beamRadius = stats.beamRadius ?? BEAM_BASE_RADIUS;
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
      const rr = beamRadius + e.radius;
      if (perpSq > rr * rr) continue;
      if (t < bestT) {
        bestT = t;
        best = e;
      }
    }

    // Target lock + ramp: see ChannelLock's doc comment for why a stale gap resets it, not just
    // a changed target.
    //
    // A KILL CARRIES THE RAMP; ABANDONING A LIVE TARGET DOES NOT. Resetting on every target change
    // made the ramp self-defeating at the ranks that matter: rank V's 118 dps kills anything weak
    // in well under the 3s ramp time, so chewing through a swarm reset progress on every kill and
    // the ramp never completed. That silently disabled rank V's own lifesteal, which is gated on a
    // full ramp — the rank's damage half cancelling its lifesteal half. Measured before this fix:
    // 20s of channelling, 27 kills, zero healing.
    //
    // So the beam stays hot when its target dies and it rolls straight onto the next one — you
    // were channelling the whole time, you just succeeded. Swinging the beam onto a different
    // *living* enemy is still a voluntary abandonment and still resets, which is what keeps the
    // "commit to one target" identity the whole kit is built around.
    const hitId = best?.id ?? null;
    const staleGap = stats.tickInterval * 2.5;
    const prior = channelLocks.get(caster);
    let lock: ChannelLock;
    if (!prior || game.time - prior.lastTickAt > staleGap) {
      lock = { targetId: hitId, rampStart: game.time, lastTickAt: game.time };
    } else if (prior.targetId !== hitId) {
      const prev = prior.targetId === null ? null : game.enemies.find((e) => e.id === prior.targetId);
      const priorTargetDied = prior.targetId !== null && (!prev || !prev.alive);
      lock = {
        targetId: hitId,
        rampStart: priorTargetDied ? prior.rampStart : game.time,
        lastTickAt: game.time,
      };
    } else {
      lock = prior;
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
    // Presentation girth as a multiple of the base beam, so a widened rank-V beam actually looks
    // wider instead of the upgrade being invisible. Deliberately proportional rather than the raw
    // radius: 1.3 world units of acquisition tolerance drawn literally would be a tube, not a beam.
    actionState.channelGirth = beamRadius / BEAM_BASE_RADIUS;

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

/** Mobility: a short window of actual FLIGHT — gravity off, full movement control, rising while
 *  Space is held. This is the one mobility ability in the game that isn't a fixed trajectory
 *  (see player/controller.ts's flyPlayer, the fourth movement shape alongside teleport/launch/
 *  pull), and the kit is why: every other class repositions to somewhere and resumes fighting,
 *  whereas the Warlock's whole identity is standing still and channelling. Flight lets it pick
 *  the one position a melee horde can't answer — directly above them — and hold it for the few
 *  seconds Soul Siphon needs to ramp. The horde is the terrain the Warlock plays around.
 *
 *  Deliberately a committed window, not an escape: an absolute ceiling (so taking off from a wall
 *  top can't stack height) and a long cooldown. Space climbs and Shift drops — full vertical
 *  control — but the window itself is fixed, so descending early spends the remaining time rather
 *  than saving it. Every cast is still a decision about where you want to be a few seconds from now.
 *  Ranks buy duration only — the fantasy scales by getting longer, not by flying higher. */
const UMBRAL_FLIGHT_COOLDOWN = 16;

const umbralFlight: AbilityWithTree = {
  id: 'umbralFlight',
  name: 'Umbral Flight',
  desc: 'Unfurl wings of shadow and leave the ground behind. Hold Space to climb and Shift to drop, drift freely while it lasts, and channel on the horde from somewhere their blades will never reach. When it ends, you fall.',
  icon: '🦇',
  targeting: 'aimed',
  cooldown: UMBRAL_FLIGHT_COOLDOWN,
  // No castRange: it's documented as the max GROUND-target distance, and this is a self-cast that
  // ignores its aim point entirely (directional/instant, like the Warrior's Leap).
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { duration: 3.2, ceiling: 11 } },
    { cost: 40, stats: { duration: 3.9, ceiling: 11 } },
    { cost: 80, stats: { duration: 4.6, ceiling: 12 } },
    { cost: 140, stats: { duration: 5.4, ceiling: 12 } },
  ],
  tree: umbralFlightTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, _aimPoint: Vector3, stats: Record<string, number>) {
    // Directional/instant like the Warrior's Leap: no reticle, no aim point — pressing the key
    // takes off from wherever you stand.
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'umbralFlight', aoe: false });

    if (stats.downdraftDamage) {
      // Dread Takeoff: the downdraft as you launch hammers everything beneath you and drags it
      // inward. The point isn't the damage — it's that the horde ends up clumped directly under
      // the spot you're about to hover over, which is exactly the shape Soul Siphon wants.
      const r2 = stats.downdraftRadius * stats.downdraftRadius;
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - caster.pos.x;
        const dz = e.pos.z - caster.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        e.takeDamage(stats.downdraftDamage, game);
        const dist = Math.sqrt(d2);
        if (dist > 0.05 && stats.downdraftPull) {
          const pull = Math.min(stats.downdraftPull, dist);
          const s = pull / dist;
          e.pos.x -= dx * s;
          e.pos.z -= dz * s;
        }
      }
      game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'grasp', aoe: true, radius: stats.downdraftRadius });
    }

    flyPlayer(stats.duration, stats.ceiling, () => {
      game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'umbralFlight', aoe: false });
    });
  },
};

export const WARLOCK: PlayerClassDef = {
  id: 'warlock',
  name: 'Warlock',
  desc: 'Channeler of forbidden power: a sustained beam that hits harder the longer it stays locked on, backed by curses, binding chains, and wings of shadow.',
  maxHp: 100,
  moveSpeed: 6,
  primary: soulSiphon,
  abilities: [curseOfAgony, abyssalGrasp, umbralFlight],
};
