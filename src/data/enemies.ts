import type { EnemyDef } from '../sim/types';
import { WALL_HALF_WIDTH, WALL_Z } from './castle';

/** Enemy balance data. Owned by [enemies-waves]. Keep docs/GAME_DESIGN.md tables in sync. */
export const ENEMY_DEFS: Record<string, EnemyDef> = {
  goblin: {
    id: 'goblin',
    name: 'Goblin Grunt',
    hp: 30,
    speed: 4.5,
    gold: 6,
    behavior: 'melee',
    unitDamage: 8,
    attackInterval: 1.0,
    wallDps: 5,
    range: 1.6,
    radius: 0.5,
    height: 1.4,
  },
  orc: {
    id: 'orc',
    name: 'Orc Bruiser',
    hp: 140,
    speed: 2.2,
    gold: 15,
    behavior: 'melee',
    unitDamage: 20,
    attackInterval: 1.6,
    wallDps: 20,
    range: 2.0,
    radius: 0.8,
    height: 2.2,
  },
  skeletonArcher: {
    id: 'skeletonArcher',
    name: 'Skeleton Archer',
    hp: 45,
    speed: 3.2,
    gold: 10,
    behavior: 'ranged',
    unitDamage: 7,
    attackInterval: 2.2,
    wallDps: 2,
    range: 22,
    radius: 0.5,
    height: 1.8,
  },
  orcWarlord: {
    id: 'orcWarlord',
    name: 'Orc Warlord',
    hp: 1200,
    speed: 1.8,
    gold: 200,
    behavior: 'boss',
    unitDamage: 40,
    attackInterval: 2.0,
    wallDps: 60,
    range: 2.6,
    radius: 1.4,
    height: 3.4,
  },

  /** Flying enemies (docs/ROADMAP.md Phase 1 — "flying enemy support"). `behavior` is a
   *  required EnemyDef field but has zero effect on these two: sim/enemies.ts's tick loop
   *  special-cases any defId present in FLYER_AI below to run sim/flyers.ts's stepFlyer()
   *  *before* the melee/ranged/boss switch is ever consulted. 'ranged' is set as the closest
   *  conceptual fit (attacks from a stand-off distance, never melees) purely so the field is
   *  populated with something sensible if anything ever reads it for display.
   *
   *  Two other frozen EnemyDef fields are deliberately reinterpreted for the flying kit, since
   *  there is no contract change to hang new fields off (see sim/flyers.ts's file header for
   *  the full design writeup):
   *    - `range`   = the blast/breath radius of its area attack (not a melee/bow reach).
   *    - `wallDps` = a flat burst of wall damage applied once per attackInterval while the
   *      flyer is over an intact wall's z-footprint (not a continuous per-second rate — ground
   *      units multiply this by dt every tick they're stopped at the wall; flyers apply it once
   *      per attack, so the *number* means something different even though the field is shared). */
  hotAirBalloon: {
    id: 'hotAirBalloon',
    name: 'Hot Air Balloon',
    // Slow, tanky, high-value siege threat: more HP than an Orc Bruiser but nowhere near boss
    // scale, gold reward that says "this one mattered", speed slower than every ground unit.
    hp: 320,
    speed: 1.3,
    gold: 45,
    behavior: 'ranged',
    unitDamage: 26, // per bomb, to anyone caught in the blast
    attackInterval: 3.5, // seconds between bombs
    wallDps: 45, // flat wall-HP burst per bomb landed over a wall's footprint
    range: 4, // bomb blast radius
    radius: 1.8,
    height: 4.2,
  },
  dragon: {
    id: 'dragon',
    name: 'Dragon',
    // Fast and dangerous rather than tanky: less HP than the balloon, but faster than every
    // ground unit (including goblins) and hits more often, so it reads as a real event rather
    // than another wall-batterer.
    hp: 260,
    speed: 7.5,
    gold: 55,
    behavior: 'ranged',
    unitDamage: 12, // per breath tick — punishes standing still under its flight path
    attackInterval: 1.0, // breath ticks frequently; also the dive-cycle period (see FLYER_AI)
    wallDps: 10, // flat wall-HP burst per breath tick landed over a wall's footprint
    range: 3, // breath blast radius
    radius: 1.3,
    height: 2.6,
  },
};

export function getEnemyDef(id: string): EnemyDef {
  const def = ENEMY_DEFS[id];
  if (!def) throw new Error(`Unknown enemy def: ${id}`);
  return def;
}

/** Enemy AI tuning (movement/targeting behavior shared by all enemies). */
export const ENEMY_AI = {
  spawnXRange: 18, // spawn lane x in [-range, +range]
  speedJitterMin: 0.92, // per-enemy speed variance
  speedJitterMax: 1.08,
  aggroRange: 6, // melee: switch from wall to a nearby defender unit within this
  aggroMaxDy: 2, // melee: only chase units roughly on the same level (not up on walls)
  // Stop at wall.z - radius - gap. Kept wide enough that attackers stay visible to a player
  // looking down over the parapet — hugging the wall face put them in a blind spot.
  wallStopGap: 2.5,
  arrowSpeed: 28,
  arrowRadius: 0.3,
  arrowMaxLeadTime: 1.2, // clamp linear-lead prediction horizon (s)
  archerStandback: 2, // when wall-chipping, stand at wall.z - range + this
  separationFactor: 0.35, // fraction of overlap resolved per tick between enemy pairs
};

/** Flight parameters for flying enemies, keyed by defId — a companion lookup (the
 *  enemy-builder guide's pattern for per-enemy quirks without touching the frozen EnemyDef)
 *  rather than new fields on the shared interface. sim/flyers.ts drives all flyer movement and
 *  altitude from this table; see that file's header for the full flight model. Any defId
 *  present here is treated as a flyer everywhere — sim/enemies.ts (ground-clamp skip, wall-stop
 *  skip, separation skip) and render/enemyView.ts (altitude shadow) all key off isFlyerDef(). */
export interface FlyerAI {
  /** World-space y while flying level (for the dragon, the TOP of its dive oscillation). */
  cruiseAltitude: number;
  /** 0 = holds a constant cruiseAltitude (balloon). >0 = dives this far below cruiseAltitude
   *  once per attackInterval, timed so the low point of the dive lines up with the attack tick
   *  (dragon) — see sim/flyers.ts. */
  diveDepth: number;
  /** z at which forward advance stops and the flyer parks/patrols instead of continuing on. */
  holdZ: number;
  /** 0 = holds position once parked (balloon). >0 = patrols x in a bounded sine sweep of this
   *  amplitude around x=0 once parked (dragon), so it keeps threatening the whole wall width
   *  instead of loitering over one spot. */
  sweepAmplitude: number;
}

// Park just in front of the keep (z=30) rather than behind it. sim/structures.ts's crossbow
// target search (read-only to this module) only ever considers enemies with `pos.z < wall.z`
// — "in front of" that wall's own face — so a flyer parked *behind* the keep would be outside
// every crossbow's targeting gate forever and become something only the player could ever put
// down. Parking here keeps the keep's own crossbow relevant as a passive counter for the whole
// fight, matching how every other wall's crossbow already gets first crack at it during approach.
const FLYER_HOLD_Z = WALL_Z[3] - 4;

export const FLYER_AI: Record<string, FlyerAI> = {
  hotAirBalloon: {
    cruiseAltitude: 10, // clears MERLON_TOP (8.2, data/castle.ts) by a comfortable 1.8 —
    // always shootable from any wall top, never blocked by battlement geometry (see
    // sim/flyers.ts's header for why that asymmetry with the dragon is deliberate).
    diveDepth: 0,
    holdZ: FLYER_HOLD_Z,
    sweepAmplitude: 0,
  },
  dragon: {
    cruiseAltitude: 9.5,
    diveDepth: 3, // dive bottom = 6.5: clears the plain parapet lip (6.4) but NOT a merlon
    // (8.2) — during a dive it is genuinely blockable by battlement geometry the way a player
    // ducking behind a merlon is, unlike the balloon's permanently-clear cruise altitude.
    holdZ: FLYER_HOLD_Z,
    sweepAmplitude: WALL_HALF_WIDTH - 2,
  },
};

export function isFlyerDef(defId: string): boolean {
  return defId in FLYER_AI;
}
