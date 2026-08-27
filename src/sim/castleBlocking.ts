import { Vector3 } from 'three';
import {
  MERLON_DEPTH,
  MERLON_HEIGHT,
  MERLON_SPACING,
  MERLON_WIDTH,
  PARAPET_HEIGHT,
  WALL_HALF_WIDTH,
  WALL_HEIGHT,
} from '../data/castle';

/** Owned by [world-castle]. Projectile-blocking geometry primitives for sim/castle.ts's
 *  blocksProjectile — split out to keep that file under the ~400-line guideline (same reasoning
 *  sim/structures/*.ts split out of sim/structures.ts, and sim/wallUpgrades.ts split out of this
 *  same castle.ts). Mirrors the cosmetic mesh layout in render/castleView.ts exactly (same
 *  constants, same local z placement) so what the player sees is what actually stops arrows. The
 *  parapet/merlon band sits in front of the wall body, at wall-relative z in
 *  [BAND_FRONT_Z, BAND_BACK_Z] (matches castleView's parapet/merlon local z =
 *  MERLON_DEPTH / 2 - 0.2, +/- half depth). Behind that band, only the plain wall body
 *  (relative z in [BAND_BACK_Z, WALL_THICKNESS], height WALL_HEIGHT) is solid — the open-air
 *  space above the walkable top in the middle of the wall's thickness blocks nothing (matches
 *  the real geometry: no floating stone back there). */
export const BAND_FRONT_Z = -0.2;
export const BAND_BACK_Z = MERLON_DEPTH - 0.2; // 0.5
export const PARAPET_TOP = WALL_HEIGHT + PARAPET_HEIGHT; // 6.4 — continuous, full width, no gaps
export const MERLON_TOP = PARAPET_TOP + MERLON_HEIGHT; // 8.2 — only within a merlon's x-footprint (before any Higher Battlements bonus)
const MERLON_GAP_HALF = (MERLON_SPACING - MERLON_WIDTH) / 2; // 1.2 — half the crenel gap width

/** True if x falls inside a merlon's footprint rather than a crenel gap. Crenel gaps repeat
 *  every MERLON_SPACING, centered on every multiple of it (0, ±MERLON_SPACING, ±2*MERLON_SPACING,
 *  ...) — by construction (render/castleView.ts always builds an even number of merlons,
 *  symmetric about x=0), so with MERLON_SPACING=4 a gap centers exactly on x=0 and x=±12 (the
 *  embrasure sockets). See docs/ARCHITECTURE.md for the full arithmetic. */
export function isMerlonX(x: number): boolean {
  const nearestGapCenter = Math.round(x / MERLON_SPACING) * MERLON_SPACING;
  return Math.abs(x - nearestGapCenter) > MERLON_GAP_HALF;
}

/** Battlement height with no Higher Battlements bonus — the shape every wall uses until that
 *  upgrade is purchased on it (sim/castle.ts caches one of these per wall, rebuilt only when a
 *  wall's upgrades change; see rebuildBattlementFns). */
export function battlementHeightAt(x: number): number {
  if (Math.abs(x) > WALL_HALF_WIDTH) return 0;
  return isMerlonX(x) ? MERLON_TOP : PARAPET_TOP;
}

export function bodyHeightAt(x: number): number {
  return Math.abs(x) > WALL_HALF_WIDTH ? 0 : WALL_HEIGHT;
}

// Scratch vector for blocksProjectile's internal band checks. Reused every call (never
// allocated) — safe because it's written then immediately read before any other call can run
// (single-threaded, no re-entrancy).
export const bandHitScratch = new Vector3();

/** Swept check within one wall-relative z-band [zLo, zHi]: does the segment
 *  (x0,y0,z0)->(x0+dx,y0+dy,z0+dz) dip at/below `heightAt(x)` anywhere its z lies in that band?
 *  Writes the entry point (wall-relative z) into `out` and returns true if so. `heightAt` is a
 *  plain function reference (not a closure) so this allocates nothing. */
export function checkBand(
  x0: number,
  y0: number,
  z0: number,
  dx: number,
  dy: number,
  dz: number,
  zLo: number,
  zHi: number,
  heightAt: (x: number) => number,
  out: Vector3
): boolean {
  let tA: number;
  let tB: number;
  if (dz === 0) {
    if (z0 < zLo || z0 > zHi) return false;
    tA = 0;
    tB = 1;
  } else {
    const t1 = (zLo - z0) / dz;
    const t2 = (zHi - z0) / dz;
    tA = Math.max(0, Math.min(t1, t2));
    tB = Math.min(1, Math.max(t1, t2));
    if (tA > tB) return false;
  }
  const xA = x0 + dx * tA;
  const xB = x0 + dx * tB;
  const yA = y0 + dy * tA;
  const yB = y0 + dy * tB;
  const h = heightAt((xA + xB) / 2);
  if (h <= 0 || Math.min(yA, yB) > h) return false;
  out.set(xA, Math.min(yA, h), z0 + dz * tA);
  return true;
}
