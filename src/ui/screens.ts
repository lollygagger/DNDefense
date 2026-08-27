import type { GameState } from '../sim/GameState';
import type { PlayerClassDef } from '../sim/types';
import { CLASS_REGISTRY } from '../data/classRegistry';
import { allAbilities } from '../sim/classes';
import { setSelectedClass } from '../player/classSelect';
import { escapeHtml, overlayClosed, overlayOpened } from './hud';

/** Owned by [ui]. Two full-screen overlays appended into #ui:
 *   - start screen: shown on boot while phase === 'menu'. Title, class select,
 *     controls reference, "Enter the Keep".
 *   - game-over screen: shown on the game:over event. Run stats + "Try Again".
 *  Both use the shared overlay coordination in hud.ts so player/wave input stays
 *  disabled while a screen covers the game. Esc does NOT close either screen (there is
 *  either no game yet, or the run is already over) — screens.ts installs no Esc handler.
 *
 *  Class selection: src/main.ts's FROZEN boot order calls initPlayer() (which creates the
 *  one PlayerState via `createPlayer(getSelectedClass() ?? MAGE)`) *before* initScreens()
 *  ever builds this DOM — so by the time a card can physically be clicked, the player entity
 *  already exists as a Mage. setSelectedClass() alone therefore can't steer that first spawn.
 *  Instead, "Enter the Keep" applies the choice directly onto the already-created
 *  game.localPlayer (classDef/hp/maxHp/ability state) — a one-shot "choose class" command,
 *  the same pattern as the gold-spend/build commands menus.ts issues elsewhere from a click
 *  handler rather than from inside tick(). setSelectedClass() is still called too, for
 *  classSelect.ts's contract and in case a future refactor makes controller.ts's read of it
 *  meaningful (e.g. a respawn/reconnect flow). */

const CLASS_ICONS: Record<string, string> = { mage: '🧙', warrior: '🛡️', archer: '🏹', tank: '🧱' };
function classIcon(id: string): string {
  return CLASS_ICONS[id] ?? '⚔️';
}

/** Apply a chosen class onto the already-spawned local player: swap its class def, resize its
 *  HP to the new class's max, and reset ability state so no stale rank/cooldown from the old
 *  class's (differently-named) abilities lingers. Safe to call before the run starts — the
 *  player can't move or act while phase is still 'menu' (see player/controller.ts), so there's
 *  no mid-cast state to disturb. */
function applySelectedClass(game: GameState, def: PlayerClassDef): void {
  const p = game.localPlayer;
  if (!p) return;
  p.classDef = def;
  p.maxHp = def.maxHp;
  p.hp = def.maxHp;
  p.abilityRanks = {};
  p.cooldowns = {};
  for (const a of allAbilities(def)) p.abilityRanks[a.id] = 0;
}

const CONTROLS: readonly [key: string, action: string][] = [
  ['Mouse', 'Look / aim'],
  ['WASD', 'Move'],
  ['Space', 'Jump'],
  ['W / S at a ladder', 'Climb up / down — walk into a wall face where one hangs to grab it'],
  ['LMB', 'Primary attack — or confirm a ground-targeted cast'],
  ['2 / 3 / 4', "Use your class's abilities (ground-targeted ones arm a reticle first)"],
  ['RMB / Esc', 'Cancel ability targeting'],
  ['E', 'Socket menu — build or upgrade a structure'],
  ['B', 'Castle menu — build or repair wall tiers'],
  ['Tab', 'Class upgrade menu'],
  ['G', 'Sound the horn — start the next wave'],
];

function controlsHtml(): string {
  return CONTROLS.map(
    ([key, action]) =>
      `<div class="control-row"><span class="control-key">${escapeHtml(key)}</span><span class="control-action">${escapeHtml(action)}</span></div>`
  ).join('');
}

function classCardHtml(def: PlayerClassDef, selected: boolean): string {
  const abilities = allAbilities(def)
    .map(
      (a) =>
        `<div class="class-ability"><span class="ability-icon">${a.icon}</span><span class="ability-name">${escapeHtml(a.name)}</span></div>`
    )
    .join('');
  return `<div class="class-card${selected ? ' selected' : ''}" data-class-id="${escapeHtml(def.id)}" tabindex="0" role="button" aria-pressed="${selected}">
    <div class="class-card-name">${classIcon(def.id)} ${escapeHtml(def.name)}</div>
    <div class="class-card-desc">${escapeHtml(def.desc)}</div>
    <div class="class-abilities">${abilities}</div>
  </div>`;
}

function startScreenHtml(selectedId: string | null): string {
  const cards = CLASS_REGISTRY.map((def) => classCardHtml(def, def.id === selectedId)).join('');
  return `<div class="screen-inner">
    <h1 class="game-title">DNDefense</h1>
    <p class="game-subtitle">Hold the wall. Build the keep. Survive the horde.</p>

    <section class="start-section">
      <h2 class="section-heading">Choose your class</h2>
      <div class="class-select" id="class-select">${cards}</div>
    </section>

    <section class="start-section">
      <h2 class="section-heading">How to play</h2>
      <ul class="howto-list">
        <li>Kill enemies for <b>gold</b>.</li>
        <li>Press <span class="key-inline">E</span> near a glowing socket on the wall to build a crossbow or armory.</li>
        <li>Press <span class="key-inline">B</span> to raise the outer walls.</li>
        <li>Press <span class="key-inline">G</span> to sound the horn and start the next wave.</li>
        <li>The run ends when <b>the keep wall</b> falls.</li>
      </ul>
    </section>

    <section class="start-section">
      <h2 class="section-heading">Controls</h2>
      <div class="controls-ref">${controlsHtml()}</div>
    </section>

    <button id="enter-keep-btn" class="btn-primary btn-enter" type="button">⚔️ Enter the Keep</button>
  </div>`;
}

function gameOverHtml(): string {
  return `<div class="screen-inner">
    <h1 class="gameover-title">☠️ The Keep Has Fallen</h1>
    <div class="stat-tiles">
      <div class="stat-tile"><div class="stat-value" id="stat-waves">0</div><div class="stat-label">Waves Survived</div></div>
      <div class="stat-tile"><div class="stat-value" id="stat-kills">0</div><div class="stat-label">Kills</div></div>
      <div class="stat-tile"><div class="stat-value" id="stat-gold">0</div><div class="stat-label">Gold Earned</div></div>
    </div>
    <button id="try-again-btn" class="btn-primary" type="button">🔄 Try Again</button>
  </div>`;
}

export function initScreens(game: GameState): void {
  const ui = document.getElementById('ui')!;

  let selectedClassId: string | null = CLASS_REGISTRY[0]?.id ?? null;

  ui.insertAdjacentHTML(
    'beforeend',
    `<div id="start-screen" class="screen">${startScreenHtml(selectedClassId)}</div>
     <div id="gameover-screen" class="screen hidden">${gameOverHtml()}</div>`
  );

  const startScreen = document.getElementById('start-screen')!;
  const gameoverScreen = document.getElementById('gameover-screen')!;
  const classSelect = document.getElementById('class-select')!;
  const enterBtn = document.getElementById('enter-keep-btn')!;
  const tryAgainBtn = document.getElementById('try-again-btn')!;

  // ---------- start screen ----------
  // Shown on boot: GameState starts in phase 'menu' and nothing flips it before this
  // module runs (see main.ts boot order), so the start screen is always up at this point.
  overlayOpened('screen');

  classSelect.addEventListener('click', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.class-card');
    if (!card) return;
    selectedClassId = card.dataset.classId ?? selectedClassId;
    for (const el of classSelect.querySelectorAll('.class-card')) {
      el.classList.toggle('selected', el === card);
      el.setAttribute('aria-pressed', String(el === card));
    }
    const def = CLASS_REGISTRY.find((d) => d.id === selectedClassId);
    if (def) setSelectedClass(def);
  });

  enterBtn.addEventListener('click', () => {
    const def = CLASS_REGISTRY.find((d) => d.id === selectedClassId) ?? CLASS_REGISTRY[0];
    if (def) {
      setSelectedClass(def);
      applySelectedClass(game, def);
    }
    startScreen.classList.add('hidden');
    overlayClosed('screen');
    game.setPhase('build');
  });

  // ---------- game over screen ----------

  game.events.on('game:over', ({ waves, kills, goldEarned }) => {
    startScreen.classList.add('hidden'); // force-hide in case it's somehow still up
    document.getElementById('stat-waves')!.textContent = String(waves);
    document.getElementById('stat-kills')!.textContent = String(kills);
    document.getElementById('stat-gold')!.textContent = String(goldEarned);
    gameoverScreen.classList.remove('hidden');
    overlayOpened('screen');
  });

  tryAgainBtn.addEventListener('click', () => {
    location.reload();
  });
}
