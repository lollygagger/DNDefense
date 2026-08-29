import type { GameState } from './GameState';
import type { WaveDef } from './types';
import { ENDLESS, WAVES, WAVE_CLEAR_BONUS } from '../data/waves';
import { FORMATION, formationRank, getEnemyDef, isFlyerDef } from '../data/enemies';
import { ENEMY_SPAWN_Z } from '../data/castle';
import { spawnEnemy, type SpawnMods, type SpawnPlacement } from './enemies';

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
  placement?: SpawnPlacement; // formed-up ground troops; absent for flyers (see SpawnPlacement)
}

/** Lay a wave's ground roster out as marching columns and queue them.
 *
 *  Waves used to dispatch each entry independently — `count` bodies of one type, one every
 *  `interval` seconds, each at a random lane x. That produced a thin scattered stream: a few
 *  goblins, then a few more, arriving piecemeal and dying piecemeal, with archers wandering in
 *  among the melee rather than behind it. Easy to grind down, and nothing like an army.
 *
 *  Now the whole roster is dealt round-robin into a handful of columns, so every column is
 *  combined-arms rather than one being all goblins and the next all archers. Within a column the
 *  members sort into ranks by role (data/enemies.ts's formationRank): heavies lead, light melee
 *  fills in behind, ranged brings up the rear. Each rank is a row of files spread about the
 *  column's centre, wrapping into a sub-row when it would outgrow the field. Columns set off
 *  `columnGap` apart, which is what produces waves upon waves rather than one mass.
 *
 *  The authored `interval` no longer paces individual bodies — a formation arrives together, that
 *  is the point of it — but `delay` still orders the roster, so a type an author held back still
 *  lands in a later column. Flyers keep the original independent, scattered scheduling. */
function queueColumns(game: GameState, entries: readonly { type: string; count: number; delay: number }[]): PendingSpawn[] {
  const out: PendingSpawn[] = [];

  // Flyers first, untouched: they cross the field above it, so a ground formation is meaningless.
  const ground: { type: string; delay: number }[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i++) {
      if (isFlyerDef(entry.type)) out.push({ at: game.time + entry.delay + i * 6, type: entry.type });
      else ground.push({ type: entry.type, delay: entry.delay });
    }
  }
  if (ground.length === 0) return out;

  // Author intent survives as ordering: a type held back by a bigger delay lands further down the
  // roster, so it is dealt into the later columns.
  ground.sort((a, b) => a.delay - b.delay);

  const columnCount = Math.max(
    FORMATION.minColumns,
    Math.min(FORMATION.maxColumns, Math.round(ground.length / FORMATION.targetColumnSize))
  );
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  ground.forEach((g, i) => columns[i % columnCount].push(g.type));

  const firstDelay = entries.reduce((m, e) => Math.min(m, e.delay), Infinity);
  columns.forEach((members, ci) => {
    if (members.length === 0) return;
    // One shared pace, or the ranks invert on the way in. Fast enough that the column is not
    // hostage to its heaviest member, never faster than its quickest could manage alone.
    const speeds = members.map((t) => getEnemyDef(t).speed);
    const marchSpeed = Math.min(Math.min(...speeds) * FORMATION.marchMult, Math.max(...speeds));
    const centreX = game.rng.range(-FORMATION.centerJitter, FORMATION.centerJitter);
    const at = game.time + firstDelay + ci * FORMATION.columnGap;

    // Rank the column, then lay each rank out as a row of files about the centre.
    const byRank = [...members].sort((a, b) => formationRank(a) - formationRank(b));
    const perRow = Math.max(1, Math.floor((FORMATION.halfWidth * 2) / FORMATION.fileSpacing));
    let row = 0;
    let placedInRow = 0;
    let lastRank = formationRank(byRank[0]);
    for (const type of byRank) {
      const rank = formationRank(type);
      // A new role always starts its own row, so ranks never blend into each other.
      if (rank !== lastRank || placedInRow >= perRow) {
        row += 1;
        placedInRow = 0;
        lastRank = rank;
      }
      const rowCount = Math.min(perRow, byRank.filter((t) => formationRank(t) === rank).length);
      const offset = (placedInRow - (rowCount - 1) / 2) * FORMATION.fileSpacing;
      out.push({
        at,
        type,
        placement: {
          x: centreX + offset,
          // Rank 0 stands on the spawn line; every rank behind it sits further back (more
          // negative z), so the column faces the castle already in order.
          z: ENEMY_SPAWN_Z - row * FORMATION.rankSpacing,
          speed: marchSpeed,
        },
      });
      placedInRow += 1;
    }
  });
  return out;
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
  s.queue = queueColumns(game, getWave(n).entries);
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
        spawnEnemy(game, s.queue[s.next].type, s.mods, s.queue[s.next].placement);
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
