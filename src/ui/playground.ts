import type { GameState } from '../sim/GameState';
import { allAbilities, buyAbilityRank, nextRankCost } from '../sim/classes';
import { abilityTree, buyAbilityTreeNode, purchasedTreeNodes } from '../sim/abilityTree';
import { startNextWave } from '../sim/waves';
import { anyOverlayOpen, escapeHtml, overlayClosed, overlayOpened } from './hud';
import { panel } from './menuWidgets';

/** Owned by [ui]. Playground / sandbox mode — a testing aid, not part of a normal run.
 *
 *  Enabled from the start screen (or by adding ?playground to the URL). While on:
 *   - gold is kept topped up, so nothing is ever unaffordable;
 *   - the wave counter can be set directly, to jump straight to a late wave;
 *   - every ability rank and mastery node can be bought out in one click, to try a full kit;
 *   - the player can optionally be made invulnerable, to watch a brutal wave play out.
 *
 *  Deliberately opt-in and clearly labelled: it distorts the economy and difficulty the rest of
 *  the design is tuned around, so it must never be something a player switches on by accident. */

const TOPUP_TO = 999_999;
/** Re-top-up once the balance dips below this, rather than every tick — a per-tick write would
 *  fire a gold:changed event 60x a second and make the HUD's gold pill strobe permanently. */
const TOPUP_FLOOR = 500_000;

/** Parsed at module load, NOT inside initPlayground: main.ts's boot order runs initScreens()
 *  before initPlayground(), and the start screen reads this flag to pre-tick its checkbox. Doing
 *  it at import time means the value is settled before either init runs, so a ?playground URL and
 *  the checkbox can never disagree. */
let enabled = new URLSearchParams(location.search).has('playground');

export function isPlaygroundMode(): boolean {
  return enabled;
}

export function setPlaygroundMode(on: boolean): void {
  enabled = on;
}

export function initPlayground(game: GameState): void {
  const ui = document.getElementById('ui')!;
  ui.insertAdjacentHTML(
    'beforeend',
    `<div id="playground-root" style="display:none"></div>
     <div id="playground-badge" style="display:none">🧪 PLAYGROUND — <b>P</b> for tools</div>`
  );
  const root = document.getElementById('playground-root')!;
  const badge = document.getElementById('playground-badge')!;

  let open = false;
  let godMode = false;
  let waveInput = 1;

  const toast = (text: string): void => game.events.emit('ui:toast', { text });

  function render(): void {
    if (!open) return;
    const p = game.localPlayer;
    const body = `
      <div class="pg-note">Sandbox tools. These bypass the normal economy and difficulty — for testing, not for a scored run.</div>
      <div class="menu-subheading">Waves</div>
      <div class="menu-row">
        <div class="row-main">
          <div class="row-name">Jump to wave</div>
          <div class="row-desc">Sets the counter so the next horn starts this wave. Currently on wave ${game.waveNumber}.</div>
        </div>
        <div class="row-action pg-wave">
          <input id="pg-wave-input" class="pg-input" type="number" min="1" max="200" value="${waveInput}" />
          <button class="btn" data-action="pg-set-wave">Set</button>
          <button class="btn" data-action="pg-start-wave">Set &amp; Start ▸</button>
        </div>
      </div>
      <div class="menu-subheading">Loadout</div>
      <div class="menu-row">
        <div class="row-main">
          <div class="row-name">Max out ${p ? escapeHtml(p.classDef.name) : 'class'}</div>
          <div class="row-desc">Buys every rank and every mastery node — the fastest way to try a full late-game kit. Mutually exclusive branches take the first of each pair.</div>
        </div>
        <button class="btn" data-action="pg-max-class">Max everything</button>
      </div>
      <div class="menu-subheading">Survival</div>
      <div class="menu-row">
        <div class="row-main">
          <div class="row-name">God mode ${godMode ? '<span class="node-badge owned">ON</span>' : ''}</div>
          <div class="row-desc">Ignore all incoming damage, so a wave can be watched all the way through. Off by default — it hides whether a wave is actually survivable.</div>
        </div>
        <button class="btn" data-action="pg-god">${godMode ? 'Turn off' : 'Turn on'}</button>
      </div>
      <div class="menu-row">
        <div class="row-main">
          <div class="row-name">Clear the field</div>
          <div class="row-desc">Kills every living enemy — resets a test without waiting the wave out.</div>
        </div>
        <button class="btn" data-action="pg-clear">Clear enemies</button>
      </div>`;
    root.innerHTML = panel('🧪 Playground', body);
  }

  function close(): void {
    if (!open) return;
    open = false;
    root.style.display = 'none';
    root.innerHTML = '';
    overlayClosed('playground');
  }

  function toggle(): void {
    if (open) {
      close();
      return;
    }
    if (game.phase !== 'build' && game.phase !== 'combat') return;
    open = true;
    root.style.display = '';
    overlayOpened('playground');
    render();
  }

  /** Buy every linear rank, then every reachable mastery node, for every ability. */
  function maxOutClass(): void {
    const p = game.localPlayer;
    if (!p) return;
    let bought = 0;
    for (const ability of allAbilities(p.classDef)) {
      // Linear ranks: keep buying while one is offered. Bounded by the rank array length.
      for (let guard = 0; guard < 32 && nextRankCost(p, ability.id) !== null; guard++) {
        if (!buyAbilityRank(game, p, ability.id)) break;
        bought++;
      }
      // Mastery tree: repeated passes so a tier-2 node lands after its prerequisite. Nodes that
      // are excluded by an earlier pick simply keep failing, which is the intended behaviour.
      const tree = abilityTree(ability);
      for (let pass = 0; pass < tree.length; pass++) {
        for (const node of tree) {
          if (purchasedTreeNodes(p, ability.id).includes(node.id)) continue;
          if (buyAbilityTreeNode(game, p, ability, node.id)) bought++;
        }
      }
    }
    toast(`Playground: bought ${bought} upgrades`);
  }

  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    const input = document.getElementById('pg-wave-input') as HTMLInputElement | null;
    if (input) waveInput = Math.max(1, Math.min(200, Number(input.value) || 1));
    switch (el.dataset.action) {
      case 'close':
        close();
        return;
      case 'pg-set-wave':
        // startNextWave() runs waveNumber + 1, so park the counter one short of the target.
        game.waveNumber = waveInput - 1;
        toast(`Playground: next horn starts wave ${waveInput}`);
        break;
      case 'pg-start-wave':
        game.waveNumber = waveInput - 1;
        close();
        if (!startNextWave(game)) toast('Finish the current wave first');
        return;
      case 'pg-max-class':
        maxOutClass();
        break;
      case 'pg-god':
        godMode = !godMode;
        toast(`Playground: god mode ${godMode ? 'on' : 'off'}`);
        break;
      case 'pg-clear':
        for (const e of game.enemies) if (e.alive) e.takeDamage(1e9, game);
        toast('Playground: field cleared');
        break;
    }
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (!enabled) return;
    if (e.key === 'Escape' && open) {
      close();
      return;
    }
    if (e.key !== 'p' && e.key !== 'P') return;
    if (anyOverlayOpen() && !open) return; // another menu owns the screen
    toggle();
  });

  game.addSystem({
    tick() {
      if (!enabled) return;
      if (game.gold < TOPUP_FLOOR) game.addGold(TOPUP_TO - game.gold);
      if (godMode) {
        const p = game.localPlayer;
        if (p && p.alive) p.hp = p.maxHp;
      }
    },
    render() {
      badge.style.display =
        enabled && (game.phase === 'build' || game.phase === 'combat') ? '' : 'none';
    },
  });
}
