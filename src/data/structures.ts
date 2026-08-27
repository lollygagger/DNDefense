/** Structure balance data. Owned by [structures-allies]. Keep docs/GAME_DESIGN.md in sync. */

export const CROSSBOW = {
  cost: 60,
  range: 30,
  damage: 15,
  fireInterval: 1.2,
  projectileSpeed: 50,
  projectileRadius: 0.25,
  projectileTtl: 1.0, // seconds; ~range * 1.6 at projectileSpeed
  maxLeadTime: 1.2, // cap on linear-lead prediction seconds
  upgrades: {
    rapid1: { cost: 50, fireRateMult: 1.6 },
    rapid2: { cost: 90, fireRateMult: 2.2 }, // total, replaces rapid1's mult
    ballista1: { cost: 50, damageMult: 2.0, pierce: 1 },
    ballista2: { cost: 90, damageMult: 3.5, pierce: 2 }, // total, replaces ballista1's mult
  },
};

export const ARMORY = {
  cost: 80,
  maxSwordsmen: 3,
  respawnInterval: 8,
  spawnJitter: 1.2, // rng scatter around the sortie door
  upgrades: {
    veterans1: { cost: 70, bonusMax: 1, hpMult: 1.25 },
    veterans2: { cost: 120, damageMult: 1.5, hpMult: 1.25 }, // stacks on veterans1
  },
};

export const SWORDSMAN = {
  hp: 60,
  damage: 12,
  attackInterval: 1.0,
  speed: 4.8,
  // Guard post is no longer the door — it's a battle line this far in front of the wall's
  // front face (see guardPostFor() in sim/allies.ts). Chosen so the line:
  //  - clears melee enemies' own unengaged stopping point at the wall (ENEMY_AI.wallStopGap
  //    puts goblins/orcs ~2.5-3.3 off the wall), so incoming melee get intercepted by the line
  //    before they ever reach the wall face, instead of the line just being cosmetic;
  //  - sits well inside crossbow covering fire (CROSSBOW.range = 30 from the same wall face),
  //    with a lot of margin to spare;
  //  - sits well inside skeleton archer engage range (22) rather than parked right where
  //    archers like to plant and shoot from, so swordsmen aren't stationed at "archer kiting
  //    distance" from the wall — they're close enough to close to melee quickly;
  //  - leaves 3 units of clearance behind it: the tier-2/tier-3 courtyards are 9 units deep
  //    (WALL_Z spacing 12 - WALL_THICKNESS 3), so a line 6 out from the front wall's face
  //    still sits a comfortable 3 units clear of the previous wall's back face — forms up
  //    inside that wall's own courtyard, not crowding the wall behind it.
  lineDistance: 6,
  // Lateral gap between adjacent swordsmen holding the line, fanned out around the armory's
  // socket x (see guardPostFor()). Kept greater than separationRadius so a squad standing on
  // its posts is already spread further apart than the push-apart threshold — the separation
  // behavior in allies.ts has nothing to fight once everyone is home on the line.
  lineSpacing: 2.2,
  // Target-acquisition leash, measured from the ally's guard post (now the line, not the
  // wall). Was 30 when the post sat at the door; the post moved lineDistance (6) further out,
  // so this shrinks by the same amount to keep the total commit envelope measured from the
  // WALL unchanged at 30 (matching the crossbow's own range) while shortening the walk back to
  // the line after a kill — the whole point of holding a line instead of the wall face.
  aggroRange: 24,
  attackRange: 1.5, // melee reach (plus target radius)
  radius: 0.5,
  height: 1.8,
  separationRadius: 1.1, // allies closer than this push apart
  separationStrength: 5, // push speed (units/s at full overlap)
  guardTolerance: 0.75, // "close enough" to the guard post
};

/** Allies never chase past these bounds (keeps them off the spawn gate). Worst-case excursion
 *  from a tier-1 guard post is lineDistance + aggroRange + attackRange = 6 + 24 + 1.5 = 31.5
 *  units in front of the wall (z = -31.5 for tier 1), comfortably inside minZ; lateral reach is
 *  already capped by the enemy field bounds (FIELD_MIN_X/FIELD_MAX_X in data/castle.ts), well
 *  inside maxAbsX. */
export const ALLY_BOUNDS = {
  minZ: -40,
  maxAbsX: 24,
};
