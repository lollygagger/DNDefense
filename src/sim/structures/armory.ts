import type { GameState } from '../GameState';
import type { Socket, StructureDef, StructureInstance, UpgradeNode } from '../types';
import type { AllyDef } from '../allies';
import { ARMORY } from '../../data/structures';
import { SpawnerStructure, type SpawnerConfig } from './spawnerBase';

/** Owned by [structures-allies]. Swordsman Armory — the original spawner, now expressed as a
 *  SpawnerStructure config instead of its own bespoke class (relocated from sim/structures.ts). */

export const ARMORY_DEF_ID = 'armory';

const cfg: SpawnerConfig = {
  defId: ARMORY_DEF_ID,
  allyDefId: 'swordsman',
  baseMax: ARMORY.maxSwordsmen,
  respawnInterval: ARMORY.respawnInterval,
  spawnJitter: ARMORY.spawnJitter,
  maxPossible: ARMORY.maxSwordsmen + ARMORY.upgrades.veterans1.bonusMax,
  maxFor(purchased) {
    return ARMORY.maxSwordsmen + (purchased.includes('veterans1') ? ARMORY.upgrades.veterans1.bonusMax : 0);
  },
  overridesFor(base, purchased): Partial<AllyDef> {
    const v1 = purchased.includes('veterans1');
    const v2 = purchased.includes('veterans2');
    const hpMult = (v1 ? ARMORY.upgrades.veterans1.hpMult : 1) * (v2 ? ARMORY.upgrades.veterans2.hpMult : 1);
    const damageMult = v2 ? ARMORY.upgrades.veterans2.damageMult : 1;
    return { hp: base.hp * hpMult, damage: base.damage * damageMult };
  },
};

export const armoryDef: StructureDef = {
  id: ARMORY_DEF_ID,
  name: 'Swordsman Armory',
  desc: 'Maintains a squad of swordsmen who sortie out to hold the forwardmost wall.',
  cost: ARMORY.cost,
  socketKind: 'chamber',
  upgrades: [
    {
      id: 'veterans1',
      name: 'Veterans I',
      desc: `+${ARMORY.upgrades.veterans1.bonusMax} max swordsman, +25% ally HP.`,
      cost: ARMORY.upgrades.veterans1.cost,
      requires: null,
    },
    {
      id: 'veterans2',
      name: 'Veterans II',
      desc: '+50% ally damage, +25% more HP.',
      cost: ARMORY.upgrades.veterans2.cost,
      requires: 'veterans1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
