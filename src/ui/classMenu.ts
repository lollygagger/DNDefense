import type { GameState } from '../sim/GameState';
import {
  abilityTree,
  allAbilities,
  buyAbilityRank,
  buyAbilityTreeNode,
  getAbilityDef,
  getAbilityStats,
  nextRankCost,
  purchasedTreeNodes,
} from '../sim/classes';
import { escapeHtml } from './hud';
import { abilityTreeHtml, costBtn, fmtStats, panel } from './menuWidgets';

/** Owned by [ui]. The Tab class menu's rendering — split out of ui/menus.ts (which still owns
 *  opening/closing it and the keyboard binding) once each ability grew a late-game "Mastery"
 *  branching tree (sim/abilityTree.ts) alongside its linear ranks, the same reasoning
 *  ui/castleMenu.ts split out of ui/menus.ts for the wall upgrade tree. Reuses
 *  ui/menuWidgets.ts's abilityTreeHtml (itself built on the same branchColumns/upgradeNodeHtml
 *  the socket and castle menus use) so the visual language matches every upgrade-tree screen. */

const BUY_TREE_PREFIX = 'buyTree:';

/** Per-class menu icon. Mirrors ui/screens.ts's class-card icons so the Tab menu's header
 *  matches the card the player picked at the start screen. */
const CLASS_ICONS: Record<string, string> = { mage: '🧙', warrior: '🛡️', archer: '🏹', tank: '🧱' };
function classIcon(id: string): string {
  return CLASS_ICONS[id] ?? '⚔️';
}

export function renderClassMenu(game: GameState): string | null {
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
      const tree = abilityTreeHtml(abilityTree(a), purchasedTreeNodes(p, a.id), `${BUY_TREE_PREFIX}${a.id}`, game.gold);
      return `<div class="menu-row ability-row">
        <div class="ability-row-top">
          <div class="row-main">
            <div class="row-name">${a.icon} ${escapeHtml(a.name)}
              <span class="row-sub">[${hotkey}] · ${a.cooldown}s cd</span>
              <span class="slot-pips inline">${pips}</span>
            </div>
            <div class="row-desc">${escapeHtml(a.desc)}</div>
            <div class="row-desc stats">${stats}</div>
          </div>
          ${action}
        </div>
        ${tree}
      </div>`;
    })
    .join('');
  const header = `<div class="row-desc">${escapeHtml(p.classDef.desc)}</div>`;
  return panel(`${classIcon(p.classDef.id)} ${escapeHtml(p.classDef.name)} — Abilities`, header + rows);
}

/** Handles every click action this menu owns (`buy-rank` and the dynamic `buyTree:<abilityId>`
 *  Mastery-node purchases — see ui/menuWidgets.ts's abilityTreeHtml doc comment for why that one
 *  can't be a fixed switch-case literal). Returns false for anything it doesn't recognize, so
 *  ui/menus.ts's click handler can fall through to its own switch unchanged. */
export function handleClassMenuAction(game: GameState, action: string, arg: string): boolean {
  const p = game.localPlayer;
  if (!p) return false;
  if (action === 'buy-rank') {
    const cost = nextRankCost(p, arg);
    if (cost === null) {
      game.events.emit('ui:toast', { text: 'Cannot upgrade.' });
      return true;
    }
    if (game.gold < cost) {
      game.events.emit('ui:toast', { text: `Not enough gold — need ${cost}💰` });
      return true;
    }
    game.events.emit('ui:toast', { text: buyAbilityRank(game, p, arg) ? 'Ability improved! ⬆️' : 'Cannot upgrade.' });
    return true;
  }
  if (action.startsWith(BUY_TREE_PREFIX)) {
    const abilityId = action.slice(BUY_TREE_PREFIX.length);
    const def = getAbilityDef(p.classDef, abilityId);
    const node = def ? abilityTree(def).find((n) => n.id === arg) : null;
    if (!def || !node) return true;
    if (game.gold < node.cost) {
      game.events.emit('ui:toast', { text: `Not enough gold — need ${node.cost}💰` });
      return true;
    }
    const ok = buyAbilityTreeNode(game, p, def, arg);
    game.events.emit('ui:toast', { text: ok ? `${node.name} mastered! ⬆️` : 'Upgrade unavailable.' });
    return true;
  }
  return false;
}
