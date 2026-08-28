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

/** Percent of everything sunk into a structure — its build cost plus every upgrade node bought
 *  for it — handed back when you sell it. Half, deliberately: enough that committing to a
 *  crossbow early never locks you out of the flamethrower you'd rather have there by wave 15,
 *  but a real loss, so a socket choice still costs something. It also has to stay below 100 for
 *  a structural reason, not just a balance one — at 100 you could freely sell every structure
 *  before each wave and rebuild the perfect counter-composition afterwards, and the socket
 *  decisions the whole build phase is made of would stop being decisions. */
export const STRUCTURE_SELL_REFUND_PCT = 50;

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

// ---- Purchasable extra sockets (late-game castle expansion — sim/wallUpgrades.ts) ----
// Positions stay on the existing merlon grid for embrasures (multiples of MERLON_SPACING, same
// rule EMBRASURE_XS follows) so a new embrasure always opens onto a real crenel gap rather than
// a slab of solid merlon. x=±4 is a valid gap center too but is deliberately skipped: it sits
// only ~0.6 clear of the chamber archways at x=±6 (CHAMBER_ARCH_WIDTH/2 + the frame lintel's
// 0.3 overhang = 1.4 of required clearance from x=6). x=±16 is the next gap out from the
// existing ±12 pair, keeping the same 4-unit rhythm with a comfortable ~2.9-unit margin to every
// neighboring socket marker.
export const EXTRA_EMBRASURE_XS = [-16, 16]; // continues EMBRASURE_XS's index sequence: 3, 4

// Chamber extras sit on the ground behind the wall, not the crenellated top, so they don't need
// merlon-grid alignment — just clearance from the existing chamber buildings (±6, ~1.3 half-width
// each, see render/structureView.ts's fortBaseGeo) and the embrasure sockets on either side (±12,
// then ±16). x=±9.5 splits the ~4.15-unit gap between those two neighbors evenly, leaving roughly
// 0.65-0.9 clear on each side — tight enough to read as "the wall is full" once maxed out, never
// literally overlapping.
export const EXTRA_CHAMBER_XS = [-9.5, 9.5]; // continues CHAMBER_XS's index sequence: 2, 3

// ---- Wall upgrade tree (sim/wallUpgrades.ts) — per-wall, purchasable, independent of the
// structures socketed onto it. Higher ranks replace rather than stack, the same "total, not
// additive" convention every structure's upgrade tree already uses (see data/structures.ts).
// Costs escalate faster than a structure's own upgrades: a wall upgrade benefits everything
// socketed on that wall for the rest of the run, and this tree is the designated late-game gold
// sink once a wall's sockets are all built and maxed (docs/ROADMAP.md Phase 2).
export const WALL_UPGRADES = {
  // Reinforced Stone: flat % damage resistance against incoming wall damage (every source funnels
  // through Castle.damageWall — enemy melee/ranged wallDps and flyer siege bursts alike), so it
  // scales against big single hits the way flat extra HP never would.
  reinforced1: { cost: 180, reductionPct: 0.2 },
  reinforced2: { cost: 320, reductionPct: 0.35 }, // total, replaces reinforced1
  // Machicolations: the wall itself pours damage on enemies hugging its base — the ground-level
  // blind spot no embrasure structure is aimed at. Rank II adds a scald-and-slow.
  machicolations1: { cost: 220, dps: 8, range: 3.5 },
  machicolations2: { cost: 380, dps: 20, range: 4, slowPct: 0.3, slowDuration: 2 }, // total, replaces machicolations1
  // Higher Battlements: taller merlons (this wall only) deepen the existing cover mechanic —
  // more of a diving flyer's low pass, or a skeleton archer's shot, gets blocked by stone.
  battlements1: { cost: 200, merlonBonus: 1.0 },
  battlements2: { cost: 350, merlonBonus: 2.0 }, // total, replaces battlements1
  // Standing Repair Crew: free HP regen, intermission-only — distinct from the Field Hospital
  // engineer's combat-phase repair (capped, requires a built chamber structure); this is a
  // wall-level passive that works even on a wall with nothing built on it at all.
  autoRepair: { cost: 260, hpPerSec: 15 },
  // Expansion branch costs — no stat payload, sim/castle.ts's upgradeWall() special-cases these
  // ids (via wallUpgrades.ts's extraSocketSpecFor) to also push a brand-new Socket.
  extraEmbrasure1: { cost: 320 },
  extraEmbrasure2: { cost: 500 },
  extraChamber1: { cost: 420 },
  extraChamber2: { cost: 650 },
};

// Machicolations only threaten enemies actually at ground level hugging the wall's base — a
// small height gate keeps flying enemies (balloon cruise altitude 10, dragon cruise 9.5, dragon
// dive 6.5 — see data/enemies.ts's FLYER_AI) immune to what's explicitly a base-of-the-wall
// mechanic, without sim/wallUpgrades.ts needing to import isFlyerDef/data/enemies.ts at all.
export const MACHICOLATION_MAX_DY = 2.5;

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

// ---- Ladders (Phase 3 roadmap: QoL climb points on every wall, sim/ladders.ts) ----
// Two grab-points per wall, mirrored front (field-facing, build-phase-only — see sim/ladders.ts)
// and back (courtyard-facing, always available) at the same x, so a player never has to detour
// to the stair ramps at x=±STAIR_X just to get back on top of their own wall. x=-8/+8 sit on the
// same crenel-gap grid EMBRASURE_XS/EXTRA_EMBRASURE_XS use (every multiple of MERLON_SPACING=4
// is a gap, never a merlon — see docs/ARCHITECTURE.md's merlon arithmetic), so a front ladder
// always climbs up through open air, never into solid stone, with clean margins everywhere
// else: 4 units clear of the embrasure sockets at x=±12 (murder-hole frame + wall-top marker
// plate), 2 units clear of the chamber archways at x=±6 (CHAMBER_ARCH_WIDTH=2.2, so the
// archway's own edge is at x=±4.9), comfortably short of the stair ramps at x=±STAIR_X=18, and
// clear of the purchasable extra sockets too (embrasure ±16, chamber ±9.5 — EXTRA_EMBRASURE_XS/
// EXTRA_CHAMBER_XS above). x=±4, the next gap in, is deliberately skipped for the same reason
// EXTRA_EMBRASURE_XS skips it: only ~0.9 clear of the chamber archway, too tight once the
// ladder's own footprint is added.
export const LADDER_XS = [-8, 8];
// How far off the wall's vertical face the ladder (and the player, while climbing it) sits —
// just enough that neither clips into the stone. Applied outward: negative z (into the field)
// for a front ladder, positive z (into the courtyard) for a back one. Small on purpose — see
// SKIN in player/controller.ts for a similarly-sized existing collision tolerance.
export const LADDER_STANDOFF = 0.3;
// Horizontal (x) and depth (z) tolerance for "is the player close enough to this ladder to grab
// it" (sim/ladders.ts's findLadderAt, consumed by player/controller.ts). Generous enough to
// cover the tiny overshoot from one tick's own step size without being so wide that two ladders
// 16 units apart (LADDER_XS) could ever both match, or that a player merely walking past a wall
// face (not into it) would snag on one.
export const LADDER_REACH_X = 1.0;
export const LADDER_REACH_Z = 0.9;
// Where a climb ends up on reaching the top: this far in from the wall-top's front (or back)
// edge, so the player lands solidly inside the walkway rather than on the parapet/merlon band
// (wall-relative z in [-0.2, 0.5] — see BAND_FRONT_Z/BAND_BACK_Z in sim/castleBlocking.ts) or
// stuck right at the lip.
export const LADDER_TOP_INSET = 1.2;
// ---- Ladder render-only geometry (render/castleView.ts) ----
export const LADDER_RAIL_HALF_SPAN = 0.35; // half the gap between the two rails
export const LADDER_RUNG_SPACING = 0.5; // vertical gap between rungs

// ---- Environment geometry ----
export const ROAD_HALF_WIDTH = 3.5; // dirt approach road from the spawn gate to the castle
export const PROP_MIN_ABS_X = 26; // rocks/trees keep |x| beyond this so they never block enemies
