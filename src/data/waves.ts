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

/** Endless scaling (wave n > 10). Multipliers applied per docs/GAME_DESIGN.md.
 *
 *  goldGrowth retuned 0.05 -> 0.09 (late-game ability Mastery task, 2026-08-27). The enemy
 *  "threat pool" a player has to burn through each wave is count×hp = (1+countGrowth·k)×
 *  (1+hpGrowth·k), which at goldGrowth=0.05 badly outpaced kill-gold income
 *  (count×gold = (1+countGrowth·k)×(1+goldGrowth·k)): at wave 20/30/40 the threat pool sits at
 *  5.5x/13.6x/25x baseline while income was only tracking 2.5x/4.0x/5.5x — i.e. gold income was
 *  hard-capped relative to an unbounded threat curve, which is the root cause the Mastery trees'
 *  many-hundred-to-low-thousand-gold price tags would otherwise be unreachable against. 0.09
 *  brings income to ~4.75x/11.2x/20.35x at those same waves — close enough to the threat curve
 *  that a dedicated player can actually afford deep Mastery investments by the time the game
 *  demands them, while staying far enough below 1:1 that the escalating-difficulty curve this
 *  whole endless mode is built on stays real (matching goldGrowth to hpGrowth exactly would have
 *  made gold income scale in perfect lockstep with the threat pool, i.e. remove the tension
 *  entirely — see the ability-mastery task report for the full math). */
export const ENDLESS = {
  countGrowth: 0.15, // count × (1 + growth·(n−10))
  hpGrowth: 0.12,
  goldGrowth: 0.09,
  speedGrowthPerWave: 0.01,
  speedCap: 1.3,
};

export const WAVE_CLEAR_BONUS = (n: number) => 25 + 5 * n;
