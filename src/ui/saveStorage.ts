import type { GameState } from '../sim/GameState';
import { CLASS_REGISTRY } from '../data/classRegistry';
import { captureRun, RUN_SNAPSHOT_VERSION, type RunSnapshot } from '../sim/runSnapshot';

/** Owned by [ui] (session-persistence task, 2026-08-27). The platform half of run persistence:
 *  where a snapshot is kept, when one is written, and how it's described on the resume card.
 *  sim/runSnapshot.ts owns what a snapshot *contains* and how it replays.
 *
 *  localStorage, NOT A COOKIE. A snapshot is a few KB once a run has a couple of walls and a
 *  spread of upgrades, and cookies cap out around 4KB *and* ride along on every HTTP request to
 *  the origin — wasteful for data the server has no use for. localStorage is same-origin,
 *  persistent across sessions, and never leaves the browser, which is exactly the requirement.
 *
 *  SAVES ONLY DURING THE BUILD PHASE, which is what makes the "restore = start of the build
 *  phase" contract in runSnapshot.ts honest. If combat also wrote saves, the file would record
 *  gold earned partway through a wave that a resume then makes you fight again — quit-and-resume
 *  would become a gold farm. Freezing the save at the build phase means a resumed run is exactly
 *  the run you last chose to start a wave from.
 *
 *  Every storage call is wrapped: Safari private mode throws on setItem, users can disable site
 *  data outright, and a corrupt or older-schema entry must degrade to "no save" rather than
 *  taking the boot path down with it. */

const STORAGE_KEY = 'dndefense.run.v1';
const DEBOUNCE_MS = 400;

let storageBroken = false; // one failed write disables the rest; no point retrying every purchase

export function loadSave(): RunSnapshot | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage disabled entirely
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RunSnapshot;
    // Shape check, not just a version check: hand-edited or half-written entries reach this path
    // too, and a malformed snapshot would otherwise blow up mid-replay with a half-built castle.
    if (
      !parsed ||
      parsed.version !== RUN_SNAPSHOT_VERSION ||
      typeof parsed.classId !== 'string' ||
      !Array.isArray(parsed.walls) ||
      !Array.isArray(parsed.structures)
    ) {
      clearSave();
      return null;
    }
    return parsed;
  } catch {
    clearSave();
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export function hasSave(): boolean {
  return loadSave() !== null;
}

function write(snap: RunSnapshot): void {
  if (storageBroken) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    storageBroken = true; // private mode or quota — play on, just without saving
  }
}

/** Human-readable summary for the resume card: "Wave 7 · Mage · 340 gold", plus how long ago. */
export function describeSave(snap: RunSnapshot): { line: string; when: string } {
  const className = CLASS_REGISTRY.find((d) => d.id === snap.classId)?.name ?? snap.classId;
  const next = snap.waveNumber + 1;
  const built = snap.structures.length;
  const parts = [`Wave ${next} next`, className, `${snap.gold} gold`];
  if (built > 0) parts.push(`${built} ${built === 1 ? 'structure' : 'structures'}`);
  return { line: parts.join(' · '), when: relativeTime(snap.savedAt) };
}

function relativeTime(then: number): string {
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Capture and write immediately, ignoring the debounce. Used on pagehide and on pause, where
 *  there may be no later frame to flush a pending timer. */
export function saveNow(game: GameState): void {
  const snap = captureRun(game);
  if (snap) write(snap);
}

export interface AutosaveOptions {
  /** Playground runs are explicitly "not a scored run" (unlimited gold, wave select), so they
   *  must never overwrite a real run's save. Passed as a predicate rather than read here so this
   *  module doesn't need to know playground mode exists. */
  enabled: () => boolean;
}

export function initAutosave(game: GameState, opts: AutosaveOptions): void {
  let pending: number | null = null;

  const flush = (): void => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    if (!opts.enabled() || game.phase !== 'build') return;
    saveNow(game);
  };

  const schedule = (): void => {
    if (!opts.enabled() || game.phase !== 'build') return;
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(flush, DEBOUNCE_MS) as unknown as number;
  };

  // gold:changed alone covers every purchase in the game (walls, wall nodes, structures,
  // structure nodes, ability ranks, mastery nodes all go through trySpend), so there's no need
  // for a per-purchase event that the frozen event map doesn't have anyway. The other two are
  // for the state changes that matter but don't move gold.
  game.events.on('gold:changed', schedule);
  game.events.on('wall:built', schedule);
  game.events.on('structure:built', schedule);
  game.events.on('phase:changed', ({ phase }) => {
    if (phase === 'build') flush(); // the canonical resume point — write it immediately
  });

  // The run is over; there is nothing left to come back to.
  game.events.on('game:over', () => clearSave());

  // Closing the tab or backgrounding on mobile gives no further frames — flush synchronously.
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
