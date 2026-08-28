import type { StructureDef, UpgradeNode, WallTier } from '../sim/types';
import type { AbilityTreeNode } from '../sim/abilityTree';
import { escapeHtml } from './hud';

/** Owned by [ui]. Shared, stateless rendering widgets used by every menu in ui/menus.ts and
 *  ui/castleMenu.ts — panel chrome, gold-gated buttons, HP bars, stat formatting, and the
 *  generic upgrade-tree renderer (nodeState/branchColumns/upgradeNodeHtml). Split out of
 *  menus.ts to keep that file (and the new castle-menu module that needed the exact same
 *  upgrade-tree rendering for wall upgrades) under the ~400-line guideline — same reasoning
 *  sim/structures/*.ts split out of sim/structures.ts for. Every function here is pure (no
 *  GameState closure) so both menu modules can call it without importing each other. */

export const WALL_NAMES: Record<WallTier, string> = {
  1: 'Outer Wall',
  2: 'Middle Wall',
  3: 'The Keep',
};

type NodeState = 'owned' | 'available' | 'locked-requires' | 'locked-excluded';

/** Minimal shapes nodeState/branchColumns/upgradeNodeHtml actually need — narrower than
 *  StructureDef/StructureInstance so the castle menu's wall-upgrade tree (sim/wallUpgrades.ts's
 *  WALL_FORTIFY_NODES/WALL_EXPANSION_NODES, backed by Wall.purchased-via-wallPurchased() rather
 *  than a StructureInstance) can reuse the exact same rendering the socket menu uses for
 *  structures. StructureDef/StructureInstance already satisfy these structurally, so every
 *  existing socket-menu call site is unchanged. */
export interface UpgradeTreeOwner {
  upgrades: UpgradeNode[];
}
export interface UpgradeTreeHolder {
  purchased: string[];
}

export function nodeState(owner: UpgradeTreeOwner, holder: UpgradeTreeHolder, node: UpgradeNode): NodeState {
  if (holder.purchased.includes(node.id)) return 'owned';
  for (const ownedId of holder.purchased) {
    const owned = owner.upgrades.find((n) => n.id === ownedId);
    if (owned?.excludes?.includes(node.id)) return 'locked-excluded';
    if (node.excludes?.includes(ownedId)) return 'locked-excluded';
  }
  if (node.requires && !holder.purchased.includes(node.requires)) return 'locked-requires';
  return 'available';
}

/** Lay the upgrade tree out as columns: each requires-chain from a root node becomes a
 *  column, so exclusive branches (crossbow rapid vs ballista) sit side by side. Generic over
 *  any node list — works identically for 2 columns, 3 (a future crossbow third path), or the
 *  castle menu's own 4-wide fortification tree. */
export function branchColumns(owner: UpgradeTreeOwner): UpgradeNode[][] {
  const cols: UpgradeNode[][] = [];
  const placed = new Set<string>();
  for (const root of owner.upgrades.filter((n) => n.requires === null)) {
    const col: UpgradeNode[] = [root];
    placed.add(root.id);
    let cur: UpgradeNode = root;
    for (;;) {
      const next = owner.upgrades.find((n) => n.requires === cur.id && !placed.has(n.id));
      if (!next) break;
      col.push(next);
      placed.add(next.id);
      cur = next;
    }
    cols.push(col);
  }
  const rest = owner.upgrades.filter((n) => !placed.has(n.id));
  if (rest.length > 0) cols.push(rest);
  return cols;
}

/** `action` is the click handler's `data-action` for this node's buy button — 'upgrade-structure'
 *  for the socket menu, 'upgrade-wall' for the castle menu's wall tree (same visual, different
 *  sim call). `gold` is passed explicitly (not read off a closed-over GameState) so this stays
 *  callable from any menu module without importing another. */
export function upgradeNodeHtml(
  owner: UpgradeTreeOwner,
  holder: UpgradeTreeHolder,
  n: UpgradeNode,
  action: string,
  gold: number
): string {
  const state = nodeState(owner, holder, n);
  const name = escapeHtml(n.name);
  const desc = escapeHtml(n.desc);
  if (state === 'available') {
    return `<div class="upgrade-node available">
      <div class="row-name">${name}</div><div class="row-desc">${desc}</div>
      ${costBtn(action, n.id, 'Upgrade', n.cost, gold)}
    </div>`;
  }
  const badge =
    state === 'owned'
      ? `<div class="node-badge owned">✅ Owned</div>`
      : state === 'locked-requires'
        ? `<div class="node-badge">🔒 Requires ${escapeHtml(
            owner.upgrades.find((u) => u.id === n.requires)?.name ?? 'previous upgrade'
          )}</div>`
        : `<div class="node-badge">🚫 Other path chosen</div>`;
  return `<div class="upgrade-node ${state === 'owned' ? 'owned' : 'locked'}">
    <div class="row-name">${name}</div><div class="row-desc">${desc}</div>${badge}
  </div>`;
}

/** The Tab class menu's "Mastery" section for one ability — reuses branchColumns/upgradeNodeHtml
 *  exactly like the socket menu does for a structure's upgrades and the castle menu does for a
 *  wall's Fortify tree, so the visual language matches across every upgrade-tree screen in the
 *  game. Returns '' (nothing rendered) for abilities with no tree, so callers can splice this in
 *  unconditionally. `action` should already have the ability id encoded in it (e.g.
 *  `buyTree:${abilityId}`) since a bare node id isn't unique across abilities the way it is
 *  within one structure's own upgrade list. */
export function abilityTreeHtml(tree: AbilityTreeNode[], purchasedIds: string[], action: string, gold: number): string {
  if (tree.length === 0) return '';
  const owner: UpgradeTreeOwner = { upgrades: tree };
  const holder: UpgradeTreeHolder = { purchased: purchasedIds };
  const cols = branchColumns(owner)
    .map(
      (col) => `<div class="upgrade-col">${col.map((n) => upgradeNodeHtml(owner, holder, n, action, gold)).join('')}</div>`
    )
    .join('');
  return `<div class="menu-subheading">Mastery</div><div class="upgrade-cols">${cols}</div>`;
}

export function structureIcon(def: StructureDef): string {
  return def.socketKind === 'embrasure' ? '🏹' : '🛡️';
}

// Late-game ability Mastery trees (sim/abilityTree.ts) introduce a lot of new per-branch stat
// keys — kept out of the ability's own row-desc.stats line where they're not covered here, this
// map just makes the common/shared ones read as words instead of raw camelCase. A key missing
// from this map still renders (falls back to the bare key, see fmtStats below); the tree node's
// own prose `desc` (see data/<class>Tree.ts) is the primary way a player learns what a branch
// does, this line is a secondary "what am I currently getting" summary.
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
  stunDuration: 'Stun',
  stunRadius: 'Stun radius',
  reductionPct: 'Damage taken',
  autoFire: 'Full auto',
  count: 'Bolts',
  spreadDeg: 'Spread',
  stormCount: 'Fragments',
  stormDamage: 'Fragment dmg',
  stormRadius: 'Fragment radius',
  burnDps: 'Burn',
  frostDps: 'Frost burn',
  lingerSlowPct: 'Lingering slow',
  charges: 'Charges',
  reboundDamage: 'Rebound dmg',
  bleedDps: 'Bleed',
  killRefund: 'CD refund/kill',
  outerRadius: 'Outer radius',
  outerDamage: 'Outer dmg',
  vulnPct: 'Vulnerability',
  dmgBuffPct: 'Damage buff',
  knockback: 'Knockback',
  cooldownMult: 'Cooldown mult',
  aoeRadius: 'Splash radius',
  fireRateMult: 'Fire rate mult',
  chainJumps: 'Chain jumps',
  chainRadius: 'Chain radius',
  explodeRadius: 'Blast radius',
  explodeDamage: 'Blast dmg',
  markPct: 'Mark',
  crippleStackPct: 'Shred/stack',
  webRadius: 'Web radius',
  webSlowPct: 'Web slow',
  pullSpeedMult: 'Pull speed mult',
  pitonRadius: 'Piton radius',
  pitonDamage: 'Piton dmg',
  pitonPull: 'Piton pull',
  reductionPerHitPct: 'Reduction/hit',
  healPerHit: 'Heal/hit',
  stunPerTarget: 'Stun/target',
  stunCap: 'Stun cap',
  focusBonusDamage: 'Focus dmg',
  focusStunBonus: 'Focus stun',
  shieldAmount: 'Shield',
  thornsDamage: 'Thorns dmg',
  thornsRadius: 'Thorns radius',
  chargeReductionPct: 'Charge reduction',
  sweepRadius: 'Sweep radius',
  sweepDamage: 'Sweep dmg',
};

function fmtStatVal(key: string, v: number): string {
  // A damage-reduction buff reads as a reduction, so show it signed rather than as a bare
  // number the player has to guess the direction of.
  if (key === 'reductionPct' || key === 'chargeReductionPct') return `-${v}%`;
  // Generic suffix rules cover every Mastery-tree percent/duration stat above without needing
  // a per-key entry here too — only truly special formats (°, ✓) still need an exact match.
  if (key.endsWith('Pct')) return `${v}%`;
  if (key === 'duration' || key.endsWith('Duration')) return `${v}s`;
  if (key === 'arcDeg' || key === 'spreadDeg') return `${v}°`;
  // Flag-style stats (a rank that unlocks a behaviour rather than a value) read as a check,
  // not as "1".
  if (key === 'autoFire') return v ? '✓' : '—';
  return String(v);
}

export function fmtStats(stats: Record<string, number>): string {
  return Object.entries(stats)
    .map(([k, v]) => `${escapeHtml(STAT_LABELS[k] ?? k)} ${fmtStatVal(k, v)}`)
    .join(' · ');
}

export function bar(hp: number, maxHp: number): string {
  const pct = Math.max(0, Math.min(1, hp / maxHp)) * 100;
  const cls = pct > 60 ? 'ok' : pct > 25 ? 'warn' : 'low';
  return `<div class="bar wall-bar"><div class="bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div>
    <div class="bar-text">${Math.ceil(hp)} / ${maxHp}</div></div>`;
}

export function panel(title: string, body: string): string {
  return `<div class="menu-backdrop" data-action="close"></div>
    <div class="menu-panel">
      <div class="menu-title"><span>${title}</span><button class="btn btn-close" data-action="close">✕</button></div>
      <div class="menu-body">${body}</div>
      <div class="menu-foot">Esc to close</div>
    </div>`;
}

export function costBtn(action: string, arg: string, label: string, cost: number, gold: number): string {
  const cant = gold < cost;
  return `<button class="btn${cant ? ' disabled' : ''}" data-action="${action}" data-arg="${arg}"
    ${cant ? `title="Not enough gold"` : ''}>${label} · ${cost}💰</button>`;
}
