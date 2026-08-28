import type { GameState } from './GameState';
import type { StructureDef, StructureInstance } from './types';
import { crossbowDef, CROSSBOW_DEF_ID, type CrossbowInstance } from './structures/crossbow';
import { armoryDef, ARMORY_DEF_ID } from './structures/armory';
import { archerBarracksDef, ARCHER_BARRACKS_DEF_ID } from './structures/archerBarracks';
import { mageTowerDef, MAGE_TOWER_DEF_ID } from './structures/mageTower';
import { tankBarracksDef, TANK_BARRACKS_DEF_ID } from './structures/tankBarracks';
import { fieldHospitalDef, FIELD_HOSPITAL_DEF_ID } from './structures/fieldHospital';
import { flamethrowerDef, FLAMETHROWER_DEF_ID, type FlamethrowerInstance } from './structures/flamethrower';
import { arcLightningDef, ARC_LIGHTNING_DEF_ID, type ArcLightningInstance } from './structures/arcLightning';

/** Owned by [structures-allies]. Structure definition registry + per-tick driver.
 *  registerStructureDef/getStructureDef/getStructureDefsForSocket/initStructures signatures are
 *  contract (castle + UI call them) — kept here as the barrel so `from '../sim/structures'`
 *  keeps working unchanged everywhere. Per-structure logic now lives one file per structure
 *  under sim/structures/ (this file had grown past the ~400-line guideline once four more
 *  spawners were added; splitting keeps each structure's tick()/upgrade math readable on its
 *  own instead of one file holding six unrelated classes). */

export {
  CROSSBOW_DEF_ID,
  ARMORY_DEF_ID,
  ARCHER_BARRACKS_DEF_ID,
  MAGE_TOWER_DEF_ID,
  TANK_BARRACKS_DEF_ID,
  FIELD_HOSPITAL_DEF_ID,
  FLAMETHROWER_DEF_ID,
  ARC_LIGHTNING_DEF_ID,
};
export type { CrossbowInstance, FlamethrowerInstance, ArcLightningInstance };

const defs = new Map<string, StructureDef>();

export function registerStructureDef(def: StructureDef): void {
  defs.set(def.id, def);
}

export function getStructureDef(id: string): StructureDef | null {
  return defs.get(id) ?? null;
}

export function getStructureDefsForSocket(kind: 'embrasure' | 'chamber'): StructureDef[] {
  return [...defs.values()].filter((d) => d.socketKind === kind);
}

/** Cheapest upgrade this structure could buy right now, or null when its tree is finished (every
 *  node either owned or locked out by an exclusive branch). Gold is deliberately NOT considered —
 *  callers that care about affordability compare against game.gold themselves.
 *
 *  Eligibility mirrors castle.ts's upgradeStructure() exactly (owned / requires / two-way
 *  excludes) so the socket beacons in render/castleView.ts and the [E] hint in ui/menus.ts can
 *  never disagree with what the socket menu will actually let you buy. Kept here in sim rather
 *  than reusing ui/menuWidgets.ts's nodeState() because render must not import from ui. */
export function nextUpgradeCost(structure: StructureInstance): number | null {
  const def = getStructureDef(structure.defId);
  if (!def) return null;
  let cheapest: number | null = null;
  for (const node of def.upgrades) {
    if (structure.purchased.includes(node.id)) continue;
    if (node.requires && !structure.purchased.includes(node.requires)) continue;
    let excluded = false;
    for (const ownedId of structure.purchased) {
      const owned = def.upgrades.find((n) => n.id === ownedId);
      if (owned?.excludes?.includes(node.id) || node.excludes?.includes(ownedId)) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;
    if (cheapest === null || node.cost < cheapest) cheapest = node.cost;
  }
  return cheapest;
}

export function initStructures(game: GameState): void {
  registerStructureDef(crossbowDef);
  registerStructureDef(armoryDef);
  registerStructureDef(archerBarracksDef);
  registerStructureDef(mageTowerDef);
  registerStructureDef(tankBarracksDef);
  registerStructureDef(fieldHospitalDef);
  registerStructureDef(flamethrowerDef);
  registerStructureDef(arcLightningDef);

  game.addSystem({
    tick(dt) {
      if (game.phase === 'menu' || game.phase === 'gameover') return;
      for (const wall of game.castle.walls) {
        if (!wall.built || wall.hp <= 0) continue;
        for (const socket of wall.sockets) socket.structure?.tick(dt, game);
      }
    },
  });
}
