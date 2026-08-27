import type { EnemyDef } from '../sim/types';

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
