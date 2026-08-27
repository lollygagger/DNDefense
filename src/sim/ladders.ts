import type { Phase, Wall, WallTier } from './types';
import {
  LADDER_REACH_X,
  LADDER_REACH_Z,
  LADDER_STANDOFF,
  LADDER_TOP_INSET,
  LADDER_XS,
  WALL_HEIGHT,
  WALL_THICKNESS,
} from '../data/castle';

/** Owned by [world-castle]. Ladder geometry + the "is there a usable ladder here" query — split
 *  out of sim/castle.ts to keep that file under the ~400-line guideline (same reasoning
 *  sim/castleBlocking.ts and sim/wallUpgrades.ts were split out for).
 *
 *  Two grab-points per wall (see LADDER_XS in data/castle.ts for why those x's), each with a
 *  front (field-facing) and back (courtyard-facing) ladder. Back ladders are always usable —
 *  they're the whole point of this feature: getting up onto your own wall without a detour to
 *  the stair ramps at x=±STAIR_X. Front ladders are build-phase-only: the player can sally out
 *  into the open field and needs a way back in, but a climbable front face during combat would
 *  be a free path onto a wall a wave is actively hitting. isLadderUsable() is the one place that
 *  gate lives, so sim/castle.ts's ladderAt() and this module's own findLadderAt() can never
 *  disagree about it.
 *
 *  Deliberately NOT part of worldHeight()/blocksProjectile: a ladder is a climb-mode trigger, not
 *  walkable terrain or a projectile obstruction — see player/controller.ts for the movement side
 *  and docs/ARCHITECTURE.md's battlements note for why worldHeight stays a pure height field. */

export type LadderFace = 'front' | 'back';

export interface LadderInfo {
  x: number;
  tier: WallTier;
  face: LadderFace;
  /** World z of the flush wall face the ladder is mounted against. */
  faceZ: number;
  /** World z the player is held at while climbing — a small standoff off the face (see
   *  LADDER_STANDOFF) so they don't clip into the stone. */
  climbZ: number;
  /** World z to land at when stepping off at the top, safely inside the wall-top walkway rather
   *  than right on the parapet/merlon band or the lip (see LADDER_TOP_INSET). */
  dismountZ: number;
  /** Climb ceiling — always WALL_HEIGHT today, but read from here rather than hardcoded so a
   *  future per-wall height change can't silently desync the two. */
  topY: number;
}

/** Pure geometry for one (wall, x, face) grab-point — independent of build/combat state, which
 *  is why it takes a bare Wall (for .tier/.z) rather than needing the full Castle. */
function ladderInfoFor(wall: Wall, x: number, face: LadderFace): LadderInfo {
  if (face === 'front') {
    const faceZ = wall.z;
    return { x, tier: wall.tier, face, faceZ, climbZ: faceZ - LADDER_STANDOFF, dismountZ: faceZ + LADDER_TOP_INSET, topY: WALL_HEIGHT };
  }
  const faceZ = wall.z + WALL_THICKNESS;
  return { x, tier: wall.tier, face, faceZ, climbZ: faceZ + LADDER_STANDOFF, dismountZ: faceZ - LADDER_TOP_INSET, topY: WALL_HEIGHT };
}

/** Every ladder a wall offers (front + back, both LADDER_XS positions), regardless of whether
 *  each one is currently usable — for render/castleView.ts to build meshes from once at
 *  construction time. Not used by the hot per-tick query below (findLadderAt), which inlines the
 *  same math to stay allocation-free; see that function's doc comment. */
export function ladderGeometryForWall(wall: Wall): LadderInfo[] {
  const out: LadderInfo[] = [];
  for (const x of LADDER_XS) {
    out.push(ladderInfoFor(wall, x, 'front'));
    out.push(ladderInfoFor(wall, x, 'back'));
  }
  return out;
}

/** True if this ladder can be grabbed/climbed right now. Back ladders always are; a front ladder
 *  isn't during combat — see this module's doc comment for why. */
export function isLadderUsable(ladder: Pick<LadderInfo, 'face'>, phase: Phase): boolean {
  return ladder.face === 'back' || phase !== 'combat';
}

/** Finds the ladder (if any) whose grab-zone contains world point (x, y, z) right now — the
 *  single source of truth player/controller.ts consults both to START a climb (approaching a
 *  wall face on foot) and to RE-VALIDATE one every tick already in progress (a front ladder can
 *  stop being usable out from under a climbing player — see the controller's tickClimb). Checks
 *  wall built/intact state and isLadderUsable()'s phase gate inline rather than via
 *  ladderGeometryForWall, so a non-matching wall/x/face is rejected before any LadderInfo object
 *  is even constructed — cheap enough to call every controller tick. */
export function findLadderAt(walls: Wall[], phase: Phase, x: number, y: number, z: number): LadderInfo | null {
  for (const wall of walls) {
    if (!wall.built || wall.hp <= 0) continue;
    for (const lx of LADDER_XS) {
      if (Math.abs(x - lx) > LADDER_REACH_X) continue;
      for (const face of ['front', 'back'] as const) {
        if (face === 'front' && phase === 'combat') continue;
        const ladder = ladderInfoFor(wall, lx, face);
        if (Math.abs(z - ladder.climbZ) > LADDER_REACH_Z) continue;
        if (y < -0.5 || y > ladder.topY + 0.5) continue;
        return ladder;
      }
    }
  }
  return null;
}
