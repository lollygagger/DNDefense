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

    // High tier (600g/1600g, independent of platedArmor/aggressive): Retaliation Plating (a
    // damage pulse when struck, sim/allies.ts's spawnAlly takeDamage) vs Hardened Resolve
    // (heal-on-hit, sim/allyAI.ts's stepMelee), mutually exclusive.
    const r2 = purchased.includes('retaliationPlating2');
    const r1 = purchased.includes('retaliationPlating1');
    const retaliation = r2 ? TANK_BARRACKS.upgrades.retaliationPlating2 : r1 ? TANK_BARRACKS.upgrades.retaliationPlating1 : null;

    const h2 = purchased.includes('hardenedResolve2');
    const h1 = purchased.includes('hardenedResolve1');
    const healOnHit = h2
      ? TANK_BARRACKS.upgrades.hardenedResolve2.healOnHit
      : h1
        ? TANK_BARRACKS.upgrades.hardenedResolve1.healOnHit
        : undefined;

    return {
      hp: base.hp * hpMult,
      damageReductionPct: reductionPct,
      damage: base.damage * damageMult,
      speed: base.speed * speedMult,
      thornsDamage: retaliation?.thornsDamage,
      thornsRadius: retaliation?.thornsRadius,
      healOnHit,
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
    // ---- High tier: a second, independent branch point, not gated behind platedArmor/aggressive.
    {
      id: 'retaliationPlating1',
      name: 'Retaliation Plating',
      desc: 'Every hit taken pulses 12 dmg to enemies within 4 units — a tank surrounded by a mob makes them pay for it.',
      cost: TANK_BARRACKS.upgrades.retaliationPlating1.cost,
      requires: null,
      excludes: ['hardenedResolve1'],
    },
    {
      id: 'retaliationPlating2',
      name: 'Vengeful Plating',
      desc: '22 dmg within 5 units (total) — being swarmed becomes the mob’s problem.',
      cost: TANK_BARRACKS.upgrades.retaliationPlating2.cost,
      requires: 'retaliationPlating1',
    },
    {
      id: 'hardenedResolve1',
      name: 'Hardened Resolve',
      desc: 'Every landed hit heals the tank 5 HP — outlast the fight instead of just soaking it.',
      cost: TANK_BARRACKS.upgrades.hardenedResolve1.cost,
      requires: null,
      excludes: ['retaliationPlating1'],
    },
    {
      id: 'hardenedResolve2',
      name: 'Undying Resolve',
      desc: '10 HP per hit (total) — a tank that keeps swinging barely needs to fall back.',
      cost: TANK_BARRACKS.upgrades.hardenedResolve2.cost,
      requires: 'hardenedResolve1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
