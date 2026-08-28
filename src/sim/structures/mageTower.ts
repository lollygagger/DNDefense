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

    // High tier (600g/1600g, independent of overload/chill/reinforcedSpire): Arcane Residue
    // (lingering ground DoT, sim/allyAI.ts's fireAt) vs Twin Casting (an extra bolt at a second
    // target, stepRangedOrCaster), mutually exclusive.
    const res2 = purchased.includes('arcaneResidue2');
    const res1 = purchased.includes('arcaneResidue1');
    const residue = res2 ? MAGE_TOWER.upgrades.arcaneResidue2 : res1 ? MAGE_TOWER.upgrades.arcaneResidue1 : null;

    const twin2 = purchased.includes('twinCasting2');
    const twin1 = purchased.includes('twinCasting1');
    const twin = twin2 ? MAGE_TOWER.upgrades.twinCasting2 : twin1 ? MAGE_TOWER.upgrades.twinCasting1 : null;

    return {
      damage: base.damage * damageMult,
      aoeRadius: (base.aoeRadius ?? 0) * aoeMult,
      slowPct: Math.min(90, (base.slowPct ?? 0) + slowPctBonus),
      slowDuration: (base.slowDuration ?? 0) + durationBonus,
      lingerDps: residue?.lingerDps,
      lingerDuration: residue?.lingerDuration,
      lingerRadius: residue?.lingerRadius,
      extraBoltCount: twin?.extraBoltCount,
      extraBoltDamageMult: twin?.extraBoltDamageMult,
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
    // ---- High tier: a second, independent branch point, not gated behind overload/chill/spire.
    {
      id: 'arcaneResidue1',
      name: 'Arcane Residue',
      desc: 'Each blast leaves a lingering scorched patch: 16 dmg/s for 3s where it hit.',
      cost: MAGE_TOWER.upgrades.arcaneResidue1.cost,
      requires: null,
      excludes: ['twinCasting1'],
    },
    {
      id: 'arcaneResidue2',
      name: 'Arcane Blight',
      desc: '28 dmg/s for 4.5s, over a wider patch — the ground itself keeps fighting after the bolt is gone.',
      cost: MAGE_TOWER.upgrades.arcaneResidue2.cost,
      requires: 'arcaneResidue1',
    },
    {
      id: 'twinCasting1',
      name: 'Twin Casting',
      desc: 'The tower now also fires a second, weaker bolt (50% damage) at a nearby second target the instant it casts — one spell, two targets.',
      cost: MAGE_TOWER.upgrades.twinCasting1.cost,
      requires: null,
      excludes: ['arcaneResidue1'],
    },
    {
      id: 'twinCasting2',
      name: 'Triple Casting',
      desc: 'A third bolt joins in (65% damage each) — the tower answers a whole cluster instead of committing to one target.',
      cost: MAGE_TOWER.upgrades.twinCasting2.cost,
      requires: 'twinCasting1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
