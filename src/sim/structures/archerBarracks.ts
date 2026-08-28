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

    // High tier (600g/1600g, independent of marksman1/2/volley1/2 — a second, separate branch
    // point): Broadhead Arrows (pierce) vs Explosive Fletching (splash via aoeRadius), mutually
    // exclusive. Threaded through the projectile spec in sim/allyAI.ts's fireAt.
    const pierce2 = purchased.includes('broadheadArrows2');
    const pierce1 = purchased.includes('broadheadArrows1');
    const pierce = pierce2
      ? ARCHER_BARRACKS.upgrades.broadheadArrows2.pierce
      : pierce1
        ? ARCHER_BARRACKS.upgrades.broadheadArrows1.pierce
        : undefined;

    const splash2 = purchased.includes('explosiveFletching2');
    const splash1 = purchased.includes('explosiveFletching1');
    const aoeRadius = splash2
      ? ARCHER_BARRACKS.upgrades.explosiveFletching2.aoeRadius
      : splash1
        ? ARCHER_BARRACKS.upgrades.explosiveFletching1.aoeRadius
        : undefined;

    return {
      damage: base.damage * damageMult,
      attackRange: base.attackRange + rangeBonus,
      aggroRange: base.aggroRange + rangeBonus,
      attackInterval: base.attackInterval / fireRateMult,
      pierce,
      aoeRadius,
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
    // ---- High tier: a second, independent branch point, not gated behind marksman/volley (same
    // "not gated behind the cheap tier" precedent ability Mastery uses) — pierce a line vs splash
    // a cluster, the same shape of decision as the crossbow's own Ballista-vs-Cannon split.
    {
      id: 'broadheadArrows1',
      name: 'Broadhead Arrows',
      desc: 'Arrows punch through: pierces 1 extra enemy in the line, same full damage on both.',
      cost: ARCHER_BARRACKS.upgrades.broadheadArrows1.cost,
      requires: null,
      excludes: ['explosiveFletching1'],
    },
    {
      id: 'broadheadArrows2',
      name: 'Piercing Volley',
      desc: 'Pierces 2 extra enemies (total) — a well-aimed volley clears a whole lane.',
      cost: ARCHER_BARRACKS.upgrades.broadheadArrows2.cost,
      requires: 'broadheadArrows1',
    },
    {
      id: 'explosiveFletching1',
      name: 'Explosive Fletching',
      desc: 'Arrows detonate on impact: 2.0-radius splash damage instead of a single-target hit.',
      cost: ARCHER_BARRACKS.upgrades.explosiveFletching1.cost,
      requires: null,
      excludes: ['broadheadArrows1'],
    },
    {
      id: 'explosiveFletching2',
      name: 'Detonating Volley',
      desc: '3.0-radius splash (total) — a volley that clears whatever’s clustered at the wall.',
      cost: ARCHER_BARRACKS.upgrades.explosiveFletching2.cost,
      requires: 'explosiveFletching1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
