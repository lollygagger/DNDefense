import type { AllyDef } from '../sim/allies';

/** Ally balance data. Owned by [structures-allies]. Keep docs/GAME_DESIGN.md in sync.
 *
 *  ---- Anchoring decisions (per behavior) ----
 *  Per the roadmap ("all allies deploy to the forwardmost wall, not just melee"), every
 *  behavior EXCEPT engineer now sets `reanchorToFront: true` — the whole army, not just the
 *  melee line, tracks the CURRENT outermost intact wall instead of freezing at whichever wall
 *  its own structure happens to sit on. What differs per behavior is DEPTH (how far from that
 *  wall's face the post sits, via the named LINE_DISTANCE constants below) and SIDE
 *  (`lineSide`: 'front' = out in the field, 'back' = sheltered in the courtyard):
 *  - melee (swordsman, tank): `lineSide: 'front'`, the largest distances (TANK/SWORDSMAN_LINE_
 *    DISTANCE) — the actual shield wall, standing the farthest out to take the brunt of it.
 *  - ranged (archer) / caster (allyMage): `lineSide: 'front'` too (a shot from behind an intact
 *    wall body is always blocked — see isMerlonX / blocksProjectile — so the wall face itself,
 *    not distance, is what shelters a shooter), but ARCHER/MAGE_LINE_DISTANCE are deliberately
 *    smaller than melee's — close enough to the wall that they sit BEHIND the melee line instead
 *    of in the scrum, while still well inside their own attackRange (18-20) of anything
 *    contesting that line, so their shots (including at flyers — see stepRangedOrCaster) still
 *    land. Reanchoring them alongside melee is what actually fixes "archers idling at the keep
 *    while the fight is two walls forward" — the whole point of this change.
 *  - support (medic, engineer): `lineSide: 'back'` — the safest of the three ranks, because
 *    `sim/enemies.ts` clamps every ground enemy's advance to no further than the CURRENT front
 *    wall's face while it stands, which makes the courtyard behind it categorically unreachable
 *    by ground units (only flyers ignore that clamp). Healing/repair are aura/value effects, not
 *    projectiles, so being behind solid stone doesn't block anything the way it would for
 *    archer/mage — see stepSupport in sim/allies.ts.
 *    - **medic** DOES reanchor (`reanchorToFront: true`): its heal is proximity-based (nearby
 *      defenders AND the player, both of whom are presumably fighting at the front), so a medic
 *      frozen at a stale home wall while the army pushes forward would eventually heal no one.
 *    - **engineer** does NOT reanchor. Its job is `stepEngineer`'s "repair `ally.homeTier`'s
 *      wall" — a fixed target wall, not a proximity effect — so unlike every other behavior here,
 *      moving it to the current front (possibly a different wall than the one it repairs) would
 *      buy nothing mechanically and break the "an engineer fixes THIS wall" fantasy. It stays
 *      posted at its own home wall; if that wall later becomes the front itself, it's already
 *      exactly where it needs to be, no reanchoring required. */

// ---- Battle-line depth offsets (distance from the CURRENT front wall's face, wall-relative —
// see guardZFor/guardPostFor in sim/allies.ts). Named/commented per the anchoring doc comment
// above; every reanchoring behavior's whole-formation silhouette comes from these six numbers. ----
export const TANK_LINE_DISTANCE = 7; // slightly ahead of the swordsman -> tanks form the true front rank
export const SWORDSMAN_LINE_DISTANCE = 6; // the shield wall itself
export const ARCHER_LINE_DISTANCE = 3; // behind the melee line, still comfortably inside attackRange (20)
export const MAGE_LINE_DISTANCE = 2.5; // tucked in even closer than the archer — squishiest ranged unit
// 'back' side: this deep INTO the courtyard behind the front wall. Kept tight to the wall so the
// medic's heal aura (see medic.healRange) reaches the front ranks across the wall's own thickness.
export const MEDIC_LINE_DISTANCE = 1.2;
export const ENGINEER_LINE_DISTANCE = 2.0; // 'back' side, relative to its own (non-reanchoring) home wall

export const ALLY_DEFS: Record<string, AllyDef> = {
  swordsman: {
    id: 'swordsman',
    name: 'Swordsman',
    behavior: 'melee',
    hp: 60,
    damage: 12,
    speed: 4.8,
    radius: 0.5,
    height: 1.8,
    attackInterval: 1.0,
    attackRange: 1.5,
    aggroRange: 24,
    lineDistance: SWORDSMAN_LINE_DISTANCE,
    lineSpacing: 2.2,
    separationRadius: 1.1,
    separationStrength: 5,
    guardTolerance: 0.75,
    reanchorToFront: true,
  },

  archer: {
    id: 'archer',
    name: 'Ally Archer',
    behavior: 'ranged',
    hp: 38,
    damage: 9,
    speed: 4.2,
    radius: 0.45,
    height: 1.7,
    attackInterval: 1.3,
    attackRange: 20,
    aggroRange: 24, // a bit past attackRange so they track/face a target before it's shootable
    lineDistance: ARCHER_LINE_DISTANCE, // inside the melee line — sheltered, per the file doc comment
    lineSpacing: 2.0,
    separationRadius: 1.0,
    separationStrength: 5,
    guardTolerance: 0.75,
    reanchorToFront: true,
    projectileSpeed: 45,
    projectileRadius: 0.18,
    projectileTtl: 1.2,
    muzzleHeightFrac: 0.85,
  },

  allyMage: {
    id: 'allyMage',
    name: 'Ally Mage',
    behavior: 'caster',
    hp: 32,
    damage: 20,
    speed: 3.8,
    radius: 0.45,
    height: 1.75,
    attackInterval: 2.6, // "a slower, heavier ranged attack" per the task
    attackRange: 18,
    aggroRange: 22,
    lineDistance: MAGE_LINE_DISTANCE,
    lineSpacing: 2.4, // wider than archer's — keeps allies clear of each other's splash
    separationRadius: 1.0,
    separationStrength: 5,
    guardTolerance: 0.75,
    reanchorToFront: true,
    projectileSpeed: 24,
    projectileRadius: 0.4,
    projectileTtl: 2.0,
    muzzleHeightFrac: 0.9,
    aoeRadius: 2.5,
    slowPct: 35,
    slowDuration: 2.5,
  },

  tank: {
    id: 'tank',
    name: 'Ally Tank',
    behavior: 'melee',
    hp: 220,
    damage: 8, // soaks, doesn't carry the fight — see Tank Barracks' Aggressive Stance for the counterpoint
    speed: 2.6, // bulky and slow per the roadmap
    radius: 0.65,
    height: 2.1,
    attackInterval: 1.3,
    attackRange: 1.8,
    aggroRange: 20,
    // Slightly AHEAD of the swordsman's own line: when both exist on the same front, tanks end
    // up forming the true front rank and swordsmen naturally fall in just behind them — free
    // emergent tank-in-front behavior from two numbers, no special-casing needed.
    lineDistance: TANK_LINE_DISTANCE,
    lineSpacing: 2.6,
    separationRadius: 1.3,
    separationStrength: 4,
    guardTolerance: 0.9,
    reanchorToFront: true,
  },

  medic: {
    id: 'medic',
    name: 'Medic',
    behavior: 'support',
    supportKind: 'medic',
    hp: 45,
    damage: 0,
    speed: 4.2,
    radius: 0.45,
    height: 1.7,
    attackInterval: 1,
    attackRange: 0,
    aggroRange: 0,
    lineDistance: MEDIC_LINE_DISTANCE,
    lineSide: 'back',
    lineSpacing: 1.8,
    separationRadius: 1.0,
    separationStrength: 5,
    guardTolerance: 1.0,
    reanchorToFront: true, // follows the front so its proximity-based heal stays useful — see doc comment above
    healAmount: 10,
    healInterval: 1.5,
    // Sized from the actual formation geometry, NOT picked for feel. A 'back'-side medic stands
    // behind a WALL_THICKNESS(6)-deep wall, so its distance to the front ranks is
    // WALL_THICKNESS + MEDIC_LINE_DISTANCE + that rank's own front distance — 14.2 to the tank
    // rank, 13.2 to the swordsmen. At the old value of 9 the medic could reach nothing but the
    // player standing on the wall, i.e. a Field Hospital healed none of the army it deploys with.
    // Keep this comfortably above (WALL_THICKNESS + MEDIC_LINE_DISTANCE + TANK_LINE_DISTANCE) if
    // any of those three constants change. Healing "through" the wall is intended — it's a
    // support aura, not a projectile.
    healRange: 16,
  },

  engineer: {
    id: 'engineer',
    name: 'Engineer',
    behavior: 'support',
    supportKind: 'engineer',
    hp: 45,
    damage: 0,
    speed: 4.0,
    radius: 0.45,
    height: 1.7,
    attackInterval: 1,
    attackRange: 0,
    aggroRange: 0,
    lineDistance: ENGINEER_LINE_DISTANCE,
    lineSide: 'back',
    lineSpacing: 1.8,
    separationRadius: 1.0,
    separationStrength: 5,
    guardTolerance: 1.0,
    // Deliberately NOT reanchorToFront — an engineer repairs its OWN home wall (ally.homeTier,
    // see stepEngineer) regardless of where it stands, so it stays posted there. See doc comment above.
    repairRate: 14, // hp/s from this one engineer; see ENGINEER_WALL_REPAIR_CAP for the combined ceiling
  },
};

export function getAllyDef(id: string): AllyDef {
  const def = ALLY_DEFS[id];
  if (!def) throw new Error(`Unknown ally def: ${id}`);
  return def;
}

/** Allies never chase/wander past these bounds (keeps them off the spawn gate). The worst-case
 *  excursion is a reanchoring melee ally at the tier-1 front: lineDistance + aggroRange +
 *  attackRange = 7 (tank) + 24 (swordsman's own aggroRange, the wider of the two) + 1.8 ≈ 33,
 *  comfortably inside minZ; lateral reach is already capped by the field bounds
 *  (FIELD_MIN_X/FIELD_MAX_X in data/castle.ts), well inside maxAbsX. Ranged/caster/support never
 *  chase at all, so this is a pure safety net for them. */
export const ALLY_BOUNDS = {
  minZ: -40,
  maxAbsX: 24,
};

/** Hard ceiling, in wall-hp-per-second, on how much combined free repair every engineer touching
 *  ONE wall tier can apply — regardless of how many engineers are stationed there or how far
 *  Corps of Sappers has been upgraded (see FIELD_HOSPITAL.upgrades.sapper2 in data/structures).
 *  This is the actual answer to "can't make walls effectively invincible": a single tough
 *  attacker already outpaces it (Orc Bruiser wallDps=20, Orc Warlord=60 — see data/enemies.ts),
 *  so engineers extend a wall's life under light/moderate pressure without neutralizing a real
 *  assault, and it stays true no matter how the per-engineer repairRate is tuned later. */
export const ENGINEER_WALL_REPAIR_CAP = 40;

/** Melee target acquisition/attack height gate — mirrors ENEMY_AI.aggroMaxDy (data/enemies.ts)
 *  exactly, same precedent, same number. Flying enemies (hot air balloon, dragon — see
 *  isFlyerDef/FLYER_AI in data/enemies.ts, added by [enemies-waves] after this module was
 *  written) cruise at y=9.5-10, well above any melee ally's reach; without this, a swordsman or
 *  tank would read a balloon directly overhead as XZ-adjacent, lock onto it as its target, and
 *  stand there whiffing at the sky while the ground enemies actually attacking it go unanswered.
 *  Ranged/caster allies are NOT gated by this — see stepRangedOrCaster in sim/allyAI.ts, which
 *  deliberately CAN engage flyers (a buildable anti-air answer, consistent with crossbow towers
 *  already engaging them and the roadmap's "air units must have a real counter" principle). */
export const MELEE_TARGET_MAX_DY = 2;
