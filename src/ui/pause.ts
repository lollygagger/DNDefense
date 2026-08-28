import type { GameState } from '../sim/GameState';
import { setLoopPaused } from '../core/loop';
import { anyOverlayOpen, overlayClosed, overlayOpened } from './hud';
import { clearSave, saveNow } from './saveStorage';

/** Owned by [ui] (session-persistence task, 2026-08-27). The pause overlay.
 *
 *  POINTER-LOCK LOSS IS THE TRIGGER, not an Esc key handler. While the pointer is locked the
 *  browser consumes Esc itself to exit the lock and never dispatches the keydown to the page, so
 *  a keydown-based pause would need Esc pressed *twice*. Treating "lost the lock" as "paused" is
 *  both the only reliable signal and the correct rule anyway: without the lock the player cannot
 *  look or aim, so alt-tabbing, clicking away, or Esc should all stop the world rather than let a
 *  wave chew through the keep while they're elsewhere. An Esc handler is still installed for the
 *  case where the lock is already gone (the player clicked out earlier and is just standing
 *  there), where the keydown does arrive.
 *
 *  hud.ts's overlay registry is what keeps this from fighting the other menus: opening the
 *  castle/socket/class menus calls overlayOpened(), which itself releases pointer lock, so the
 *  guard below ignores an unlock while any overlay is registered. */

const PAUSE_KEY = 'pause';

export function initPause(game: GameState): void {
  const ui = document.getElementById('ui')!;
  ui.insertAdjacentHTML(
    'beforeend',
    `<div id="pause-screen" class="screen screen--pause hidden">
      <div class="screen-inner pause-inner">
        <h1 class="pause-title">⏸️ Paused</h1>
        <div class="stat-tiles">
          <div class="stat-tile"><div class="stat-value" id="pause-wave">0</div><div class="stat-label">Wave</div></div>
          <div class="stat-tile"><div class="stat-value" id="pause-gold">0</div><div class="stat-label">Gold</div></div>
          <div class="stat-tile"><div class="stat-value" id="pause-kills">0</div><div class="stat-label">Kills</div></div>
        </div>
        <p class="pause-save-note" id="pause-save-note"></p>
        <div class="pause-actions">
          <button id="pause-resume-btn" class="btn-primary" type="button">▶️ Resume</button>
          <button id="pause-menu-btn" class="btn-secondary" type="button">🏰 Quit to main menu</button>
          <button id="pause-restart-btn" class="btn-danger" type="button">🔄 Restart run</button>
        </div>
        <p class="pause-hint">Press <span class="key-inline">Esc</span> or click Resume to keep playing.</p>
      </div>
    </div>`
  );

  const screen = document.getElementById('pause-screen')!;
  const canvas = document.querySelector('canvas')!;
  let paused = false;

  const inPlay = (): boolean => game.phase === 'build' || game.phase === 'combat';

  function open(): void {
    if (paused || !inPlay() || anyOverlayOpen()) return;
    paused = true;
    setLoopPaused(true);
    document.getElementById('pause-wave')!.textContent = String(game.waveNumber + 1);
    document.getElementById('pause-gold')!.textContent = String(game.gold);
    document.getElementById('pause-kills')!.textContent = String(game.kills);
    // Be explicit about what quitting keeps. Saves are only written in the build phase (see
    // saveStorage.ts), so quitting mid-wave rewinds to the horn you last sounded — the player
    // should know that before they click, not discover it on the way back in.
    document.getElementById('pause-save-note')!.textContent =
      game.phase === 'build'
        ? 'Progress is saved. You can close the tab and pick this run back up later.'
        : `Progress is saved up to the start of wave ${game.waveNumber + 1} — quitting now will replay this wave.`;
    screen.classList.remove('hidden');
    overlayOpened(PAUSE_KEY);
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    screen.classList.add('hidden');
    overlayClosed(PAUSE_KEY);
    setLoopPaused(false);
    // Browsers impose a short cooldown on re-locking after a user-initiated Esc exit, so this can
    // legitimately reject. Not worth surfacing: the canvas click handler in player/controller.ts
    // is the normal way back in, and the hint text below the buttons already says to click.
    const ret = canvas.requestPointerLock() as unknown;
    (ret as Promise<void> | undefined)?.catch(() => {});
  }

  document.getElementById('pause-resume-btn')!.addEventListener('click', resume);

  document.getElementById('pause-menu-btn')!.addEventListener('click', () => {
    // Only flush a save from the build phase; mid-combat the existing build-phase save is already
    // the correct resume point and overwriting it here would bank gold for a wave you'd re-fight.
    if (game.phase === 'build') saveNow(game);
    location.reload();
  });

  document.getElementById('pause-restart-btn')!.addEventListener('click', () => {
    clearSave();
    location.reload();
  });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === null) open();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (paused) resume();
    else if (document.pointerLockElement === null) open();
  });
}
