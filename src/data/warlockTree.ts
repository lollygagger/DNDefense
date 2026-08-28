import type { AbilityTreeNode } from '../sim/abilityTree';
import { TREE_TIER_COST } from '../sim/abilityTree';

/** Warlock "Mastery" trees — see data/mageTree.ts's header for the shared conventions (two
 *  mutually-exclusive root branches per ability, T1=600g/T2=1600g, absolute-total stats that
 *  override the linear ranks — not gated behind maxing them first, same as every other class).
 *  Consumed by data/warlock.ts's cast()s. */

const [T1, T2] = TREE_TIER_COST;

export const soulSiphonTree: AbilityTreeNode[] = [
  {
    id: 'witheringBeam1',
    name: 'Withering Beam',
    desc: 'Once fully locked on, the beam leaves a withering residue on the target that keeps burning for 3s after you look away — the first hit of real damage that outlives the channel itself.',
    cost: T1,
    requires: null,
    excludes: ['soulAnchor1'],
    stats: { dps: 135, rampBonusPct: 85, residueDps: 30, residueDuration: 3, residueRadius: 1 },
  },
  {
    id: 'witheringBeam2',
    name: 'Blighted Beam',
    desc: 'The residue grows into a spreading blight (radius 4.5) that catches anyone standing near your original target — a single locked-on target can now rot out a whole cluster.',
    cost: T2,
    requires: 'witheringBeam1',
    stats: { dps: 155, rampBonusPct: 95, residueDps: 50, residueDuration: 4, residueRadius: 4.5 },
  },
  {
    id: 'soulAnchor1',
    name: 'Soul Anchor',
    desc: "Life drains back to you from the very first tick instead of only once you're fully ramped — a weaker, always-on sibling of the fully-ramped Soul Drain (rank V), for a beam that sustains you through the whole fight, not just the payoff moment.",
    cost: T1,
    requires: null,
    excludes: ['witheringBeam1'],
    stats: { dps: 125, rampBonusPct: 85, lifestealPct: 30, lifestealAlways: 1 },
  },
  {
    id: 'soulAnchor2',
    name: 'Soul Bond',
    desc: 'Nearly half of every tick comes back as healing, ramped or not — the beam becomes as much a lifeline as a weapon.',
    cost: T2,
    requires: 'soulAnchor1',
    stats: { dps: 140, rampBonusPct: 95, lifestealPct: 48, lifestealAlways: 1 },
  },
];

export const curseOfAgonyTree: AbilityTreeNode[] = [
  {
    id: 'festeringCurse1',
    name: 'Festering Curse',
    desc: 'A much bigger, harder-hitting curse (radius 6.5) — leans all the way into raw damage over the mark.',
    cost: T1,
    requires: null,
    excludes: ['agonizingMark1'],
    stats: { radius: 6.5, dps: 55, duration: 6, vulnPct: 20 },
  },
  {
    id: 'festeringCurse2',
    name: 'Plague Curse',
    desc: 'Radius 8, 80 dmg/s — the curse alone can carry a fight against a clustered wave.',
    cost: T2,
    requires: 'festeringCurse1',
    stats: { radius: 8, dps: 80, duration: 7, vulnPct: 20 },
  },
  {
    id: 'agonizingMark1',
    name: 'Agonizing Mark',
    desc: 'Trades raw damage for a much deeper mark (+40% dmg taken) and a genuine 30% slow — agony that cripples as much as it hurts.',
    cost: T1,
    requires: null,
    excludes: ['festeringCurse1'],
    stats: { radius: 5, dps: 20, duration: 6, vulnPct: 40, slowPct: 30 },
  },
  {
    id: 'agonizingMark2',
    name: 'Excruciating Mark',
    desc: '+55% dmg taken and a 40% slow for 7s — the deepest single debuff in the kit.',
    cost: T2,
    requires: 'agonizingMark1',
    stats: { radius: 5.5, dps: 26, duration: 7, vulnPct: 55, slowPct: 40 },
  },
];

export const abyssalGraspTree: AbilityTreeNode[] = [
  {
    id: 'crushingVoid1',
    name: 'Crushing Void',
    desc: 'The rift itself now hits for real damage on top of the pull — a hybrid control/damage tool instead of pure setup.',
    cost: T1,
    requires: null,
    excludes: ['bindingChains1'],
    stats: { radius: 5, pullAmount: 4, slowPct: 70, duration: 2, damage: 40 },
  },
  {
    id: 'crushingVoid2',
    name: 'Collapsing Void',
    desc: '75 dmg on collapse, a stronger 5-unit pull — bunch a group and hurt it in the same cast.',
    cost: T2,
    requires: 'crushingVoid1',
    stats: { radius: 5.5, pullAmount: 5, slowPct: 78, duration: 2.5, damage: 75 },
  },
  {
    id: 'bindingChains1',
    name: 'Binding Chains',
    desc: 'Drops some of the pull for a genuine 1.0s stun on everything caught — the stillness a channel wants, guaranteed instead of just heavily slowed.',
    cost: T1,
    requires: null,
    excludes: ['crushingVoid1'],
    stats: { radius: 5, pullAmount: 3.5, slowPct: 70, duration: 2, stunDuration: 1.0 },
  },
  {
    id: 'bindingChains2',
    name: 'Unbreakable Chains',
    desc: 'A 1.5s stun on everything the rift catches — the longest hard lockdown in the Warlock kit.',
    cost: T2,
    requires: 'bindingChains1',
    stats: { radius: 5.5, pullAmount: 4, slowPct: 78, duration: 2.5, stunDuration: 1.5 },
  },
];

export const umbralFlightTree: AbilityTreeNode[] = [
  {
    id: 'endlessWings1',
    name: 'Endless Wings',
    desc: 'Stay airborne two seconds longer, and drift faster while you are. Enough time for the beam to reach full lock on something that cannot reach back.',
    cost: T1,
    requires: null,
    excludes: ['dreadTakeoff1'],
    stats: { duration: 7.4, ceiling: 13 },
  },
  {
    id: 'endlessWings2',
    name: 'Wings of the Abyss',
    desc: 'Nearly ten seconds aloft and a higher ceiling — long enough to cross the whole field above the horde, draining the entire way.',
    cost: T2,
    requires: 'endlessWings1',
    stats: { duration: 9.6, ceiling: 15 },
  },
  {
    id: 'dreadTakeoff1',
    name: 'Dread Takeoff',
    desc: 'The downdraft as you launch deals 60 dmg and drags everything within 4.5 units inward — you leave the ground and the horde bunches up right where you are about to hover.',
    cost: T1,
    requires: null,
    excludes: ['endlessWings1'],
    stats: { downdraftDamage: 60, downdraftRadius: 4.5, downdraftPull: 3 },
  },
  {
    id: 'dreadTakeoff2',
    name: 'Maelstrom Ascent',
    desc: '110 dmg and a 5-unit pull across a wider draft — take off inside a pack and it is packed tighter, beneath you, before your feet leave the dirt.',
    cost: T2,
    requires: 'dreadTakeoff1',
    stats: { downdraftDamage: 110, downdraftRadius: 6, downdraftPull: 5 },
  },
];
