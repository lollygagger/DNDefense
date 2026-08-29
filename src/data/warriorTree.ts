import type { AbilityTreeNode } from '../sim/abilityTree';
import { TREE_TIER_COST } from '../sim/abilityTree';

/** Warrior "Mastery" trees — see data/mageTree.ts's header for the shared conventions (uniform
 *  per-tier cost, mutually exclusive root pairs). Consumed by data/warrior.ts's cast()s. */

const [T1, T2] = TREE_TIER_COST;

export const cleaveTree: AbilityTreeNode[] = [
  {
    id: 'bloodletting1',
    name: 'Bloodletting',
    desc: "Every hit opens a stacking wound: 14 dmg/s per stack (up to 5), refreshed for 3s on each swing. Weaker up front, but a single tough target caught under repeated Cleaves bleeds hard.",
    cost: T1,
    requires: null,
    excludes: ['momentum1'],
    stats: { damage: 40, bleedDps: 14, bleedDuration: 3, bleedMaxStacks: 5 },
  },
  {
    id: 'bloodletting2',
    name: 'Hemorrhage',
    desc: '26 dmg/s per stack (up to 5), 4s refresh — a fully-stacked target is losing more HP to the bleed than to the swing itself.',
    cost: T2,
    requires: 'bloodletting1',
    stats: { damage: 46, bleedDps: 26, bleedDuration: 4, bleedMaxStacks: 5 },
  },
  {
    id: 'momentum1',
    name: 'Momentum',
    desc: 'Every kill refunds 0.2s off Cleave’s own cooldown — chain kills through a weak swarm and the blade barely stops swinging.',
    cost: T1,
    requires: null,
    excludes: ['bloodletting1'],
    stats: { damage: 50, killRefund: 0.2 },
  },
  {
    id: 'momentum2',
    name: 'Unstoppable',
    desc: '0.35s refunded per kill — against a real swarm, Cleave can come off cooldown faster than you can even swing it again.',
    cost: T2,
    requires: 'momentum1',
    stats: { damage: 55, killRefund: 0.35 },
  },
];

export const groundSlamTree: AbilityTreeNode[] = [
  {
    id: 'aftershock1',
    name: 'Aftershock',
    desc: 'The shockwave now washes out to a 7-unit outer ring (40 dmg, 25% slow) beyond the normal blast — reaches enemies the tight inner radius alone would miss.',
    cost: T1,
    requires: null,
    excludes: ['fracture1'],
    stats: {
      damage: 110,
      radius: 4,
      slowPct: 45,
      duration: 1.6,
      outerRadius: 7,
      outerDamage: 40,
      outerSlowPct: 25,
    },
  },
  {
    id: 'aftershock2',
    name: 'Seismic Aftershock',
    desc: 'Outer ring grows to 9 units at 65 dmg and a 35% slow — a slam that controls almost the whole courtyard.',
    cost: T2,
    requires: 'aftershock1',
    stats: {
      damage: 140,
      radius: 4.5,
      slowPct: 50,
      duration: 1.8,
      outerRadius: 9,
      outerDamage: 65,
      outerSlowPct: 35,
    },
  },
  {
    id: 'fracture1',
    name: 'Fracture',
    desc: "Cracks armor instead of reaching further: everything hit takes 25% more damage from your own Cleave and Leap for 3s. A setup tool for your own combo, not the crowd.",
    cost: T1,
    requires: null,
    excludes: ['aftershock1'],
    stats: { damage: 90, radius: 3.5, slowPct: 40, duration: 1.4, vulnPct: 25, vulnDuration: 3 },
  },
  {
    id: 'fracture2',
    name: 'Shatterpoint',
    desc: '+40% damage taken from your own attacks for 4s — weave Cleave straight after this and watch it hit like a fully-ranked Whirlwind.',
    cost: T2,
    requires: 'fracture1',
    stats: { damage: 110, radius: 4, slowPct: 45, duration: 1.6, vulnPct: 40, vulnDuration: 4 },
  },
];

export const secondWindTree: AbilityTreeNode[] = [
  {
    id: 'adrenaline1',
    name: 'Adrenaline Surge',
    desc: 'Heals 100 and grants +20% damage on all your attacks for 5s — turn recovery into a counter-offensive.',
    cost: T1,
    requires: null,
    excludes: ['fortitude1'],
    stats: { heal: 470, dmgBuffPct: 75, dmgBuffDuration: 9 },
  },
  {
    id: 'adrenaline2',
    name: 'Berserker’s Surge',
    desc: 'Heals 150, +35% damage for 6s.',
    cost: T2,
    requires: 'adrenaline1',
    stats: { heal: 540, dmgBuffPct: 110, dmgBuffDuration: 11 },
  },
  {
    id: 'fortitude1',
    name: 'Battle Fortitude',
    desc: 'Heals 100 and cuts incoming damage 25% for 3s — a Bulwark-lite bolted onto your heal, for when you need to survive the next few hits more than deal them.',
    cost: T1,
    requires: null,
    excludes: ['adrenaline1'],
    stats: { heal: 470, reductionPct: 70, reductionDuration: 10 },
  },
  {
    id: 'fortitude2',
    name: 'Unbreakable',
    desc: 'Heals 150, 35% damage reduction for 4s.',
    cost: T2,
    requires: 'fortitude1',
    stats: { heal: 540, reductionPct: 85, reductionDuration: 13 },
  },
];

export const leapTree: AbilityTreeNode[] = [
  {
    id: 'rollingThunder1',
    name: 'Rolling Thunder',
    desc: 'The landing slam now knocks everything it hits back 2.5 units — buys space instead of just damage, on top of 80 dmg and a 1.0s stun.',
    cost: T1,
    requires: null,
    excludes: ['warLeap1'],
    stats: { speed: 9, damage: 480, radius: 8.2, stunDuration: 2.4, knockback: 7 },
  },
  {
    id: 'rollingThunder2',
    name: 'Thunderclap',
    desc: '105 dmg, 1.3s stun, and a 3.5-unit knockback — clears breathing room around you on every landing.',
    cost: T2,
    requires: 'rollingThunder1',
    stats: { speed: 9.4, damage: 580, radius: 9, stunDuration: 2.8, knockback: 10 },
  },
  {
    id: 'warLeap1',
    overrides: ['stunDuration'], // trades the landing stun for the shorter cooldown
    name: 'War Leap',
    desc: 'Sheds the landing slam’s damage growth for a much shorter cooldown (40% of normal, ~2s) — a repeatable gap-closer for chaining leaps across the field instead of one big hit.',
    cost: T1,
    requires: null,
    excludes: ['rollingThunder1'],
    stats: { speed: 9, damage: 460, radius: 7.8, stunDuration: 0, cooldownMult: 0.45 },
  },
  {
    id: 'warLeap2',
    overrides: ['stunDuration'],
    name: 'Restless War Leap',
    desc: 'Cooldown down to 25% of normal (~1.25s) — Leap becomes a movement tool you can use almost every other second.',
    cost: T2,
    requires: 'warLeap1',
    stats: { speed: 9.4, damage: 520, radius: 8.2, stunDuration: 0, cooldownMult: 0.3 },
  },
];
