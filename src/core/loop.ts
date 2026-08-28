import type { GameState } from '../sim/GameState';

/** Fixed 60 Hz sim tick with an accumulator; render systems run every animation frame.
 *  Sim mutations belong in tick() only — this boundary is what keeps a future
 *  server-authoritative multiplayer refactor tractable. */
export const SIM_STEP = 1 / 60;

/** Pause gate. The sim's whole notion of "now" is `game.time`, which only this loop advances,
 *  and every deadline in the game (ability cooldowns, respawn timers, the wave scheduler's spawn
 *  times, DoT bucket flushes) is an absolute comparison against it. So a pause that merely
 *  stopped calling tick() but let time run would silently burn every one of those timers while
 *  the player sat in a menu. Freezing the accumulator here is the only place that holds for all
 *  of them at once, without every system having to learn about pausing.
 *
 *  Kept module-local with an exported setter rather than as a GameState field because GameState
 *  is FROZEN, and rendering deliberately continues while paused: render systems still run (with
 *  dt clamped to 0 so their own animation clocks freeze too) and renderFrame() still draws, so
 *  the paused world stays on screen under the overlay instead of going black.
 *
 *  MULTIPLAYER NOTE: this is a strictly local, single-player convenience. A server-authoritative
 *  build must never gate the shared simulation on one client's pause — the eventual split is that
 *  the server owns the accumulator and a paused client just stops rendering/sending input. */
let paused = false;

export function setLoopPaused(next: boolean): void {
  paused = next;
}

export function isLoopPaused(): boolean {
  return paused;
}

export function startLoop(game: GameState, renderFrame: () => void): void {
  let last = performance.now();
  let acc = 0;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.25); // clamp: tab-away shouldn't fast-forward
    last = now;
    if (paused) {
      // Drop the accumulator rather than letting it fill: resuming after a two-minute pause must
      // not run two minutes of catch-up ticks. `last` is still advanced above every frame, so the
      // first unpaused frame sees an ordinary dt.
      acc = 0;
    } else {
      acc += dt;
      while (acc >= SIM_STEP) {
        game.time += SIM_STEP;
        for (const s of game.systems) s.tick?.(SIM_STEP, game);
        acc -= SIM_STEP;
      }
    }
    for (const s of game.systems) s.render?.(paused ? 0 : dt, game);
    renderFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
