/** Castle balance + geometry constants. Owned by [world-castle]. Keep docs/GAME_DESIGN.md in sync. */

export const WALL_HALF_WIDTH = 20; // walls span x in [-20, 20]
export const WALL_HEIGHT = 6;
// Wall top walkable depth. Was 3 (cramped — barely a strip to run/fight along once an embrasure
// structure sat mid-thickness). Doubled to 6 so the top reads as a proper fighting platform.
// See WALL_Z below for how tier spacing was adjusted to compensate.
export const WALL_THICKNESS = 6;
export const STAIR_LENGTH = 6; // ramps behind each wall at both ends
export const STAIR_HALF_WIDTH = 1.5;
export const STAIR_X = 18; // stair centers at x = ±18

// Tier spacing (center-to-center front-face distance) is 15, up from the original 12 — grown by
// exactly the +3 WALL_THICKNESS increased by, so courtyard depth (spacing - thickness = 15 - 6 =
// 9) is unchanged from before (12 - 3 = 9): the wall got thicker without eating into the
// courtyard the player falls back to and now also shares with the chamber sockets' barracks
// buildings (see CHAMBER_BUILDING_OFFSET below) and PLAYER_SPAWN was already deriving off the
// tier-3 numbers so recomputes automatically.
export const WALL_Z: Record<1 | 2 | 3, number> = { 1: 0, 2: 15, 3: 30 };
export const WALL_HP: Record<1 | 2 | 3, number> = { 1: 600, 2: 600, 3: 1000 };
export const WALL_COST: Record<1 | 2 | 3, number> = { 1: 100, 2: 100, 3: 0 };

export const REPAIR_COST_PER_HP = 0.3;

export const EMBRASURE_XS = [-12, 0, 12]; // static-defense sockets on the front face
export const CHAMBER_XS = [-6, 6]; // spawner sockets inside the wall

// Socket anchor offsets (used by sim/castle.ts to place worldPos/muzzlePos)
export const EMBRASURE_MUZZLE_HEIGHT_FRAC = 0.65; // muzzle at 65% of wall height on the front face
export const EMBRASURE_MUZZLE_FRONT_OFFSET = 0.4; // muzzle sits this far in front of the wall face
// Allies still sortie out the front (muzzlePos), unchanged in meaning: this is how far in front
// of the wall face they emerge. Kept independent of CHAMBER_BUILDING_OFFSET below — the door is
// where allies appear, not where the barracks building sits.
export const CHAMBER_DOOR_FRONT_OFFSET = 1.2; // allies emerge this far in front of the wall face
// The chamber socket's interaction anchor (worldPos) — and therefore the barracks building
// render/structureView.ts places there — now sits on the ground in the courtyard BEHIND the
// wall instead of on top of it, so it stops eating the wall-top fighting space. 3.5 puts the
// building comfortably inside the 9-deep courtyard: ~2.3 units clear between the wall's back
// face and the building (room for the archway landing), ~4.3 units clear behind it before the
// next wall/stair — never touching the stair ramps at x=±18 since chambers sit at x=±6.
export const CHAMBER_BUILDING_OFFSET = 3.5;
// Cosmetic archway opening through the wall at each chamber's x, rendered on both the front and
// back faces (castleView.ts) so the barracks reads as connected to the field by a doorway. Purely
// visual — blocksProjectile in sim/castle.ts deliberately does NOT carve a hole here; the wall
// stays fully solid to projectiles (see docs note in sim/castle.ts). Sized to a proper gate
// rather than a slit: comfortably under WALL_HEIGHT (6) so there's stone above it to the parapet.
export const CHAMBER_ARCH_WIDTH = 2.2;
export const CHAMBER_ARCH_HEIGHT = 3.2;

export const ENEMY_SPAWN_Z = -80;
export const FIELD_MIN_X = -24;
export const FIELD_MAX_X = 24;

export const PLAYER_SPAWN = { x: 0, y: WALL_HEIGHT, z: WALL_Z[3] + WALL_THICKNESS / 2 };

// ---- Castle battlements (render: cosmetic geometry, never affects worldHeight; sim: also
// consulted by sim/castle.ts's blocksProjectile so merlons are real cover, not decoration) ----
export const PARAPET_HEIGHT = 0.4; // low lip along the top front edge, full width, no gaps
export const MERLON_WIDTH = 1.6;
// Player eye height standing on a wall top is WALL_HEIGHT + 1.6 = 7.6. Parapet top sits at
// WALL_HEIGHT + PARAPET_HEIGHT = 6.4. Merlon top = 6.4 + MERLON_HEIGHT = 8.2, a full 0.6 above
// eye level, so a standing player is genuinely hidden behind one (see blocksProjectile in
// sim/castle.ts). Keep this clearing eye level — a merlon that doesn't would be pure decoration.
export const MERLON_HEIGHT = 1.8;
export const MERLON_DEPTH = 0.7;
// Center-to-center spacing between merlons. Crenel (gap) width = MERLON_SPACING - MERLON_WIDTH
// = 4 - 1.6 = 2.4, wide enough to stand in and see/shoot the field. MERLON_SPACING = 4 is also
// chosen so 12 (the embrasure socket x-positions) is an exact multiple of it: with the even
// merlon count render/castleView.ts derives from these same constants, a crenel gap (not a
// merlon) lands exactly on x = 0 and x = ±12 — see docs/ARCHITECTURE.md for the arithmetic.
export const MERLON_SPACING = 4;

// ---- Environment geometry ----
export const ROAD_HALF_WIDTH = 3.5; // dirt approach road from the spawn gate to the castle
export const PROP_MIN_ABS_X = 26; // rocks/trees keep |x| beyond this so they never block enemies
