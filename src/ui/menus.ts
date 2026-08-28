import type { GameState } from '../sim/GameState';
import type { Socket, WallTier } from '../sim/types';
import { getStructureDef, getStructureDefsForSocket, nextUpgradeCost } from '../sim/structures';
import { WALL_UPGRADE_TREE } from '../sim/wallUpgrades';
import { anyOverlayOpen, escapeHtml, overlayClosed, overlayOpened } from './hud';
import { renderCastleMenu as renderCastleMenuHtml } from './castleMenu';
import { handleClassMenuAction, renderClassMenu as renderClassMenuHtml } from './classMenu';
import { branchColumns, costBtn, panel, structureIcon, upgradeNodeHtml, WALL_NAMES } from './menuWidgets';

/** Owned by [ui]. The three in-game menus (mutually exclusive):
 *  E = socket build/upgrade, B = castle walls, Tab = class upgrades. Esc closes.
 *  Reads sim state + calls sim APIs only — never mutates state directly. Shared rendering
 *  widgets (panel chrome, upgrade-tree columns, stat formatting) live in ui/menuWidgets.ts; the
 *  castle menu's own wall-upgrade-tree rendering lives in ui/castleMenu.ts, and the Tab class
 *  menu's (linear ranks + late-game Mastery trees) lives in ui/classMenu.ts — all three split out
 *  to keep this file under the ~400-line guideline. */

/** Non-frozen wall-upgrade extension of CastleApi, read via a narrow local interface + cast —
 *  the same pattern sim/projectiles.ts uses for blocksProjectile (see docs/ARCHITECTURE.md).
 *  Wall (sim/types.ts) is FROZEN and has no room for a per-wall purchased-upgrade list, so
 *  sim/castle.ts keeps it internally and exposes just this call (ui/castleMenu.ts declares its
 *  own copy for the read-only half it needs — see that file's comment). */
interface WallUpgradable {
  upgradeWall(tier: WallTier, nodeId: string): boolean;
}

const SOCKET_RANGE = 6;
const MENU_REFRESH_S = 0.25; // live re-render cadence while a menu is open (HP bars etc.)

type MenuId = 'socket' | 'castle' | 'class';

export function initMenus(game: GameState): void {
  const ui = document.getElementById('ui')!;
  ui.insertAdjacentHTML(
    'beforeend',
    `<div id="menu-root" style="display:none"></div>
     <div id="socket-hint" style="display:none"></div>`
  );
  const root = document.getElementById('menu-root')!;
  const hint = document.getElementById('socket-hint')!;

  let open: MenuId | null = null;
  let socketId: string | null = null;
  // Which wall (if any) the castle menu has drilled into — see the "castle menu" section below.
  let castleWallFocus: WallTier | null = null;
  let lastRefresh = 0;

  const toast = (text: string): void => game.events.emit('ui:toast', { text });

  // ---------- open/close ----------

  /** Last HTML actually written to the DOM, so an unchanged live refresh can be skipped entirely
   *  — see renderMenu(). Cleared on close so reopening always rebuilds. */
  let lastHtml: string | null = null;

  /** True between pointerdown and pointerup anywhere on the page. The live refresh is held off
   *  while it's set: replacing root.innerHTML mid-press destroys the element the user pressed
   *  down on, and the browser then fires no `click` at all (a click requires down and up to land
   *  on the same element), so the press is silently swallowed. That was the "I had to click the
   *  ✕ three times" bug — a 250ms refresh cadence against a ~100ms click eats a large share of
   *  them, at random. */
  let pressActive = false;
  document.addEventListener('pointerdown', () => { pressActive = true; }, true);
  document.addEventListener('pointerup', () => { pressActive = false; }, true);
  document.addEventListener('pointercancel', () => { pressActive = false; }, true);
  addEventListener('blur', () => { pressActive = false; });

  function close(): void {
    if (open === null) return;
    open = null;
    socketId = null;
    castleWallFocus = null;
    root.style.display = 'none';
    root.innerHTML = '';
    lastHtml = null;
    overlayClosed('menu');
    // Take the mouse back from within the gesture that closed the menu (the ✕ click, or Esc), so
    // play resumes immediately instead of needing another click on the world. Best-effort: it
    // legitimately rejects when close() came from a render-driven auto-close rather than a user
    // gesture, or inside the browser's brief cooldown after an Esc-initiated unlock — in both
    // cases the canvas click handler in player/controller.ts is still there as the way back in.
    if (anyOverlayOpen()) return; // something else (the pause screen) owns the pointer now
    if (game.phase !== 'build' && game.phase !== 'combat') return;
    const canvas = document.querySelector('canvas');
    const ret = canvas?.requestPointerLock() as unknown;
    (ret as Promise<void> | undefined)?.catch(() => {});
  }

  function toggle(id: MenuId): void {
    if (open === id) {
      close();
      return;
    }
    if (id === 'socket') {
      const p = game.localPlayer;
      const socket = p ? game.castle.getSocketNear(p.pos, SOCKET_RANGE) : null;
      if (!socket) return; // no socket in reach — ignore the keypress
      socketId = socket.id;
    }
    open = id;
    root.style.display = '';
    overlayOpened('menu');
    renderMenu();
  }

  function renderMenu(): void {
    if (open === null) return;
    // Guarded here rather than only at the throttled call site below, because the event-driven
    // refreshes (gold:changed fires on every kill) reach this function directly and would
    // otherwise still be able to destroy a button mid-press. Whatever is skipped here is picked
    // up by the next throttled refresh once the button comes back up.
    if (pressActive) return;
    let html: string | null;
    if (open === 'socket') html = renderSocketMenu();
    else if (open === 'castle') html = renderCastleMenu();
    else html = renderClassMenuHtml(game);
    if (html === null) {
      close();
      return;
    }
    // Nothing rendered differently, so leave the DOM completely alone. The live refresh exists
    // for values that move during combat (wall HP bars, affordability as gold comes in); in the
    // build phase — where nearly all menu clicking happens — nothing changes between actions, so
    // this turns the 250ms rebuild into a no-op instead of a quarter-second window in which a
    // press can be destroyed mid-click. Cheap string compare against a DOM subtree rebuild.
    if (html === lastHtml) return;

    // Preserve the body's scroll offset across the throttled live re-render. This rebuilds the
    // whole subtree, which destroys the scrolled element — without this, scrolling a tall menu
    // (the castle Fortify screen) snaps straight back to the top and the panel is unusable.
    const prevScroll = root.querySelector<HTMLElement>('.menu-body')?.scrollTop ?? 0;
    root.innerHTML = html;
    lastHtml = html;
    if (prevScroll > 0) {
      const body = root.querySelector<HTMLElement>('.menu-body');
      if (body) body.scrollTop = prevScroll; // clamps itself if the content got shorter
    }
  }

  // ---------- socket menu ----------

  function renderSocketMenu(): string | null {
    const socket = socketId ? game.castle.getSocketById(socketId) : null;
    if (!socket) return null;
    const wall = game.castle.walls[socket.tier - 1];
    if (!wall || !wall.built || wall.hp <= 0) return null; // wall fell — menu closes
    const kindName = socket.kind === 'embrasure' ? 'Embrasure' : 'Chamber';

    if (!socket.structure) {
      const defs = getStructureDefsForSocket(socket.kind);
      const rows =
        defs
          .map(
            (d) => `<div class="menu-row">
              <div class="row-main">
                <div class="row-name">${structureIcon(d)} ${escapeHtml(d.name)}</div>
                <div class="row-desc">${escapeHtml(d.desc)}</div>
              </div>
              ${costBtn('build-structure', d.id, 'Build', d.cost, game.gold)}
            </div>`
          )
          .join('') ||
        `<div class="menu-empty">No structures available for this socket type yet.</div>`;
      return panel(`🧱 Empty ${kindName} — ${WALL_NAMES[socket.tier]}`, rows);
    }

    const inst = socket.structure;
    const def = getStructureDef(inst.defId);
    if (!def) return panel('Structure', `<div class="menu-empty">Unknown structure.</div>`);

    const cols = branchColumns(def)
      .map(
        (col) =>
          `<div class="upgrade-col">${col.map((n) => upgradeNodeHtml(def, inst, n, 'upgrade-structure', game.gold)).join('')}</div>`
      )
      .join('');
    const body = `<div class="row-desc">${escapeHtml(def.desc)}</div>
      ${def.upgrades.length > 0 ? `<div class="upgrade-cols">${cols}</div>` : `<div class="menu-empty">No upgrades.</div>`}`;
    return panel(`${structureIcon(def)} ${escapeHtml(def.name)} — ${WALL_NAMES[socket.tier]}`, body);
  }

  // ---------- castle menu ----------
  // Rendering (wall list + the "Fortify ▸" drill-down into one wall's upgrade tree) lives in
  // ui/castleMenu.ts; this module just owns the open/close/focus state and wires it in, exactly
  // like every other menu here.

  function renderCastleMenu(): string {
    const result = renderCastleMenuHtml(game, castleWallFocus);
    castleWallFocus = result.focus;
    return result.html;
  }

  // Tab class menu rendering (linear ranks + late-game Mastery trees) lives entirely in
  // ui/classMenu.ts — renderClassMenuHtml above, handleClassMenuAction in the click handler
  // below — exactly like the castle menu's split.

  // ---------- actions (delegated clicks) ----------

  function trySpendAction(cost: number, doIt: () => boolean, okMsg: string, failMsg: string): void {
    if (game.gold < cost) {
      toast(`Not enough gold — need ${cost}💰`);
      return;
    }
    toast(doIt() ? okMsg : failMsg);
  }

  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn || btn.classList.contains('disabled')) return;
    const action = btn.dataset.action!;
    const arg = btn.dataset.arg ?? '';

    if (action === 'close') {
      close();
      return;
    }
    // Tab class menu's own actions (buy-rank, and the dynamic buyTree:<abilityId> Mastery-node
    // purchases) — delegated to ui/classMenu.ts, which emits its own toasts since it doesn't
    // share this function's trySpendAction helper.
    if (handleClassMenuAction(game, action, arg)) {
      renderMenu();
      return;
    }
    const socket = socketId ? game.castle.getSocketById(socketId) : null;
    switch (action) {
      case 'build-structure': {
        const def = getStructureDef(arg);
        if (!socket || !def) break;
        trySpendAction(
          def.cost,
          () => game.castle.buildStructure(socket.id, arg),
          `${def.name} built! 🔨`,
          `Cannot build here.`
        );
        break;
      }
      case 'upgrade-structure': {
        if (!socket || !socket.structure) break;
        const def = getStructureDef(socket.structure.defId);
        const node = def?.upgrades.find((n) => n.id === arg);
        if (!def || !node) break;
        trySpendAction(
          node.cost,
          () => game.castle.upgradeStructure(socket.id, arg),
          `${node.name} purchased! ✨`,
          `Upgrade unavailable.`
        );
        break;
      }
      case 'build-wall': {
        const tier = Number(arg) as WallTier;
        const w = game.castle.walls[tier - 1];
        if (!w) break;
        trySpendAction(
          w.cost,
          () => game.castle.buildWall(tier),
          `${WALL_NAMES[tier]} raised! 🧱`,
          `Cannot build that wall.`
        );
        break;
      }
      case 'repair-wall': {
        const tier = Number(arg) as WallTier;
        trySpendAction(
          game.castle.repairCost(tier),
          () => game.castle.repairWall(tier),
          `${WALL_NAMES[tier]} repaired! 🔧`,
          `Nothing to repair.`
        );
        break;
      }
      case 'focus-wall': {
        castleWallFocus = Number(arg) as WallTier;
        break;
      }
      case 'unfocus-wall': {
        castleWallFocus = null;
        break;
      }
      case 'upgrade-wall': {
        if (castleWallFocus === null) break;
        const tier = castleWallFocus;
        const node = WALL_UPGRADE_TREE.find((n) => n.id === arg);
        if (!node) break;
        trySpendAction(
          node.cost,
          () => (game.castle as unknown as WallUpgradable).upgradeWall(tier, arg),
          `${node.name} built! 🏗️`,
          `Upgrade unavailable.`
        );
        break;
      }
    }
    renderMenu(); // immediate feedback after any action
  });

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    const inGame = game.phase === 'build' || game.phase === 'combat';
    if (e.key === 'Tab' && inGame) e.preventDefault(); // never let Tab move browser focus mid-game
    if (!inGame) return;
    if (anyOverlayOpen() && open === null) return; // a screen (not ours) is open
    switch (e.key) {
      case 'Escape':
        close();
        break;
      case 'e':
      case 'E':
        toggle('socket');
        break;
      case 'b':
      case 'B':
        toggle('castle');
        break;
      case 'Tab':
        toggle('class');
        break;
    }
  });

  // ---------- refresh on relevant events ----------

  const rerender = (): void => {
    if (open !== null) renderMenu();
  };
  game.events.on('gold:changed', rerender);
  game.events.on('structure:built', rerender);
  game.events.on('structure:destroyed', rerender);
  game.events.on('wall:built', rerender);
  game.events.on('wall:destroyed', rerender);
  game.events.on('game:over', close);
  game.events.on('phase:changed', ({ phase }) => {
    if (phase === 'gameover' || phase === 'menu') close();
  });

  // ---------- per-frame: socket hint + live menu refresh ----------

  game.addSystem({
    render() {
      const inGame = game.phase === 'build' || game.phase === 'combat';

      // throttled live refresh of the open menu (wall HP bars during combat etc.)
      // renderMenu() enforces the press guard itself; repeating it here keeps lastRefresh from
      // advancing while a press defers the refresh, so the update lands on the first frame after
      // the button comes back up rather than waiting another full cadence.
      if (open !== null && !pressActive) {
        const now = performance.now() / 1000;
        if (now - lastRefresh > MENU_REFRESH_S) {
          lastRefresh = now;
          renderMenu();
        }
      }

      // passive "[E] ..." hint when a socket is in range and no overlay is open
      let text: string | null = null;
      if (inGame && !anyOverlayOpen()) {
        const p = game.localPlayer;
        const socket = p && p.alive ? game.castle.getSocketNear(p.pos, SOCKET_RANGE) : null;
        if (socket) text = hintText(socket);
      }
      if (text === null) {
        hint.style.display = 'none';
      } else {
        hint.style.display = '';
        if (hint.textContent !== text) hint.textContent = text;
      }
    },
  });

  function hintText(socket: Socket): string {
    if (!socket.structure) {
      return `[E] Empty ${socket.kind === 'embrasure' ? 'embrasure' : 'chamber'} — build a defense`;
    }
    const def = getStructureDef(socket.structure.defId);
    if (!def) return `[E] Structure`;
    // Same helper the socket beacons in render/castleView.ts use, so the hint and the beacon
    // colour always agree about whether there's anything left to buy here.
    const cost = nextUpgradeCost(socket.structure);
    if (cost === null) return `[E] ${def.name} — fully upgraded`;
    return `[E] ${def.name} — upgrades available${game.gold >= cost ? '' : ` (${cost}g)`}`;
  }
}
