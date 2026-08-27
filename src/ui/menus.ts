import type { GameState } from '../sim/GameState';
import type {
  Socket,
  StructureDef,
  StructureInstance,
  UpgradeNode,
  Wall,
  WallTier,
} from '../sim/types';
import { getStructureDef, getStructureDefsForSocket } from '../sim/structures';
import { allAbilities, buyAbilityRank, getAbilityStats, nextRankCost } from '../sim/classes';
import { anyOverlayOpen, escapeHtml, overlayClosed, overlayOpened } from './hud';

/** Owned by [ui]. The three in-game menus (mutually exclusive):
 *  E = socket build/upgrade, B = castle walls, Tab = class upgrades. Esc closes.
 *  Reads sim state + calls sim APIs only — never mutates state directly. */

const SOCKET_RANGE = 6;
const MENU_REFRESH_S = 0.25; // live re-render cadence while a menu is open (HP bars etc.)

type MenuId = 'socket' | 'castle' | 'class';

const WALL_NAMES: Record<WallTier, string> = {
  1: 'Outer Wall',
  2: 'Middle Wall',
  3: 'The Keep',
};

type NodeState = 'owned' | 'available' | 'locked-requires' | 'locked-excluded';

function nodeState(def: StructureDef, inst: StructureInstance, node: UpgradeNode): NodeState {
  if (inst.purchased.includes(node.id)) return 'owned';
  for (const ownedId of inst.purchased) {
    const owned = def.upgrades.find((n) => n.id === ownedId);
    if (owned?.excludes?.includes(node.id)) return 'locked-excluded';
    if (node.excludes?.includes(ownedId)) return 'locked-excluded';
  }
  if (node.requires && !inst.purchased.includes(node.requires)) return 'locked-requires';
  return 'available';
}

/** Lay the upgrade tree out as columns: each requires-chain from a root node becomes a
 *  column, so exclusive branches (crossbow rapid vs ballista) sit side by side. */
function branchColumns(def: StructureDef): UpgradeNode[][] {
  const cols: UpgradeNode[][] = [];
  const placed = new Set<string>();
  for (const root of def.upgrades.filter((n) => n.requires === null)) {
    const col: UpgradeNode[] = [root];
    placed.add(root.id);
    let cur: UpgradeNode = root;
    for (;;) {
      const next = def.upgrades.find((n) => n.requires === cur.id && !placed.has(n.id));
      if (!next) break;
      col.push(next);
      placed.add(next.id);
      cur = next;
    }
    cols.push(col);
  }
  const rest = def.upgrades.filter((n) => !placed.has(n.id));
  if (rest.length > 0) cols.push(rest);
  return cols;
}

function structureIcon(def: StructureDef): string {
  return def.socketKind === 'embrasure' ? '🏹' : '🛡️';
}

const STAT_LABELS: Record<string, string> = {
  damage: 'Damage',
  speed: 'Speed',
  radius: 'Radius',
  slowPct: 'Slow',
  duration: 'Duration',
  range: 'Range',
  arcDeg: 'Arc',
  pierce: 'Pierces',
  heal: 'Heal',
};

function fmtStatVal(key: string, v: number): string {
  if (key === 'slowPct') return `${v}%`;
  if (key === 'duration') return `${v}s`;
  if (key === 'arcDeg') return `${v}°`;
  return String(v);
}

function fmtStats(stats: Record<string, number>): string {
  return Object.entries(stats)
    .map(([k, v]) => `${escapeHtml(STAT_LABELS[k] ?? k)} ${fmtStatVal(k, v)}`)
    .join(' · ');
}

function bar(hp: number, maxHp: number): string {
  const pct = Math.max(0, Math.min(1, hp / maxHp)) * 100;
  const cls = pct > 60 ? 'ok' : pct > 25 ? 'warn' : 'low';
  return `<div class="bar wall-bar"><div class="bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div>
    <div class="bar-text">${Math.ceil(hp)} / ${maxHp}</div></div>`;
}

function panel(title: string, body: string): string {
  return `<div class="menu-backdrop" data-action="close"></div>
    <div class="menu-panel">
      <div class="menu-title"><span>${title}</span><button class="btn btn-close" data-action="close">✕</button></div>
      <div class="menu-body">${body}</div>
      <div class="menu-foot">Esc to close</div>
    </div>`;
}

function costBtn(action: string, arg: string, label: string, cost: number, gold: number): string {
  const cant = gold < cost;
  return `<button class="btn${cant ? ' disabled' : ''}" data-action="${action}" data-arg="${arg}"
    ${cant ? `title="Not enough gold"` : ''}>${label} · ${cost}💰</button>`;
}

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
  let lastRefresh = 0;

  const toast = (text: string): void => game.events.emit('ui:toast', { text });

  // ---------- open/close ----------

  function close(): void {
    if (open === null) return;
    open = null;
    socketId = null;
    root.style.display = 'none';
    root.innerHTML = '';
    overlayClosed('menu');
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
    let html: string | null;
    if (open === 'socket') html = renderSocketMenu();
    else if (open === 'castle') html = renderCastleMenu();
    else html = renderClassMenu();
    if (html === null) {
      close();
      return;
    }
    root.innerHTML = html;
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
          `<div class="upgrade-col">${col.map((n) => upgradeNodeHtml(def, inst, n)).join('')}</div>`
      )
      .join('');
    const body = `<div class="row-desc">${escapeHtml(def.desc)}</div>
      ${def.upgrades.length > 0 ? `<div class="upgrade-cols">${cols}</div>` : `<div class="menu-empty">No upgrades.</div>`}`;
    return panel(`${structureIcon(def)} ${escapeHtml(def.name)} — ${WALL_NAMES[socket.tier]}`, body);
  }

  function upgradeNodeHtml(def: StructureDef, inst: StructureInstance, n: UpgradeNode): string {
    const state = nodeState(def, inst, n);
    const name = escapeHtml(n.name);
    const desc = escapeHtml(n.desc);
    if (state === 'available') {
      return `<div class="upgrade-node available">
        <div class="row-name">${name}</div><div class="row-desc">${desc}</div>
        ${costBtn('upgrade-structure', n.id, 'Upgrade', n.cost, game.gold)}
      </div>`;
    }
    const badge =
      state === 'owned'
        ? `<div class="node-badge owned">✅ Owned</div>`
        : state === 'locked-requires'
          ? `<div class="node-badge">🔒 Requires ${escapeHtml(
              def.upgrades.find((u) => u.id === n.requires)?.name ?? 'previous upgrade'
            )}</div>`
          : `<div class="node-badge">🚫 Other path chosen</div>`;
    return `<div class="upgrade-node ${state === 'owned' ? 'owned' : 'locked'}">
      <div class="row-name">${name}</div><div class="row-desc">${desc}</div>${badge}
    </div>`;
  }

  // ---------- castle menu ----------

  function renderCastleMenu(): string {
    const rows = game.castle.walls.map((w) => wallRowHtml(w)).join('');
    return panel('🏰 Castle Walls', rows);
  }

  function wallRowHtml(w: Wall): string {
    const name = `${WALL_NAMES[w.tier]} <span class="row-sub">(Tier ${w.tier})</span>`;
    if (!w.built) {
      return `<div class="menu-row">
        <div class="row-main">
          <div class="row-name">🧱 ${name}</div>
          <div class="row-desc">Rubble — enemies pass freely until rebuilt.</div>
        </div>
        ${costBtn('build-wall', String(w.tier), 'Build', w.cost, game.gold)}
      </div>`;
    }
    const cost = game.castle.repairCost(w.tier);
    const full = w.hp >= w.maxHp;
    const note =
      w.tier === 3 ? `<div class="row-desc danger">💀 If the Keep falls, the run ends.</div>` : '';
    const repairBtn = full
      ? `<button class="btn disabled">Repair · —</button>`
      : costBtn('repair-wall', String(w.tier), 'Repair', cost, game.gold);
    return `<div class="menu-row">
      <div class="row-main">
        <div class="row-name">🏯 ${name}</div>
        ${bar(w.hp, w.maxHp)}
        ${note}
      </div>
      ${repairBtn}
    </div>`;
  }

  // ---------- class menu ----------

  function renderClassMenu(): string | null {
    const p = game.localPlayer;
    if (!p) return null;
    const abilities = allAbilities(p.classDef);
    const rows = abilities
      .map((a, i) => {
        const hotkey = i === 0 ? 'LMB' : String(i + 1);
        const rank = p.abilityRanks[a.id] ?? 0;
        const maxRank = a.ranks.length - 1;
        let pips = '';
        for (let r = 1; r <= maxRank; r++) pips += `<span class="pip${r <= rank ? ' on' : ''}"></span>`;
        const stats = fmtStats(getAbilityStats(p, a.id));
        const cost = nextRankCost(p, a.id);
        let action: string;
        if (cost === null) {
          action = `<div class="node-badge owned">MAX</div>`;
        } else {
          const nextStats = fmtStats(a.ranks[rank + 1]?.stats ?? {});
          action = `<div class="row-action">
            ${costBtn('buy-rank', a.id, 'Upgrade', cost, game.gold)}
            <div class="row-desc next-stats">Next: ${nextStats}</div>
          </div>`;
        }
        return `<div class="menu-row">
          <div class="row-main">
            <div class="row-name">${a.icon} ${escapeHtml(a.name)}
              <span class="row-sub">[${hotkey}] · ${a.cooldown}s cd</span>
              <span class="slot-pips inline">${pips}</span>
            </div>
            <div class="row-desc">${escapeHtml(a.desc)}</div>
            <div class="row-desc stats">${stats}</div>
          </div>
          ${action}
        </div>`;
      })
      .join('');
    const header = `<div class="row-desc">${escapeHtml(p.classDef.desc)}</div>`;
    return panel(`🧙 ${escapeHtml(p.classDef.name)} — Abilities`, header + rows);
  }

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
      case 'buy-rank': {
        const p = game.localPlayer;
        if (!p) break;
        const cost = nextRankCost(p, arg);
        if (cost === null) break;
        trySpendAction(
          cost,
          () => buyAbilityRank(game, p, arg),
          `Ability improved! ⬆️`,
          `Cannot upgrade.`
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
      if (open !== null) {
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
    const inst = socket.structure;
    const hasUpgrade = def.upgrades.some((n) => nodeState(def, inst, n) === 'available');
    return `[E] ${def.name}${hasUpgrade ? ' — upgrades available' : ''}`;
  }
}
