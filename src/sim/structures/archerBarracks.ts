import type { GameState } from '../GameState';
import type { Socket, StructureDef, StructureInstance, UpgradeNode } from '../types';
import type { AllyDef } from '../allies';
import { ARCHER_BARRACKS } from '../../data/structures';
import { SpawnerStructure, type SpawnerConfig } from './spawnerBase';

/** Owned by [structures-allies]. Archer Barracks — ranged allies that reanchor to the CURRENT
 *  front wall (see ALLY_DEFS.archer / the anchoring doc comment in data/allies.ts), hold a
 *  sheltered line just behind the melee rank there, and shoot (see stepRangedOrCaster in
 *  sim/allyAI.ts for "hold position"). */

export const ARCHER_BARRACKS_DEF_ID = 'archerBarracks';

const cfg: SpawnerConfig = {
  defId: ARCHER_BARRACKS_DEF_ID,
  allyDefId: 'archer',
  baseMax: ARCHER_BARRACKS.maxArchers,
  respawnInterval: ARCHER_BARRACKS.respawnInterval,
  spawnJitter: ARCHER_BARRACKS.spawnJitter,
  maxPossible: ARCHER_BARRACKS.maxArchers + ARCHER_BARRACKS.upgrades.volley2.bonusMax,
  maxFor(purchased) {
    const v2 = purchased.includes('volley2');
    const v1 = purchased.includes('volley1');
    const bonus = v2 ? ARCHER_BARRACKS.upgrades.volley2.bonusMax : v1 ? ARCHER_BARRACKS.upgrades.volley1.bonusMax : 0;
    return ARCHER_BARRACKS.maxArchers + bonus;
  },
  overridesFor(base, purchased): Partial<AllyDef> {
    const m2 = purchased.includes('marksman2');
    const m1 = purchased.includes('marksman1');
    const damageMult = m2
      ? ARCHER_BARRACKS.upgrades.marksman2.damageMult
      : m1
        ? ARCHER_BARRACKS.upgrades.marksman1.damageMult
        : 1;
    const rangeBonus = m2 ? ARCHER_BARRACKS.upgrades.marksman2.rangeBonus : 0;

    const v2 = purchased.includes('volley2');
    const v1 = purchased.includes('volley1');
    const fireRateMult = v2
      ? ARCHER_BARRACKS.upgrades.volley2.fireRateMult
      : v1
        ? ARCHER_BARRACKS.upgrades.volley1.fireRateMult
        : 1;

    return {
      damage: base.damage * damageMult,
      attackRange: base.attackRange + rangeBonus,
      aggroRange: base.aggroRange + rangeBonus,
      attackInterval: base.attackInterval / fireRateMult,
    };
  },
};

export const archerBarracksDef: StructureDef = {
  id: ARCHER_BARRACKS_DEF_ID,
  name: 'Archer Barracks',
  desc: 'Trains archers who hold their post and shoot enemies in range. Branch into precision marksmanship or a bigger, faster-shooting volley.',
  cost: ARCHER_BARRACKS.cost,
  socketKind: 'chamber',
  upgrades: [
    {
      id: 'marksman1',
      name: 'Marksmen',
      desc: '+30% archer damage.',
      cost: ARCHER_BARRACKS.upgrades.marksman1.cost,
      requires: null,
      excludes: ['volley1'],
    },
    {
      id: 'marksman2',
      name: 'Marksmen II',
      desc: '+70% damage (total), +4 range.',
      cost: ARCHER_BARRACKS.upgrades.marksman2.cost,
      requires: 'marksman1',
    },
    {
      id: 'volley1',
      name: 'Volley Fire',
      desc: '+1 max archer, +30% fire rate.',
      cost: ARCHER_BARRACKS.upgrades.volley1.cost,
      requires: null,
      excludes: ['marksman1'],
    },
    {
      id: 'volley2',
      name: 'Volley Fire II',
      desc: '+2 max archers (total), +60% fire rate (total).',
      cost: ARCHER_BARRACKS.upgrades.volley2.cost,
      requires: 'volley1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
