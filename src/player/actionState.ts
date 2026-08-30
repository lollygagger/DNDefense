import type { Vector3 } from 'three';

/** Transient, render-facing state about what the local player is physically doing right now:
 *  drawing a bow, mid-grapple, mid-leap. Cosmetic consumers (the first-person viewmodel, FX)
 *  need this every frame, and it does not belong in GameState — it is presentation detail
 *  about one local player, not authoritative gameplay state a server would replicate.
 *
 *  Written by the input/ability layer (player/casting.ts, player/controller.ts, and the
 *  ability `cast()` implementations in data/*.ts). Read-only for everything in src/render.
 *  Same pattern as `playerMotion` in player/controller.ts. */
export const actionState = {
  /** Draw/charge progress, 0 = released, 1 = fully drawn. Drives the bow-draw pose. */
  charge01: 0,
  /** Ability id currently being charged, or null when nothing is being held. */
  chargingId: null as string | null,
  /** game.time of the most recent charged release, so the viewmodel can snap the bowstring
   *  and the FX layer can punch a release effect. Negative = nothing released yet. */
  releasedAt: -1,

  /** Anchor point while a grapple is reeling the player in, else null. Lets the viewmodel
   *  draw a rope from the bow to the hook for the duration of the pull. */
  grappleAnchor: null as Vector3 | null,
  /** True while a leap is airborne, so the viewmodel can hold a tucked/airborne pose. */
  leaping: false,

  /** Ability id currently being hold-to-fire channelled (the Warlock's Soul Siphon), or null.
   *  Generic on purpose — any future class's `channel`-flagged primary would drive the same
   *  field. Written by player/casting.ts on press/release; `channelRamp01`/`channelEndPoint`
   *  are then updated every successful tick by that ability's own sim-side cast() (the same
   *  "write a presentation hint from cast()" precedent the Archer's grappleAnchor already is). */
  channelId: null as string | null,
  /** 0..1 ramp progress on whatever the channel is currently locked onto; 0 while not
   *  channelling or while the beam isn't hitting anything. Drives the viewmodel's charge-up
   *  glow and the Curse of Agony/Soul Siphon "Focused Curse" combo. */
  channelRamp01: 0,
  /** The channel beam's real acquisition radius, in world units — the exact number its hit test
   *  uses, not a presentational stand-in. render/aerialBeam.ts draws the beam's wash at precisely
   *  this width so what you see is what it kills; drawing a token thickness instead is what let a
   *  max-rank beam kill things 9 units off an axis it appeared 0.3 units wide. */
  channelRadius: 1.3,
  /** World-space point the channel beam actually reaches this tick (an enemy hit, a blocked-by-
   *  cover point, or max range) — null while not channelling. Lets the viewmodel draw a beam
   *  from the rig's muzzle to wherever the beam is really landing. */
  channelEndPoint: null as Vector3 | null,
};
