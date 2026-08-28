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

    // High tier (600g/1600g, independent of veterans1/2 — see data/structures.ts's doc comment):
    // Bleeding Strikes vs Sundering Blows, mutually exclusive, resolved in sim/allyAI.ts's
    // stepMelee via sim/allyTierEffects.ts's applyMeleeHitEffects. Purely behavioral fields —
    // neither branch touches hp/damage here.
    const bleed2 = purchased.includes('bleedingStrikes2');
    const bleed1 = purchased.includes('bleedingStrikes1');
    const bleedTier = bleed2 ? ARMORY.upgrades.bleedingStrikes2 : bleed1 ? ARMORY.upgrades.bleedingStrikes1 : null;

    const sunder2 = purchased.includes('sunderingBlows2');
    const sunder1 = purchased.includes('sunderingBlows1');
    const sunderTier = sunder2 ? ARMORY.upgrades.sunderingBlows2 : sunder1 ? ARMORY.upgrades.sunderingBlows1 : null;

    return {
      hp: base.hp * hpMult,
      damage: base.damage * damageMult,
      bleedDpsPerStack: bleedTier?.bleedDpsPerStack,
      bleedDuration: bleedTier?.bleedDuration,
      bleedMaxStacks: bleedTier?.bleedMaxStacks,
      markVulnPct: sunderTier?.markVulnPct,
      markVulnDuration: sunderTier?.markVulnDuration,
    };
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
    // ---- High tier: a second, independent branch point (not gated behind veterans1/2 — see
    // ability Mastery's own precedent), two mutually exclusive roots. Purely behavioral.
    {
      id: 'bleedingStrikes1',
      name: 'Bleeding Strikes',
      desc: 'Every swing opens a stacking wound: 10 dmg/s per stack (up to 3), refreshed for 3s on each hit.',
      cost: ARMORY.upgrades.bleedingStrikes1.cost,
      requires: null,
      excludes: ['sunderingBlows1'],
    },
    {
      id: 'bleedingStrikes2',
      name: 'Hemorrhaging Strikes',
      desc: '18 dmg/s per stack (up to 4), 4s refresh — a target caught under repeated blows bleeds harder than the swords themselves are hitting for.',
      cost: ARMORY.upgrades.bleedingStrikes2.cost,
      requires: 'bleedingStrikes1',
    },
    {
      id: 'sunderingBlows1',
      name: 'Sundering Blows',
      desc: 'Every hit marks the target: +15% damage taken from everything — you, allies, towers — for 3s.',
      cost: ARMORY.upgrades.sunderingBlows1.cost,
      requires: null,
      excludes: ['bleedingStrikes1'],
    },
    {
      id: 'sunderingBlows2',
      name: 'Rending Blows',
      desc: '+25% damage taken (total) for 4s — every swordsman becomes a spotter for the whole wall’s firepower.',
      cost: ARMORY.upgrades.sunderingBlows2.cost,
      requires: 'sunderingBlows1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new SpawnerStructure(socket, cfg);
    instance.bootstrap(game);
    return instance;
  },
};
