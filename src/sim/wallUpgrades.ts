import type { GameState } from './GameState';
import type { SocketKind, UpgradeNode, Wall } from './types';
import { applySlow } from './status';
import {
  EXTRA_CHAMBER_XS,
  EXTRA_EMBRASURE_XS,
  MACHICOLATION_MAX_DY,
  WALL_HALF_WIDTH,
  WALL_UPGRADES,
} from '../data/castle';

/** Owned by [world-castle]. Per-wall upgrade tree definitions + the (pure, GameState-light)
 *  logic that applies them — split out of sim/castle.ts to keep that file under the ~400-line
 *  guideline (same reasoning sim/structures/*.ts split out of sim/structures.ts for).
 *
 *  Walls need a `purchased: string[]` list exactly like a StructureInstance's, but `Wall`
 *  (sim/types.ts) is FROZEN and has no such field. sim/castle.ts keeps that list itself (a
 *  WeakMap keyed on the Wall object) and reads/writes it through the small `purchasedFor`
 *  callback threaded into `tickWallEffects` below — the "adapter code in your own module, not a
 *  frozen-file edit" pattern the architecture doc calls for, same shape as blocksProjectile. */

// ---- Fortification branch: pure stat/behavior upgrades, no new sockets ----
export const WALL_FORTIFY_NODES: UpgradeNode[] = [
  {
    id: 'reinforced1',
    name: 'Reinforced Stone',
    desc: `Thicker facing stone shrugs off the first blow — ${Math.round(WALL_UPGRADES.reinforced1.reductionPct * 100)}% less damage from every hit against this wall.`,
    cost: WALL_UPGRADES.reinforced1.cost,
    requires: null,
  },
  {
    id: 'reinforced2',
    name: 'Masoned Core',
    desc: `A dressed-stone core replaces the rubble fill — ${Math.round(WALL_UPGRADES.reinforced2.reductionPct * 100)}% total damage reduction, so even an Orc Bruiser's hits are blunted.`,
    cost: WALL_UPGRADES.reinforced2.cost,
    requires: 'reinforced1',
  },
  {
    id: 'machicolations1',
    name: 'Machicolations',
    desc: `Stone galleries jut from the parapet so defenders can drop stones on anyone hugging the base — ${WALL_UPGRADES.machicolations1.dps} dmg/s to enemies battering this wall, blind spot or not.`,
    cost: WALL_UPGRADES.machicolations1.cost,
    requires: null,
  },
  {
    id: 'machicolations2',
    name: 'Boiling Oil',
    desc: `Cauldrons of oil replace loose stones — ${WALL_UPGRADES.machicolations2.dps} dmg/s (total), and it scalds attackers with a ${Math.round(WALL_UPGRADES.machicolations2.slowPct * 100)}% slow.`,
    cost: WALL_UPGRADES.machicolations2.cost,
    requires: 'machicolations1',
  },
  {
    id: 'battlements1',
    name: 'Higher Battlements',
    desc: 'Taller merlons on this wall give defenders deeper cover from ranged attacks and diving flyers.',
    cost: WALL_UPGRADES.battlements1.cost,
    requires: null,
  },
  {
    id: 'battlements2',
    name: 'Towering Battlements',
    desc: 'Raised again — this wall top is now a proper bastion.',
    cost: WALL_UPGRADES.battlements2.cost,
    requires: 'battlements1',
  },
  {
    id: 'autoRepair',
    name: 'Standing Repair Crew',
    desc: `A crew of masons quietly patches cracks between waves — ${WALL_UPGRADES.autoRepair.hpPerSec} wall HP/s regenerated for free, intermission only.`,
    cost: WALL_UPGRADES.autoRepair.cost,
    requires: null,
  },
];

// ---- Expansion branch: unlocks a brand-new socket at a fixed, pre-vetted position. Buying one
// of these both records the purchase AND (see sim/castle.ts's upgradeWall) pushes a real Socket
// onto the wall — extraSocketSpecFor is the id -> geometry lookup that makes that possible. ----
export interface ExtraSocketSpec {
  kind: SocketKind;
  x: number;
  index: number; // continues that kind's existing id sequence (e.g. embrasure 0,1,2 -> 3,4)
}

const EXTRA_SOCKET_SPECS: Record<string, ExtraSocketSpec> = {
  extraEmbrasure1: { kind: 'embrasure', x: EXTRA_EMBRASURE_XS[0], index: 3 },
  extraEmbrasure2: { kind: 'embrasure', x: EXTRA_EMBRASURE_XS[1], index: 4 },
  extraChamber1: { kind: 'chamber', x: EXTRA_CHAMBER_XS[0], index: 2 },
  extraChamber2: { kind: 'chamber', x: EXTRA_CHAMBER_XS[1], index: 3 },
};

export const WALL_EXPANSION_NODES: UpgradeNode[] = [
  {
    id: 'extraEmbrasure1',
    name: 'West Bastion',
    desc: 'Break open a new embrasure on the west flank for another static defense.',
    cost: WALL_UPGRADES.extraEmbrasure1.cost,
    requires: null,
  },
  {
    id: 'extraEmbrasure2',
    name: 'East Bastion',
    desc: 'Mirror it on the east flank.',
    cost: WALL_UPGRADES.extraEmbrasure2.cost,
    requires: 'extraEmbrasure1',
  },
  {
    id: 'extraChamber1',
    name: 'West Annex',
    desc: 'Extend the courtyard with a second chamber to the west for another spawner.',
    cost: WALL_UPGRADES.extraChamber1.cost,
    requires: null,
  },
  {
    id: 'extraChamber2',
    name: 'East Annex',
    desc: 'And a matching annex to the east.',
    cost: WALL_UPGRADES.extraChamber2.cost,
    requires: 'extraChamber1',
  },
];

/** Every purchasable wall-level node, fortification + expansion — the single list
 *  sim/castle.ts's upgradeWall() validates ids/requires/costs against. */
export const WALL_UPGRADE_TREE: UpgradeNode[] = [...WALL_FORTIFY_NODES, ...WALL_EXPANSION_NODES];

export function extraSocketSpecFor(nodeId: string): ExtraSocketSpec | null {
  return EXTRA_SOCKET_SPECS[nodeId] ?? null;
}

// ---- Pure stat derivation from a wall's purchased id list. Higher rank replaces, not stacks —
// same convention as every structure's resolve*Stats() (see sim/structures/crossbow.ts etc). ----

export function wallDamageReductionPct(purchased: string[]): number {
  if (purchased.includes('reinforced2')) return WALL_UPGRADES.reinforced2.reductionPct;
  if (purchased.includes('reinforced1')) return WALL_UPGRADES.reinforced1.reductionPct;
  return 0;
}

export function wallMerlonBonus(purchased: string[]): number {
  if (purchased.includes('battlements2')) return WALL_UPGRADES.battlements2.merlonBonus;
  if (purchased.includes('battlements1')) return WALL_UPGRADES.battlements1.merlonBonus;
  return 0;
}

interface MachicolationStats {
  dps: number;
  range: number;
  slowPct: number;
  slowDuration: number;
}

function wallMachicolation(purchased: string[]): MachicolationStats | null {
  if (purchased.includes('machicolations2')) {
    const u = WALL_UPGRADES.machicolations2;
    return { dps: u.dps, range: u.range, slowPct: u.slowPct, slowDuration: u.slowDuration };
  }
  if (purchased.includes('machicolations1')) {
    const u = WALL_UPGRADES.machicolations1;
    return { dps: u.dps, range: u.range, slowPct: 0, slowDuration: 0 };
  }
  return null;
}

function wallAutoRepairRate(purchased: string[]): number {
  return purchased.includes('autoRepair') ? WALL_UPGRADES.autoRepair.hpPerSec : 0;
}

/** Applies the two GameState-mutating fortification effects (auto-repair, machicolations) for
 *  every wall, once per tick. Called from sim/castle.ts's own tick system; takes the wall list
 *  and a `purchasedFor` accessor rather than reaching into Castle's private WeakMap directly, so
 *  this file stays a plain function with no knowledge of the Castle class's internals.
 *  Reinforced Stone and Higher Battlements aren't ticked here — they're queried live (damageWall,
 *  blocksProjectile) rather than applied per-frame. */
export function tickWallEffects(dt: number, game: GameState, walls: Wall[], purchasedFor: (w: Wall) => string[]): void {
  if (game.phase === 'build') {
    for (const w of walls) {
      if (!w.built || w.hp <= 0) continue;
      const rate = wallAutoRepairRate(purchasedFor(w));
      if (rate > 0 && w.hp < w.maxHp) w.hp = Math.min(w.maxHp, w.hp + rate * dt);
    }
    return;
  }
  if (game.phase !== 'combat') return;
  for (const w of walls) {
    if (!w.built || w.hp <= 0) continue;
    const mc = wallMachicolation(purchasedFor(w));
    if (!mc) continue;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (Math.abs(e.pos.x) > WALL_HALF_WIDTH) continue; // outside this wall's own footprint
      if (e.pos.y > MACHICOLATION_MAX_DY) continue; // airborne — machicolations can't reach up
      const dz = w.z - e.pos.z; // distance in front of the wall's front face
      if (dz < 0 || dz > mc.range) continue;
      e.takeDamage(mc.dps * dt, game);
      if (mc.slowPct > 0) applySlow(e, game, 1 - mc.slowPct, mc.slowDuration);
    }
  }
}
