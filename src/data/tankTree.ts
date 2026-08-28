import type { AbilityTreeNode } from '../sim/abilityTree';
import { TREE_TIER_COST } from '../sim/abilityTree';

/** Tank "Mastery" trees — see data/mageTree.ts's header for the shared conventions. Shield Bash
 *  and Bulwark stay CC-free even at this depth (see data/tank.ts's file header on why the primary
 *  and Bulwark are the Tank's deliberately-non-CC tools) — their branches add self-sustain
 *  instead. Consumed by data/tank.ts's cast()s. */

const [T1, T2] = TREE_TIER_COST;

export const shieldBashTree: AbilityTreeNode[] = [
  {
    id: 'riposte1',
    name: 'Riposte',
    desc: 'Each enemy caught in the swing grants 6% damage reduction for 2.5s (stacking per hit) — the more you are surrounded, the safer this makes you, with zero CC.',
    cost: T1,
    requires: null,
    excludes: ['vanguard1'],
    stats: { damage: 22, range: 4.1, reductionPerHitPct: 6, reductionDuration: 2.5 },
  },
  {
    id: 'riposte2',
    name: 'Perfect Riposte',
    desc: '9% reduction per enemy hit, lasting 3s.',
    cost: T2,
    requires: 'riposte1',
    stats: { damage: 28, range: 4.4, reductionPerHitPct: 9, reductionDuration: 3 },
  },
  {
    id: 'vanguard1',
    name: "Vanguard's Resolve",
    desc: 'Heals 4 HP per enemy hit — sustain through attrition instead of mitigation, still zero CC.',
    cost: T1,
    requires: null,
    excludes: ['riposte1'],
    stats: { damage: 24, range: 4.1, healPerHit: 4 },
  },
  {
    id: 'vanguard2',
    name: "Vanguard's Fortitude",
    desc: 'Heals 7 HP per enemy hit.',
    cost: T2,
    requires: 'vanguard1',
    stats: { damage: 30, range: 4.4, healPerHit: 7 },
  },
];

export const shieldSlamTree: AbilityTreeNode[] = [
  {
    id: 'concussiveSlam1',
    name: 'Concussive Slam',
    desc: 'Stun duration grows 0.25s per enemy caught in the blast (capped at 2.6s) — the bigger the cluster, the longer everyone in it is locked down.',
    cost: T1,
    requires: null,
    excludes: ['focusedSlam1'],
    stats: { damage: 60, radius: 4.3, stunDuration: 1.2, stunPerTarget: 0.25, stunCap: 2.6 },
  },
  {
    id: 'concussiveSlam2',
    name: 'Shattering Slam',
    desc: '+0.35s stun per target, capped at 3.2s.',
    cost: T2,
    requires: 'concussiveSlam1',
    stats: { damage: 75, radius: 4.6, stunDuration: 1.4, stunPerTarget: 0.35, stunCap: 3.2 },
  },
  {
    id: 'focusedSlam1',
    name: 'Focused Slam',
    desc: 'Half the radius (2.2), but the single closest target eats +60 bonus damage and +1.2s bonus stun — trade area coverage for locking down one priority threat (a warlord, a caster) hard.',
    cost: T1,
    requires: null,
    excludes: ['concussiveSlam1'],
    stats: { damage: 70, radius: 2.2, stunDuration: 1.6, focusBonusDamage: 60, focusStunBonus: 1.2 },
  },
  {
    id: 'focusedSlam2',
    name: 'Executioner’s Slam',
    desc: '+100 bonus damage and +1.8s bonus stun on the single closest target.',
    cost: T2,
    requires: 'focusedSlam1',
    stats: { damage: 85, radius: 2.4, stunDuration: 1.9, focusBonusDamage: 100, focusStunBonus: 1.8 },
  },
];

export const bulwarkTree: AbilityTreeNode[] = [
  {
    id: 'aegisOverflow1',
    name: 'Aegis Overflow',
    desc: 'Adds an 80 HP absorb shield on top of the 55% reduction — soaks a burst hit that would punch straight through a percentage reduction alone.',
    cost: T1,
    requires: null,
    excludes: ['retaliation1'],
    stats: { reductionPct: 55, duration: 5, shieldAmount: 80, shieldDuration: 5 },
  },
  {
    id: 'aegisOverflow2',
    name: 'Bastion Overflow',
    desc: '150 HP absorb shield, 60% reduction for 6s.',
    cost: T2,
    requires: 'aegisOverflow1',
    stats: { reductionPct: 60, duration: 6, shieldAmount: 150, shieldDuration: 6 },
  },
  {
    id: 'retaliation1',
    name: 'Retaliation',
    desc: 'While Bulwarked, every hit you take triggers a 20 dmg pulse to enemies within 5 units — turtle and punish at the same time.',
    cost: T1,
    requires: null,
    excludes: ['aegisOverflow1'],
    stats: { reductionPct: 50, duration: 5, thornsRadius: 5, thornsDamage: 20 },
  },
  {
    id: 'retaliation2',
    name: 'Vengeful Retaliation',
    desc: '35 dmg retaliation pulse across a 6-unit radius.',
    cost: T2,
    requires: 'retaliation1',
    stats: { reductionPct: 55, duration: 6, thornsRadius: 6, thornsDamage: 35 },
  },
];

export const shieldChargeTree: AbilityTreeNode[] = [
  {
    id: 'juggernaut1',
    name: 'Juggernaut',
    desc: 'Damages everything along the charge’s path (30 dmg, 2.2-unit sweep), not just the landing — plow straight through a line instead of just the enemy at the end of it.',
    cost: T1,
    requires: null,
    excludes: ['bulwarkCharge1'],
    stats: { speed: 9.0, damage: 70, radius: 3.8, stunDuration: 1.3, sweepRadius: 2.2, sweepDamage: 30 },
  },
  {
    id: 'juggernaut2',
    name: 'Rampage',
    desc: '50 dmg, 2.6-unit sweep along the whole charge.',
    cost: T2,
    requires: 'juggernaut1',
    stats: { speed: 9.5, damage: 85, radius: 4.0, stunDuration: 1.5, sweepRadius: 2.6, sweepDamage: 50 },
  },
  {
    id: 'bulwarkCharge1',
    name: 'Bulwark Charge',
    desc: 'Grants 45% damage reduction for the duration of the charge and landing — barge into danger safely instead of dealing more of it.',
    cost: T1,
    requires: null,
    excludes: ['juggernaut1'],
    stats: { speed: 8.8, damage: 65, radius: 3.6, stunDuration: 1.2, chargeReductionPct: 45, chargeReductionDuration: 2.5 },
  },
  {
    id: 'bulwarkCharge2',
    name: 'Aegis Charge',
    desc: '60% damage reduction through the charge and landing.',
    cost: T2,
    requires: 'bulwarkCharge1',
    stats: { speed: 9.2, damage: 78, radius: 3.8, stunDuration: 1.4, chargeReductionPct: 60, chargeReductionDuration: 3 },
  },
];
