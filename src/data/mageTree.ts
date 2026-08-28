import type { AbilityTreeNode } from '../sim/abilityTree';
import { TREE_TIER_COST } from '../sim/abilityTree';

/** Mage "Mastery" trees — late-game branching upgrades hanging off each ability's linear ranks
 *  (see sim/abilityTree.ts for the mechanism). Owned by [player-classes]. Every root pair is
 *  mutually exclusive (`excludes` both ways); every tier-1 costs TREE_TIER_COST[0], every tier-2
 *  costs TREE_TIER_COST[1] — same "same price per tier, every branch" convention the crossbow's
 *  three paths already use. Consumed by data/mage.ts's cast() implementations. */

const [T1, T2] = TREE_TIER_COST;

export const arcaneBoltTree: AbilityTreeNode[] = [
  {
    id: 'forkBolt1',
    name: 'Fork Bolt',
    desc: 'Splits into 2 lighter bolts (45 dmg each) fired in a narrow spread instead of one — clears two separate targets standing near each other instead of piercing through a line.',
    cost: T1,
    requires: null,
    excludes: ['empoweredBolt1'],
    stats: { damage: 45, pierce: 0, count: 2, spreadDeg: 6 },
  },
  {
    id: 'forkBolt2',
    name: 'Arcane Fusillade',
    desc: 'Three bolts (55 dmg each) in a wider fan — up to 165 dmg spread across a whole cluster in one cast.',
    cost: T2,
    requires: 'forkBolt1',
    stats: { damage: 55, pierce: 0, count: 3, spreadDeg: 9 },
  },
  {
    id: 'empoweredBolt1',
    name: 'Empowered Bolt',
    desc: 'Trades the pierce for a devastating single-target hit: 150 dmg and a 25% slow for 1.5s. The execute button for one tough target instead of a line of weak ones.',
    cost: T1,
    requires: null,
    excludes: ['forkBolt1'],
    stats: { damage: 150, pierce: 0, count: 1, spreadDeg: 0, slowPct: 25, slowDuration: 1.5 },
  },
  {
    id: 'empoweredBolt2',
    name: 'Overcharged Bolt',
    desc: '260 dmg per bolt and a 40% slow for 2.5s — your hardest-hitting single click in the game.',
    cost: T2,
    requires: 'empoweredBolt1',
    stats: { damage: 260, slowPct: 40, slowDuration: 2.5 },
  },
];

export const fireballTree: AbilityTreeNode[] = [
  {
    id: 'meteorStorm1',
    name: 'Meteor Storm',
    desc: 'The meteor fragments into 2 extra impacts (70 dmg, radius 3) scattered up to 6 units from the blast — covers a much wider footprint against a spread-out or still-filing-in group.',
    cost: T1,
    requires: null,
    excludes: ['volcanicRupture1'],
    stats: { damage: 200, stormCount: 2, stormRadius: 3, stormDamage: 70, stormScatter: 6 },
  },
  {
    id: 'meteorStorm2',
    name: 'Meteor Swarm',
    desc: '4 fragments (100 dmg, radius 3.5) scattered up to 8 units — a whole courtyard’s worth of coverage from one cast.',
    cost: T2,
    requires: 'meteorStorm1',
    stats: { damage: 230, stormCount: 4, stormRadius: 3.5, stormDamage: 100, stormScatter: 8 },
  },
  {
    id: 'volcanicRupture1',
    name: 'Volcanic Rupture',
    desc: 'A single heavier impact (260 dmg) that leaves a burning crater — 35 dmg/s to anyone standing in it for 4s. Punishes wall-huggers and tanky targets that stand and fight in the blast site.',
    cost: T1,
    requires: null,
    excludes: ['meteorStorm1'],
    stats: { damage: 260, burnDps: 35, burnRadius: 4.5, burnDuration: 4 },
  },
  {
    id: 'volcanicRupture2',
    name: 'Molten Rupture',
    desc: '320 dmg impact, crater burns for 55 dmg/s over 6s across a 5-unit radius.',
    cost: T2,
    requires: 'volcanicRupture1',
    stats: { damage: 320, burnDps: 55, burnRadius: 5, burnDuration: 6 },
  },
];

export const frostFieldTree: AbilityTreeNode[] = [
  {
    id: 'permafrost1',
    name: 'Permafrost',
    desc: 'Once the main 60% slow (4s) fades, a weaker 30% chill lingers in the same spot for 5 more seconds — a chokepoint that stays cold long after the cast, for sustained area denial.',
    cost: T1,
    requires: null,
    excludes: ['killingFrost1'],
    stats: { radius: 6.5, slowPct: 60, duration: 4, lingerSlowPct: 30, lingerDuration: 5 },
  },
  {
    id: 'permafrost2',
    name: 'Eternal Frost',
    desc: '65% slow for 5s, then a 45% lingering chill for 7 more seconds — the longest-lasting zone control in the game.',
    cost: T2,
    requires: 'permafrost1',
    stats: { radius: 7.5, slowPct: 65, duration: 5, lingerSlowPct: 45, lingerDuration: 7 },
  },
  {
    id: 'killingFrost1',
    name: 'Killing Frost',
    desc: 'The field itself now burns for 18 dmg/s to everyone it slows — converts pure crowd control into a real damage source when you need one.',
    cost: T1,
    requires: null,
    excludes: ['permafrost1'],
    stats: { radius: 6.5, slowPct: 60, duration: 5, frostDps: 18 },
  },
  {
    id: 'killingFrost2',
    name: 'Hoarfrost',
    desc: '65% slow for 6s, now dealing 32 dmg/s to anyone caught in it.',
    cost: T2,
    requires: 'killingFrost1',
    stats: { radius: 7, slowPct: 65, duration: 6, frostDps: 32 },
  },
];

export const blinkTree: AbilityTreeNode[] = [
  {
    id: 'blinkCascade1',
    name: 'Blink Cascade',
    desc: 'A second charge — blink twice in quick succession before the full 12s cooldown kicks back in. Built for kiting and constant repositioning.',
    cost: T1,
    requires: null,
    excludes: ['arcaneRebound1'],
    stats: { range: 26, charges: 2 },
  },
  {
    id: 'blinkCascade2',
    name: 'Blink Torrent',
    desc: 'A third banked charge, range 28 — up to three blinks back to back.',
    cost: T2,
    requires: 'blinkCascade1',
    stats: { range: 28, charges: 3 },
  },
  {
    id: 'arcaneRebound1',
    name: 'Arcane Rebound',
    desc: 'Leaves a detonating rune at the point you blinked FROM — 60 dmg and a 40% slow for 2s in a 4-unit radius. Turns your escape into a parting punishment for whoever was chasing you.',
    cost: T1,
    requires: null,
    excludes: ['blinkCascade1'],
    stats: { range: 24, reboundDamage: 60, reboundRadius: 4, reboundSlowPct: 40, reboundSlowDuration: 2 },
  },
  {
    id: 'arcaneRebound2',
    name: 'Violent Rebound',
    desc: '110 dmg and a 55% slow for 3s in a 5-unit radius at the departure point.',
    cost: T2,
    requires: 'arcaneRebound1',
    stats: { range: 26, reboundDamage: 110, reboundRadius: 5, reboundSlowPct: 55, reboundSlowDuration: 3 },
  },
];
