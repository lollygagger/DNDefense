import type { GameState } from '../GameState';
import type { Socket, StructureDef, StructureInstance, UpgradeNode } from '../types';
import type { AllyDef } from '../allies';
import { TANK_BARRACKS } from '../../data/structures';
import { SpawnerStructure, type SpawnerConfig } from './spawnerBase';

/** Owned by [structures-allies]. Tank Barracks — bulky, slow, high-HP melee that hold the line
 *  and soak (the ally-roster counterpart to the player Tank class another agent is building;
 *  no class files touched here). Roster cap never grows — a tank squad is meant to stay small
 *  and expensive per unit. */

export const TANK_BARRACKS_DEF_ID = 'tankBarracks';

const cfg: SpawnerConfig = {
  defId: TANK_BARRACKS_DEF_ID,
  allyDefId: 'tank',
  baseMax: TANK_BARRACKS.maxTanks,
  respawnInterval: TANK_BARRACKS.respawnInterval,
  spawnJitter: TANK_BARRACKS.spawnJitter,
  maxPossible: TANK_BARRACKS.maxTanks,
  maxFor() {
    return TANK_BARRACKS.maxTanks;
  },
  overridesFor(base, purchased): Partial<AllyDef> {
    const p2 = purchased.includes('platedArmor2');
    const p1 = purchased.includes('platedArmor1');
    const hpMult = p2 ? TANK_BARRACKS.upgrades.platedArmor2.hpMult : p1 ? TANK_BARRACKS.upgrades.platedArmor1.hpMult : 1;
    const reductionPct = p2
      ? TANK_BARRACKS.upgrades.platedArmor2.reductionPct
      : p1
        ? TANK_BARRACKS.upgrades.platedArmor1.reductionPct
        : 0;

    const a2 = purchased.includes('aggressive2');
    const a1 = purchased.includes('aggressive1');
    const damageMult = a2
      ? TANK_BARRACKS.upgrades.aggressive2.damageMult
      : a1
        ? TANK_BARRACKS.upgrades.aggressive1.damageMult
        : 1;
    const speedMult = a2 ? TANK_BARRACKS.upgrades.aggressive2.speedMult : a1 ? TANK_BARRACKS.upgrades.aggressive1.speedMult : 1;

    return {
      hp: base.hp * hpMult,
      damageReductionPct: reductionPct,
      damage: base.damage * damageMult,
      speed: base.speed * speedMult,
    };
  },
};

export const tankBarracksDef: StructureDef = {
  id: TANK_BARRACKS_DEF_ID,
  name: 'Tank Barracks',
  desc: 'Trains bulky, slow tanks that hold the forwardmost wall and soak hits. Branch into flat damage reduction or a more aggressive, faster bruiser.',
  cost: TANK_BARRACKS.cost,
  socketKind: 'chamber',
  upgrades: [
    {
      id: 'platedArmor1',
      name: 'Plated Armor',
      desc: '+30% HP, +10% flat damage reduction.',
      cost: TANK_BARRACKS.upgrades.platedArmor1.cost,
      requires: null,
      excludes: ['aggressive1'],
    },
    {
      id: 'platedArmor2',
      name: 'Plated Armor II',
      desc: '+60% HP (total), +20% flat damage reduction (total).',
      cost: TANK_BARRACKS.upgrades.platedArmor2.cost,
      requires: 'platedArmor1',
    },
    {
      id: 'aggressive1',
      name: 'Aggressive Stance',
      desc: '+50% damage, +20% speed.',
      cost: TANK_BARRACKS.upgrades.aggressive1.cost,
      requires: null,
      excludes: ['platedArmor1'],
    },
    {
      id: 'aggressive2',
      name: 'Aggressive Stance II',
      desc: '+100% damage (total), +40% speed (total).',
      cost: TANK_BARRACKS.upgrades.aggressive2.cost,
      requires: 'aggressive1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
