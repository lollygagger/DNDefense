import type { AbilityTreeNode } from '../sim/abilityTree';
import { TREE_TIER_COST } from '../sim/abilityTree';

/** Archer "Mastery" trees — see data/mageTree.ts's header for the shared conventions. Quickshot's
 *  branch is the flagship example from the design brief: full auto (already unlocked at rank V)
 *  branching into full-auto cannonballs or full-auto chain lightning. Consumed by
 *  data/archer.ts's cast()s. */

const [T1, T2] = TREE_TIER_COST;

export const quickshotTree: AbilityTreeNode[] = [
  {
    id: 'ballisticRounds1',
    name: 'Ballistic Rounds',
    desc: 'Full-auto arrows become slow, heavy cannonballs: 26 dmg with a 2.5-unit splash, at ~55% of normal fire rate. Trades attack speed for guaranteed AoE against clustered enemies.',
    cost: T1,
    requires: null,
    excludes: ['stormQuiver1'],
    stats: { damage: 210, autoFire: 1, aoeRadius: 5, fireRateMult: 0.55, projSpeedMult: 0.6 },
  },
  {
    id: 'ballisticRounds2',
    name: 'Siege Rounds',
    desc: '34 dmg per shot, splash grows to 3.5 units — a hand-held siege weapon against a packed lane.',
    cost: T2,
    requires: 'ballisticRounds1',
    stats: { damage: 250, autoFire: 1, aoeRadius: 6.5, fireRateMult: 0.5, projSpeedMult: 0.55 },
  },
  {
    id: 'stormQuiver1',
    name: 'Storm Quiver',
    desc: 'Full-auto arrows arc to nearby enemies on hit — chains to 2 additional targets within 6 units, damage falling off 40% per jump. Rewards a spread-out group instead of one tough target.',
    cost: T1,
    requires: null,
    excludes: ['ballisticRounds1'],
    stats: { damage: 205, autoFire: 1, chainJumps: 5, chainRadius: 8, chainFalloff: 0.7 },
  },
  {
    id: 'stormQuiver2',
    name: 'Tempest Quiver',
    desc: 'Chains to 4 targets within 7.5 units, falloff eased to 35% per jump — a full-auto stream that can sweep an entire line.',
    cost: T2,
    requires: 'stormQuiver1',
    stats: { damage: 240, autoFire: 1, chainJumps: 8, chainRadius: 10, chainFalloff: 0.8 },
  },
];

export const piercingShotTree: AbilityTreeNode[] = [
  {
    id: 'explosiveTip1',
    name: 'Explosive Tip',
    desc: 'The arrow detonates at the end of its line — 90 dmg AoE (radius 3.5) on top of the pierce, so the last enemy in the lane doesn’t just get skewered, everyone around it does too.',
    cost: T1,
    requires: null,
    excludes: ['huntersMark1'],
    stats: { damage: 820, pierce: 99, explodeRadius: 7.5, explodeDamage: 430 },
  },
  {
    id: 'explosiveTip2',
    name: 'Detonating Lance',
    desc: '200 dmg down the line, 140 dmg AoE (radius 4.5) on impact.',
    cost: T2,
    requires: 'explosiveTip1',
    stats: { damage: 920, pierce: 99, explodeRadius: 9, explodeDamage: 620 },
  },
  {
    id: 'huntersMark1',
    name: "Hunter's Mark",
    desc: 'Marks everything the arrow pierces: +25% damage taken from all your other attacks for 4s. Turns a line-clear shot into a setup for the rest of your kit.',
    cost: T1,
    requires: null,
    excludes: ['explosiveTip1'],
    stats: { damage: 820, pierce: 99, markPct: 45, markDuration: 5 },
  },
  {
    id: 'huntersMark2',
    name: "Predator's Mark",
    desc: '+40% damage taken from your other attacks for 5s on everything pierced.',
    cost: T2,
    requires: 'huntersMark1',
    stats: { damage: 920, pierce: 99, markPct: 60, markDuration: 6 },
  },
];

export const pinningShotTree: AbilityTreeNode[] = [
  {
    id: 'cripplingShot1',
    name: 'Crippling Shot',
    desc: 'Each hit on the same target stacks a 12% armor shred (up to 4 stacks) alongside the slow — a dedicated execute tool against one priority target.',
    cost: T1,
    requires: null,
    excludes: ['webOfArrows1'],
    stats: { damage: 260, slowPct: 96, duration: 10, crippleStackPct: 12, crippleMaxStacks: 4 },
  },
  {
    id: 'cripplingShot2',
    name: 'Sundering Shot',
    desc: '18% shred per stack, up to 5 stacks, on an 88% slow lasting 5s.',
    cost: T2,
    requires: 'cripplingShot1',
    stats: { damage: 300, slowPct: 97, duration: 12, crippleStackPct: 20, crippleMaxStacks: 6 },
  },
  {
    id: 'webOfArrows1',
    name: 'Web of Arrows',
    desc: 'A weaker 35% slow spreads to anyone within 4 units of your mark — turns single-target control into a mini zone without losing the primary snare.',
    cost: T1,
    requires: null,
    excludes: ['cripplingShot1'],
    stats: { damage: 260, slowPct: 96, duration: 10, webRadius: 8.5, webSlowPct: 88 },
  },
  {
    id: 'webOfArrows2',
    name: 'Tangling Web',
    desc: 'A 45% slow spreads across a 5.5-unit radius around your mark.',
    cost: T2,
    requires: 'webOfArrows1',
    stats: { damage: 300, slowPct: 97, duration: 12, webRadius: 10, webSlowPct: 95 },
  },
];

export const grappleTree: AbilityTreeNode[] = [
  {
    id: 'quickdrawRig1',
    name: 'Quickdraw Rig',
    desc: 'Reels 40% faster and comes off cooldown in 70% of the normal time — built for constant repositioning rather than one big traversal.',
    cost: T1,
    requires: null,
    excludes: ['pitonShot1'],
    stats: { range: 72, pullSpeedMult: 1.8, cooldownMult: 0.45 },
  },
  {
    id: 'quickdrawRig2',
    name: 'Grapnel Array',
    desc: '80% faster reel, 50% of normal cooldown, range 36 — the fastest, most spammable mobility tool in the game.',
    cost: T2,
    requires: 'quickdrawRig1',
    stats: { range: 78, pullSpeedMult: 2.2, cooldownMult: 0.3 },
  },
  {
    id: 'pitonShot1',
    name: 'Piton Shot',
    desc: 'If the hook lands within 4 units of an enemy, it strikes for 35 dmg and yanks them 6 units toward you instead of pulling you toward it — a mobility tool that doubles as crowd control.',
    cost: T1,
    requires: null,
    excludes: ['quickdrawRig1'],
    stats: { range: 72, pitonRadius: 7, pitonDamage: 380, pitonPull: 6 },
  },
  {
    id: 'pitonShot2',
    name: 'Harpoon Shot',
    desc: '60 dmg and a 9-unit yank on anything within 5 units of the hook.',
    cost: T2,
    requires: 'pitonShot1',
    stats: { range: 78, pitonRadius: 8.5, pitonDamage: 560, pitonPull: 9 },
  },
];
