import type { GameState } from './GameState';
import type { WaveDef } from './types';
import { ENDLESS, WAVES, WAVE_CLEAR_BONUS } from '../data/waves';
import { spawnEnemy, type SpawnMods } from './enemies';

/** Owned by [enemies-waves]. Wave scheduler: startNextWave (G key / UI) flips build → combat
 *  and queues spawns; the tick pops due spawns and detects wave-clear (queue drained + no
 *  living enemies) → clear bonus → back to build. Waves 11+ are generated deterministically
 *  from the wave 8-10 templates with the ENDLESS scaling constants. */

export function getWave(n: number): WaveDef {
  if (n < 1) n = 1;
  if (n <= WAVES.length) return WAVES[n - 1];
  // Endless: rotate through the late-game templates (waves 8, 9, 10) and scale counts.
  const k = n - WAVES.length;
  const template = WAVES[WAVES.length - 3 + ((k - 1) % 3)];
  const countMult = 1 + ENDLESS.countGrowth * k;
  return {
    entries: template.entries.map((en) => ({
      ...en,
      count: Math.max(1, Math.round(en.count * countMult)),
    })),
  };
}

/** Endless stat scaling for wave n (identity below wave 11). */
export function getWaveMods(n: number): SpawnMods {
  if (n <= WAVES.length) return {};
  const k = n - WAVES.length;
  return {
    hpMult: 1 + ENDLESS.hpGrowth * k,
    speedMult: Math.min(1 + ENDLESS.speedGrowthPerWave * k, ENDLESS.speedCap),
    goldMult: 1 + ENDLESS.goldGrowth * k,
  };
}

interface PendingSpawn {
  at: number; // game.time to spawn at
  type: string;
}

interface Scheduler {
  queue: PendingSpawn[];
  next: number; // index of the next queue entry to spawn
  mods: SpawnMods;
  hornQueued: boolean; // set by the DOM key listener, consumed in tick (command-style input)
}

const scheds = new Map<GameState, Scheduler>();

function schedFor(game: GameState): Scheduler {
  let s = scheds.get(game);
  if (!s) {
    s = { queue: [], next: 0, mods: {}, hornQueued: false };
    scheds.set(game, s);
  }
  return s;
}

/** Request the next wave to start (called by UI/input during build phase). */
export function startNextWave(game: GameState): boolean {
  if (game.phase !== 'build') return false;
  const s = schedFor(game);
  const n = game.waveNumber + 1;
  game.waveNumber = n;
  s.mods = getWaveMods(n);
  s.queue = [];
  for (const entry of getWave(n).entries) {
    for (let i = 0; i < entry.count; i++) {
      s.queue.push({ at: game.time + entry.delay + entry.interval * i, type: entry.type });
    }
  }
  s.queue.sort((a, b) => a.at - b.at);
  s.next = 0;
  game.events.emit('wave:started', { n });
  game.setPhase('combat');
  game.waveActive = true;
  return true;
}

export function initWaves(game: GameState): void {
  const s = schedFor(game);

  // DOM listener only enqueues a command flag; the sim consumes it in tick.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'g' && ev.key !== 'G') return;
    if (document.body.dataset.menuOpen === '1') return;
    s.hornQueued = true;
  });

  game.addSystem({
    tick(_dt) {
      if (s.hornQueued) {
        s.hornQueued = false;
        startNextWave(game); // no-op outside the build phase
      }
      if (game.phase !== 'combat' || !game.waveActive) return;

      while (s.next < s.queue.length && game.time >= s.queue[s.next].at) {
        spawnEnemy(game, s.queue[s.next].type, s.mods);
        s.next++;
      }

      if (s.next >= s.queue.length && !game.enemies.some((e) => e.alive)) {
        const n = game.waveNumber;
        game.waveActive = false;
        game.addGold(WAVE_CLEAR_BONUS(n));
        game.events.emit('wave:cleared', { n });
        game.setPhase('build');
      }
    },
  });
}
