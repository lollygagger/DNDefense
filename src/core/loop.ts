import type { GameState } from '../sim/GameState';

/** Fixed 60 Hz sim tick with an accumulator; render systems run every animation frame.
 *  Sim mutations belong in tick() only — this boundary is what keeps a future
 *  server-authoritative multiplayer refactor tractable. */
export const SIM_STEP = 1 / 60;

export function startLoop(game: GameState, renderFrame: () => void): void {
  let last = performance.now();
  let acc = 0;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.25); // clamp: tab-away shouldn't fast-forward
    last = now;
    acc += dt;
    while (acc >= SIM_STEP) {
      game.time += SIM_STEP;
      for (const s of game.systems) s.tick?.(SIM_STEP, game);
      acc -= SIM_STEP;
    }
    for (const s of game.systems) s.render?.(dt, game);
    renderFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
