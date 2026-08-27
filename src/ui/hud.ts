import type { GameState } from '../sim/GameState';
import type { AbilityDef } from '../sim/types';
import { allAbilities } from '../sim/classes';
import { WAVE_CLEAR_BONUS } from '../data/waves';

/** Owned by [ui]. HUD: top bar (gold / wave / phase), build banner, player HP bar,
 *  damage vignette, death overlay, ability bar with cooldown sweeps, toasts, wave banners.
 *  Also hosts the shared overlay-open coordination used by menus.ts and screens.ts. */

// ---------- shared overlay coordination (menus.ts + screens.ts import these) ----------

const openOverlays = new Set<string>();

/** Register an open menu/screen. Sets body.dataset.menuOpen = '1' (player + waves input
 *  modules ignore game input while set) and releases pointer lock. */
export function overlayOpened(key: string): void {
  openOverlays.add(key);
  document.body.dataset.menuOpen = '1';
  document.exitPointerLock();
}

/** Unregister an overlay; clears the menuOpen flag when nothing is left open. */
export function overlayClosed(key: string): void {
  openOverlays.delete(key);
  if (openOverlays.size === 0) delete document.body.dataset.menuOpen;
}

export function anyOverlayOpen(): boolean {
  return openOverlays.size > 0;
}

export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return s.replace(/[&<>"']/g, (c) => map[c]!);
}

/** Restart a one-shot CSS animation driven by a class. */
function restartAnim(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add(cls);
}

// ---------- HUD ----------

interface AbilitySlot {
  def: AbilityDef;
  root: HTMLElement;
  cd: HTMLElement;
  cdText: HTMLElement;
  pips: HTMLElement;
  lastRank: number;
}

export function initHud(game: GameState): void {
  const ui = document.getElementById('ui')!;
  ui.insertAdjacentHTML(
    'beforeend',
    `<div id="crosshair">+</div>
     <div id="vignette"></div>
     <div id="hud">
       <div id="topbar">
         <div class="pill" id="gold-pill">💰 <span id="gold-num">0</span></div>
         <div class="pill" id="wave-pill">🌊 <span id="wave-text"></span></div>
         <div class="pill" id="phase-pill"></div>
       </div>
       <div id="build-banner">🔨 Build phase — press <b>G</b> to sound the horn 📯</div>
       <div id="hp-wrap">
         <div class="hp-label">❤️ <span id="hp-num"></span></div>
         <div class="bar hp-bar"><div class="bar-fill" id="hp-fill"></div></div>
       </div>
       <div id="ability-bar"></div>
       <div id="toasts"></div>
       <div id="wave-banner"></div>
       <div id="death-overlay">
         <div class="death-title">☠️ You fell!</div>
         <div id="respawn-text"></div>
       </div>
     </div>`
  );

  const crosshair = document.getElementById('crosshair')!;
  const vignette = document.getElementById('vignette')!;
  const hud = document.getElementById('hud')!;
  const goldPill = document.getElementById('gold-pill')!;
  const goldNum = document.getElementById('gold-num')!;
  const waveText = document.getElementById('wave-text')!;
  const phasePill = document.getElementById('phase-pill')!;
  const buildBanner = document.getElementById('build-banner')!;
  const hpNum = document.getElementById('hp-num')!;
  const hpFill = document.getElementById('hp-fill')!;
  const abilityBar = document.getElementById('ability-bar')!;
  const toasts = document.getElementById('toasts')!;
  const waveBanner = document.getElementById('wave-banner')!;
  const deathOverlay = document.getElementById('death-overlay')!;
  const respawnText = document.getElementById('respawn-text')!;

  let slots: AbilitySlot[] = [];

  function buildAbilityBar(): void {
    const p = game.localPlayer;
    if (!p) return;
    abilityBar.innerHTML = '';
    slots = allAbilities(p.classDef).map((def, i) => {
      const hotkey = i === 0 ? 'LMB' : String(i + 1); // primary, then keys 2..n
      const el = document.createElement('div');
      el.className = 'ability-slot';
      el.title = `${def.name} — ${def.desc}`;
      el.innerHTML = `<div class="slot-icon">${def.icon}</div>
        <div class="slot-cd"></div>
        <div class="slot-cd-text"></div>
        <div class="slot-key">${hotkey}</div>
        <div class="slot-pips"></div>`;
      abilityBar.appendChild(el);
      return {
        def,
        root: el,
        cd: el.querySelector<HTMLElement>('.slot-cd')!,
        cdText: el.querySelector<HTMLElement>('.slot-cd-text')!,
        pips: el.querySelector<HTMLElement>('.slot-pips')!,
        lastRank: -1,
      };
    });
  }

  function addToast(text: string): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    toasts.appendChild(t);
    window.setTimeout(() => t.remove(), 2700);
  }

  function showBanner(html: string): void {
    waveBanner.innerHTML = html;
    restartAnim(waveBanner, 'show');
  }

  // ---------- events ----------

  game.events.on('gold:changed', () => restartAnim(goldPill, 'pulse'));
  game.events.on('player:damaged', () => restartAnim(vignette, 'hit'));
  game.events.on('ui:toast', ({ text }) => addToast(text));
  game.events.on('wave:started', ({ n }) => showBanner(`🌊 Wave ${n}!`));
  game.events.on('wave:cleared', ({ n }) =>
    showBanner(`🏆 Wave ${n} cleared!<span class="banner-sub">+${WAVE_CLEAR_BONUS(n)} 💰</span>`)
  );

  // ---------- per-frame refresh (reads sim state only) ----------

  game.addSystem({
    render() {
      const inGame = game.phase === 'build' || game.phase === 'combat';
      hud.style.display = inGame ? '' : 'none';
      crosshair.style.display = inGame && !anyOverlayOpen() ? '' : 'none';
      if (!inGame) return;

      goldNum.textContent = String(game.gold);

      if (game.phase === 'combat') {
        const living = game.enemies.reduce((c, e) => c + (e.alive ? 1 : 0), 0);
        waveText.textContent = `Wave ${game.waveNumber} · ⚔️ ${living}`;
        phasePill.textContent = '⚔️ Combat';
        phasePill.classList.add('combat');
      } else {
        waveText.textContent =
          game.waveNumber === 0 ? 'Wave 1 ahead' : `Wave ${game.waveNumber + 1} ahead`;
        phasePill.textContent = '🔨 Build';
        phasePill.classList.remove('combat');
      }

      buildBanner.style.display = game.phase === 'build' && !anyOverlayOpen() ? '' : 'none';

      const p = game.localPlayer;
      if (!p) return;

      // HP bar
      const pct = Math.max(0, Math.min(1, p.hp / p.maxHp)) * 100;
      hpFill.style.width = `${pct}%`;
      hpFill.classList.toggle('low', pct <= 30);
      hpNum.textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;

      // Death overlay
      if (!p.alive && p.respawnAt !== null) {
        deathOverlay.style.display = '';
        const s = Math.max(0, Math.ceil(p.respawnAt - game.time));
        respawnText.textContent = `Respawning in ${s}s`;
      } else {
        deathOverlay.style.display = 'none';
      }

      // Ability slots
      if (slots.length === 0) buildAbilityBar();
      for (const slot of slots) {
        const readyAt = p.cooldowns[slot.def.id] ?? 0;
        const remaining = Math.max(0, readyAt - game.time);
        const frac = slot.def.cooldown > 0 ? Math.min(1, remaining / slot.def.cooldown) : 0;
        slot.cd.style.height = `${(frac * 100).toFixed(1)}%`;
        slot.cdText.textContent = remaining > 0.05 ? remaining.toFixed(1) : '';
        slot.root.classList.toggle('ready', remaining <= 0 && p.alive);

        const rank = p.abilityRanks[slot.def.id] ?? 0;
        if (rank !== slot.lastRank) {
          slot.lastRank = rank;
          const maxRank = slot.def.ranks.length - 1;
          let pipHtml = '';
          for (let r = 1; r <= maxRank; r++) {
            pipHtml += `<span class="pip${r <= rank ? ' on' : ''}"></span>`;
          }
          slot.pips.innerHTML = pipHtml;
        }
      }
    },
  });
}
