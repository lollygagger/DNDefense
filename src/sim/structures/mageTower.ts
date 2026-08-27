import type { GameState } from '../GameState';
import type { Socket, StructureDef, StructureInstance, UpgradeNode } from '../types';
import type { AllyDef } from '../allies';
import { MAGE_TOWER } from '../../data/structures';
import { SpawnerStructure, type SpawnerConfig } from './spawnerBase';

/** Owned by [structures-allies]. Mage Tower — caster allies: fewer (base cap of 1) and pricier
 *  than any other spawner, per the task. Overload vs Chilling Presence is an exclusive damage-
 *  vs-control choice; Reinforced Spire (a second mage) is an independent third root so "field a
 *  second caster" isn't tied to which combat style was picked. */

export const MAGE_TOWER_DEF_ID = 'mageTower';

const cfg: SpawnerConfig = {
  defId: MAGE_TOWER_DEF_ID,
  allyDefId: 'allyMage',
  baseMax: MAGE_TOWER.maxMages,
  respawnInterval: MAGE_TOWER.respawnInterval,
  spawnJitter: MAGE_TOWER.spawnJitter,
  maxPossible: MAGE_TOWER.maxMages + MAGE_TOWER.upgrades.reinforcedSpire.bonusMax,
  maxFor(purchased) {
    return MAGE_TOWER.maxMages + (purchased.includes('reinforcedSpire') ? MAGE_TOWER.upgrades.reinforcedSpire.bonusMax : 0);
  },
  overridesFor(base, purchased): Partial<AllyDef> {
    const o2 = purchased.includes('overload2');
    const o1 = purchased.includes('overload1');
    const damageMult = o2 ? MAGE_TOWER.upgrades.overload2.damageMult : o1 ? MAGE_TOWER.upgrades.overload1.damageMult : 1;
    const aoeMult = o2 ? MAGE_TOWER.upgrades.overload2.aoeMult : o1 ? MAGE_TOWER.upgrades.overload1.aoeMult : 1;

    const c2 = purchased.includes('chill2');
    const c1 = purchased.includes('chill1');
    const slowPctBonus = c2 ? MAGE_TOWER.upgrades.chill2.slowPctBonus : c1 ? MAGE_TOWER.upgrades.chill1.slowPctBonus : 0;
    const durationBonus = c2 ? MAGE_TOWER.upgrades.chill2.durationBonus : c1 ? MAGE_TOWER.upgrades.chill1.durationBonus : 0;

    return {
      damage: base.damage * damageMult,
      aoeRadius: (base.aoeRadius ?? 0) * aoeMult,
      slowPct: Math.min(90, (base.slowPct ?? 0) + slowPctBonus),
      slowDuration: (base.slowDuration ?? 0) + durationBonus,
    };
  },
};

export const mageTowerDef: StructureDef = {
  id: MAGE_TOWER_DEF_ID,
  name: 'Mage Tower',
  desc: 'Trains a lone battle-mage who holds position and lobs slow, heavy AoE bolts. Branch into a bigger nuke or a stronger chill, or raise a second spire.',
  cost: MAGE_TOWER.cost,
  socketKind: 'chamber',
  upgrades: [
    {
      id: 'overload1',
      name: 'Arcane Overload',
      desc: '+50% damage, +20% blast radius.',
      cost: MAGE_TOWER.upgrades.overload1.cost,
      requires: null,
      excludes: ['chill1'],
    },
    {
      id: 'overload2',
      name: 'Arcane Overload II',
      desc: '+110% damage (total), +40% blast radius (total).',
      cost: MAGE_TOWER.upgrades.overload2.cost,
      requires: 'overload1',
    },
    {
      id: 'chill1',
      name: 'Chilling Presence',
      desc: '+15% slow, +1s duration.',
      cost: MAGE_TOWER.upgrades.chill1.cost,
      requires: null,
      excludes: ['overload1'],
    },
    {
      id: 'chill2',
      name: 'Chilling Presence II',
      desc: '+30% slow (total), +2s duration (total).',
      cost: MAGE_TOWER.upgrades.chill2.cost,
      requires: 'chill1',
    },
    {
      id: 'reinforcedSpire',
      name: 'Reinforced Spire',
      desc: '+1 max mage — an independent second caster, whichever style you picked.',
      cost: MAGE_TOWER.upgrades.reinforcedSpire.cost,
      requires: null,
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
