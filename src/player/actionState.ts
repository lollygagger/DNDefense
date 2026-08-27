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
};
