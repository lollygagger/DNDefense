import type { WaveDef } from '../sim/types';

/** Waves 1-10 (hand-designed) + endless scaling constants. Owned by [enemies-waves].
 *  Keep docs/GAME_DESIGN.md wave table in sync. */

export const WAVES: WaveDef[] = [
  // 1 — tutorial pace
  { entries: [{ type: 'goblin', count: 6, interval: 2.5, delay: 2 }] },
  // 2
  { entries: [{ type: 'goblin', count: 10, interval: 2.0, delay: 2 }] },
  // 3 — orcs introduced
  {
    entries: [
      { type: 'goblin', count: 10, interval: 1.8, delay: 2 },
      { type: 'orc', count: 2, interval: 8, delay: 15 },
    ],
  },
  // 4
  {
    entries: [
      { type: 'goblin', count: 14, interval: 1.5, delay: 2 },
      { type: 'orc', count: 4, interval: 6, delay: 10 },
    ],
  },
  // 5 — archers introduced
  {
    entries: [
      { type: 'goblin', count: 10, interval: 1.6, delay: 2 },
      { type: 'skeletonArcher', count: 4, interval: 5, delay: 8 },
      { type: 'orc', count: 3, interval: 7, delay: 18 },
    ],
  },
  // 6 — hot air balloon introduced: slow and telegraphed, a gentle first look at "something is
  // flying over the walls" before the swarm/tank waves ramp up.
  {
    entries: [
      { type: 'goblin', count: 18, interval: 1.2, delay: 2 },
      { type: 'skeletonArcher', count: 6, interval: 4, delay: 10 },
      { type: 'hotAirBalloon', count: 1, interval: 1, delay: 20 },
    ],
  },
  // 7 — tank wave
  {
    entries: [
      { type: 'orc', count: 8, interval: 4, delay: 2 },
      { type: 'goblin', count: 10, interval: 1.5, delay: 12 },
    ],
  },
  // 8 — a second balloon, reinforcing that flyers are a recurring priority target, not a
  // one-off gimmick.
  {
    entries: [
      { type: 'goblin', count: 20, interval: 1.1, delay: 2 },
      { type: 'orc', count: 6, interval: 5, delay: 10 },
      { type: 'skeletonArcher', count: 8, interval: 3.5, delay: 14 },
      { type: 'hotAirBalloon', count: 1, interval: 1, delay: 18 },
    ],
  },
  // 9 — swarm, with the dragon's debut as the nasty surprise right before the boss wave.
  {
    entries: [
      { type: 'goblin', count: 28, interval: 0.9, delay: 2 },
      { type: 'skeletonArcher', count: 10, interval: 3, delay: 8 },
      { type: 'orc', count: 4, interval: 6, delay: 20 },
      { type: 'dragon', count: 1, interval: 1, delay: 25 },
    ],
  },
  // 10 — the Orc Warlord, with air support
  {
    entries: [
      { type: 'goblin', count: 16, interval: 1.2, delay: 2 },
      { type: 'orc', count: 6, interval: 5, delay: 8 },
      { type: 'skeletonArcher', count: 8, interval: 3.5, delay: 12 },
      { type: 'orcWarlord', count: 1, interval: 1, delay: 25 },
      { type: 'hotAirBalloon', count: 1, interval: 1, delay: 30 },
    ],
  },
];

/** Endless scaling (wave n > 10). Multipliers applied per docs/GAME_DESIGN.md. */
export const ENDLESS = {
  countGrowth: 0.15, // count × (1 + growth·(n−10))
  hpGrowth: 0.12,
  goldGrowth: 0.05,
  speedGrowthPerWave: 0.01,
  speedCap: 1.3,
};

export const WAVE_CLEAR_BONUS = (n: number) => 25 + 5 * n;
