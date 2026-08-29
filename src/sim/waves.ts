import type { GameState } from './GameState';
import type { WaveDef } from './types';
import { ENDLESS, WAVES, WAVE_CLEAR_BONUS } from '../data/waves';
import { ELITE, FORMATION, SKIRMISH, formationRank, getEnemyDef, isFlyerDef } from '../data/enemies';
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
  elite?: boolean;
}

/** Linear ramp from `a` at wave `from` to `b` at wave `to`, flat outside that span. The shape both
 *  the skirmisher rate and the elite share use to grow with the run. */
function ramp(wave: number, from: number, to: number, a: number, b: number): number {
  if (wave <= from) return a;
  if (wave >= to) return b;
  return a + ((b - a) * (wave - from)) / (to - from);
}

/** Fraction of a column that should be elite on this wave (0 before ELITE.startWave). */
function eliteShare(wave: number): number {
  if (wave < ELITE.startWave) return 0;
  return ramp(wave, ELITE.startWave, ELITE.fullShareWave, ELITE.shareStart, ELITE.shareFull);
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
function queueColumns(game: GameState, wave: number, entries: readonly { type: string; count: number; delay: number }[]): PendingSpawn[] {
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

  // When each column sets off. Gaps are jittered so the rhythm of an assault is never metronomic,
  // and every gap after the first may instead collapse into a DOUBLE PUSH — the next column
  // arriving almost on the heels of the one before, two formations hitting the line together.
  // That spike is what stops a defence that comfortably handles one column at a time from being
  // sufficient forever, and it is random by design: you can't learn the pattern, only build for
  // the possibility.
  const dispatchOffsets: number[] = [0];
  for (let i = 1; i < columnCount; i++) {
    const doublePush = game.rng.next() < FORMATION.doublePushChance;
    const gap = doublePush
      ? FORMATION.doublePushGap
      : Math.max(2, FORMATION.columnGap + game.rng.range(-FORMATION.columnGapJitter, FORMATION.columnGapJitter));
    dispatchOffsets.push(dispatchOffsets[i - 1] + gap);
  }

  const share = eliteShare(wave);
  columns.forEach((members, ci) => {
    if (members.length === 0) return;
    // One shared pace, or the ranks invert on the way in. Fast enough that the column is not
    // hostage to its heaviest member, never faster than its quickest could manage alone.
    const speeds = members.map((t) => getEnemyDef(t).speed);
    const marchSpeed = Math.min(Math.min(...speeds) * FORMATION.marchMult, Math.max(...speeds));
    const centreX = game.rng.range(-FORMATION.centerJitter, FORMATION.centerJitter);
    const at = game.time + firstDelay + dispatchOffsets[ci];

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
        // Elites are seeded per body rather than by promoting whole ranks, so a column carries a
        // scattering of champions among ordinary troops instead of an all-or-nothing front rank.
        elite: share > 0 && game.rng.next() < share,
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

/** Wave mods with the elite multipliers folded in, for a single elite spawn. Stacks on top of the
 *  endless scaling rather than replacing it — an elite on wave 40 is a multiple of a wave-40
 *  enemy, not of a wave-1 one. */
function eliteMods(base: SpawnMods): SpawnMods {
  return {
    hpMult: (base.hpMult ?? 1) * ELITE.hpMult,
    speedMult: base.speedMult,
    goldMult: (base.goldMult ?? 1) * ELITE.goldMult,
  };
}

interface Scheduler {
  queue: PendingSpawn[];
  next: number; // index of the next queue entry to spawn
  mods: SpawnMods;
  hornQueued: boolean; // set by the DOM key listener, consumed in tick (command-style input)
  /** Ground types this run's waves actually field, for skirmishers to draw from — so raiders are
   *  always creatures you have already met at this point in the run, never a preview of something
   *  a later wave is supposed to introduce. */
  skirmishPool: string[];
  nextSkirmishAt: number;
}

/** Seconds until the next skirmisher band. */
function skirmishInterval(wave: number, game: GameState): number {
  const base = ramp(wave, SKIRMISH.startWave, SKIRMISH.fullPressureWave, SKIRMISH.intervalStart, SKIRMISH.intervalFull);
  return base * game.rng.range(0.7, 1.3); // never metronomic
}

/** Send one loose band of raiders in, the old scattered way: random lane, own speed, no rank.
 *  The contrast with a formed column is deliberate — it is what makes a column read as an army. */
function spawnSkirmishers(game: GameState, s: Scheduler, wave: number): void {
  if (s.skirmishPool.length === 0) return;
  const maxSize = Math.round(ramp(wave, SKIRMISH.startWave, SKIRMISH.fullPressureWave, SKIRMISH.groupMaxStart, SKIRMISH.groupMaxFull));
  const size = Math.max(SKIRMISH.groupMin, Math.round(game.rng.range(SKIRMISH.groupMin, Math.max(SKIRMISH.groupMin, maxSize))));
  const share = eliteShare(wave);
  for (let i = 0; i < size; i++) {
    const type = s.skirmishPool[Math.floor(game.rng.range(0, s.skirmishPool.length)) % s.skirmishPool.length];
    const elite = share > 0 && game.rng.next() < share;
    spawnEnemy(game, type, elite ? eliteMods(s.mods) : s.mods, undefined, elite);
  }
}

const scheds = new Map<GameState, Scheduler>();

function schedFor(game: GameState): Scheduler {
  let s = scheds.get(game);
  if (!s) {
    s = { queue: [], next: 0, mods: {}, hornQueued: false, skirmishPool: [], nextSkirmishAt: Infinity };
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
  s.queue = queueColumns(game, n, getWave(n).entries);
  s.queue.sort((a, b) => a.at - b.at);
  s.next = 0;
  // Raiders are drawn from this wave's own ground roster, so they're always creatures the run has
  // already introduced. Rebuilt each wave so the pool grows with the bestiary.
  s.skirmishPool = [...new Set(getWave(n).entries.map((e) => e.type).filter((t) => !isFlyerDef(t)))];
  s.nextSkirmishAt = n >= SKIRMISH.startWave ? game.time + skirmishInterval(n, game) : Infinity;
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

      // Skirmishers fill the gaps BETWEEN COLUMNS, and only while columns are still coming. Once
      // the last formation is out the trickle stops, so the tail of a wave is a fight you can
      // actually finish and the build phase that follows is genuinely clear — the intermission is
      // when you shop, and shopping under fire is a different game.
      if (game.waveNumber >= SKIRMISH.startWave && s.next < s.queue.length && game.time >= s.nextSkirmishAt) {
        spawnSkirmishers(game, s, game.waveNumber);
        s.nextSkirmishAt = game.time + skirmishInterval(game.waveNumber, game);
      }

      while (s.next < s.queue.length && game.time >= s.queue[s.next].at) {
        const q = s.queue[s.next];
        spawnEnemy(game, q.type, q.elite ? eliteMods(s.mods) : s.mods, q.placement, q.elite);
        s.next++;
      }

      // Skirmishers count toward the clear like anything else. They stop spawning once the last
      // column is out (above), so they can't hold a wave open indefinitely — and requiring them
      // dead is exactly what guarantees an empty field when the build phase arrives.
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
