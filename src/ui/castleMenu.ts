import type { GameState } from '../sim/GameState';
import type { Wall, WallTier } from '../sim/types';
import { WALL_EXPANSION_NODES, WALL_FORTIFY_NODES } from '../sim/wallUpgrades';
import { bar, branchColumns, costBtn, panel, upgradeNodeHtml, WALL_NAMES, type UpgradeTreeHolder } from './menuWidgets';

/** Owned by [ui]. The B castle menu's rendering — split out of ui/menus.ts (which still owns
 *  opening/closing it, the keyboard binding, and the click-action dispatch) once the wall
 *  upgrade tree grew this from "3 rows with a Repair button" into a real drill-down screen.
 *  Wall list by default; clicking "Fortify ▸" on a built wall shows that one wall's full upgrade
 *  tree (fortification stat upgrades + socket-expansion nodes), reusing the exact same
 *  branchColumns/upgradeNodeHtml rendering (ui/menuWidgets.ts) the socket menu uses for
 *  structures — the task's explicit ask for a consistent visual language. Kept as a drill-down
 *  rather than expanding all 3 walls inline: one wall's tree is already 4 (fortify) + 2
 *  (expansion) columns, and three of those stacked in a 620px panel would stop being readable. */

/** Non-frozen wall-upgrade extension of CastleApi, read via a narrow local interface + cast —
 *  the same pattern sim/projectiles.ts uses for blocksProjectile (see docs/ARCHITECTURE.md).
 *  Wall (sim/types.ts) is FROZEN and has no room for a per-wall purchased-upgrade list, so
 *  sim/castle.ts keeps it internally and exposes just this query. ui/menus.ts declares its own
 *  copy of this interface for the parts of the same extension it calls directly (upgradeWall) —
 *  matching the codebase's convention of each consumer declaring the narrow slice it needs
 *  (see sim/structures/crossbow.ts's own local CastleBlocking vs sim/projectiles.ts's). */
interface WallUpgradable {
  wallPurchased(tier: WallTier): string[];
}

/** Result of a render: `focus` echoes back the (possibly corrected) drill-down state, since this
 *  module is stateless — ui/menus.ts owns `castleWallFocus` and just assigns whatever comes back
 *  (e.g. reset to null if the focused wall fell mid-view). */
export interface CastleMenuResult {
  html: string;
  focus: WallTier | null;
}

export function renderCastleMenu(game: GameState, focus: WallTier | null): CastleMenuResult {
  if (focus !== null) {
    const w = game.castle.walls[focus - 1];
    if (w && w.built) {
      return { html: panel(`🏯 ${WALL_NAMES[w.tier]} — Fortifications`, wallDetailHtml(game, w)), focus };
    }
    // the focused wall fell or was never built — fall back to the list
  }
  const rows = game.castle.walls.map((w) => wallRowHtml(game, w)).join('');
  return { html: panel('🏰 Castle Walls', rows), focus: null };
}

function wallRowHtml(game: GameState, w: Wall): string {
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
    <div class="row-action">
      ${repairBtn}
      <button class="btn" data-action="focus-wall" data-arg="${w.tier}">Fortify ▸</button>
    </div>
  </div>`;
}

/** The focused wall's full detail: HP/repair (same as the list row) plus its two upgrade-node
 *  groups. Both groups reuse branchColumns()/upgradeNodeHtml() — the wall's `purchased` list
 *  isn't a StructureInstance (Wall is FROZEN with no room for one; see sim/castle.ts's
 *  wallPurchased()), so it's wrapped in a plain { purchased } holder that structurally satisfies
 *  UpgradeTreeHolder, same idea as the { upgrades } owner wrapping each node group. */
function wallDetailHtml(game: GameState, w: Wall): string {
  const cost = game.castle.repairCost(w.tier);
  const full = w.hp >= w.maxHp;
  const repairBtn = full
    ? `<button class="btn disabled">Repair · —</button>`
    : costBtn('repair-wall', String(w.tier), 'Repair', cost, game.gold);
  const purchased = (game.castle as unknown as WallUpgradable).wallPurchased(w.tier);
  const holder: UpgradeTreeHolder = { purchased };

  const fortifyCols = branchColumns({ upgrades: WALL_FORTIFY_NODES })
    .map(
      (col) =>
        `<div class="upgrade-col">${col
          .map((n) => upgradeNodeHtml({ upgrades: WALL_FORTIFY_NODES }, holder, n, 'upgrade-wall', game.gold))
          .join('')}</div>`
    )
    .join('');
  const expansionCols = branchColumns({ upgrades: WALL_EXPANSION_NODES })
    .map(
      (col) =>
        `<div class="upgrade-col">${col
          .map((n) => upgradeNodeHtml({ upgrades: WALL_EXPANSION_NODES }, holder, n, 'upgrade-wall', game.gold))
          .join('')}</div>`
    )
    .join('');

  return `<div class="menu-row">
      <button class="btn" data-action="unfocus-wall">‹ All Walls</button>
      ${repairBtn}
    </div>
    <div class="row-main">
      <div class="row-name">🏯 ${WALL_NAMES[w.tier]}</div>
      ${bar(w.hp, w.maxHp)}
      ${w.tier === 3 ? `<div class="row-desc danger">💀 If the Keep falls, the run ends.</div>` : ''}
    </div>
    <div class="menu-subheading">Fortifications</div>
    <div class="upgrade-cols">${fortifyCols}</div>
    <div class="menu-subheading">Expand the Wall</div>
    <div class="upgrade-cols">${expansionCols}</div>`;
}
