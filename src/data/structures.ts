/** Structure balance data. Owned by [structures-allies]. Keep docs/GAME_DESIGN.md in sync.
 *  Ally combat stats (hp/damage/speed/behavior/...) live in data/allies.ts — this file only
 *  holds the STRUCTURE-level knobs: build cost, roster caps, respawn cadence, and upgrade costs
 *  (which translate into ally-stat multipliers, applied in sim/structures/*.ts at spawn time). */

/** Crossbow — three mutually exclusive identities from first upgrade onward (Phase 2 roadmap:
 *  "keep Rapid, extend Ballista to range+damage+pierce, add Cannon"). `projectileTtl` was a fixed
 *  constant tuned for the base bolt (range 30 / speed 50); now that Ballista extends range and
 *  Cannon slows the bolt down, ttl is computed per-shot in crossbow.ts as
 *  `(effectiveRange * TTL_SAFETY) / effectiveSpeed` instead — same ~1.0s result at base stats
 *  (30 * 1.6 / 50 = 0.96), but it stays correct as range/speed change per branch. */
export const CROSSBOW = {
  cost: 60,
  range: 30,
  damage: 15,
  fireInterval: 1.2,
  projectileSpeed: 50,
  projectileRadius: 0.25,
  ttlSafetyFactor: 1.6, // ttl = range * this / speed — enough slack that a bolt never times out short of its own max range
  maxLeadTime: 1.2, // cap on linear-lead prediction seconds
  upgrades: {
    rapid1: { cost: 50, fireRateMult: 1.6 },
    rapid2: { cost: 90, fireRateMult: 2.2 }, // total, replaces rapid1's mult
    // Ballista: range + damage + pierce, all three named explicitly in the roadmap. The
    // long-reach precision pick — best against a single tough target far out, or a whole line
    // of them thanks to pierce.
    ballista1: { cost: 50, damageMult: 2.0, pierce: 1, rangeBonus: 6 },
    ballista2: { cost: 90, damageMult: 3.5, pierce: 2, rangeBonus: 12 }, // total, replaces ballista1
    // Cannon: a big, slow, splash-damage shot. No range or pierce bonus (splash does the
    // multi-target work instead) and a slower reload — heavy single-shot payoff against clustered
    // or slow targets, worst of the three against one fast/erratic mover (the slow bolt needs a
    // long lead, and there's nothing to chain to if it whiffs).
    cannon1: { cost: 50, damageMult: 3.0, aoeRadius: 3, projectileSpeedMult: 0.4, fireRateMult: 0.7, projectileRadius: 0.4 },
    cannon2: { cost: 90, damageMult: 5.0, aoeRadius: 4.5, projectileSpeedMult: 0.42, fireRateMult: 0.78, projectileRadius: 0.5 }, // total, replaces cannon1
  },
};

/** Flamethrower (static defense, embrasure socket) — the roadmap's "short range but big aoe
 *  that increases with level." The opposite trade from the crossbow: a very short, wide cone of
 *  continuous fire instead of a precise long shot. Damage is true damage-over-time (dps * dt
 *  applied directly every tick a target sits in the cone, never a spawned projectile), so it
 *  reads identically at any tick rate and never becomes a "spam projectiles" loop. Cone coverage
 *  (range x angle) grows substantially with level: Inferno II's cone covers roughly 6x the area
 *  of the base nozzle (14 x 75 deg vs 7 x 50 deg). Ground-only — see STRUCTURE_ANTI_AIR below —
 *  so it's a deliberate non-answer to balloons/dragons, unlike the crossbow or arc lightning. */
export const FLAMETHROWER = {
  cost: 130,
  range: 7, // vs the crossbow's 30 — must let enemies close almost to the wall face to matter
  halfArcDeg: 50, // ~100 degree total cone in front of the muzzle
  dps: 42,
  fxPulseInterval: 0.12, // throttles the "still burning" visual indicator only, not gameplay
  upgrades: {
    inferno1: { cost: 100, range: 10, halfArcDeg: 62, dps: 68 },
    inferno2: { cost: 170, range: 14, halfArcDeg: 75, dps: 108 }, // total, replaces inferno1
  },
};

/** Arc Lightning Tower (static defense, embrasure socket) — the roadmap's "chains between
 *  targets" ask, built as its own embrasure tower rather than an upgrade branch: the three
 *  embrasure slots per wall already give a player 1 defense pick each, and a chaining attack is
 *  a genuinely different shape (mid-range, rewards spread-out groups) from both the crossbow
 *  (long-range single-target precision) and the flamethrower (point-blank continuous cone) — a
 *  fourth branch on an already 3-branched crossbow would have diluted that pick instead of
 *  adding one. Each shot hits the nearest valid target in range, then jumps to the nearest
 *  *other* enemy within chainRadius of the last one hit (never repeating a target within the
 *  same volley), multiplying running damage by chainFalloff on every jump. Weak against a lone,
 *  isolated target — with nothing nearby to jump to, it's a single hit at base damage, worse
 *  per-shot than a plain crossbow bolt. Strong against clustered/spread groups within jump range
 *  of each other, including mixed air+ground groups (see STRUCTURE_ANTI_AIR — this is the
 *  ranged, magical anti-air pick, as opposed to the crossbow's incidental one). */
export const ARC_LIGHTNING = {
  cost: 150,
  range: 20,
  fireInterval: 1.6,
  damage: 26,
  chainRadius: 6,
  chainFalloff: 0.65, // running damage multiplies by this on every jump
  chainJumps: 2, // additional targets beyond the first (3 hit total)
  upgrades: {
    overcharge1: { cost: 110, damage: 34, chainJumps: 3, chainRadius: 7 },
    overcharge2: { cost: 190, damage: 46, chainJumps: 4, chainRadius: 8.5 }, // total, replaces overcharge1
  },
};

/** Explicit anti-air capability, per structure defId (Phase 2 roadmap: "give structures an
 *  explicit can-this-hit-air property" instead of the crossbow's old *accidental* one — its
 *  target search simply never had a height/type gate). `StructureDef` (sim/types.ts) is frozen,
 *  so this is a companion lookup keyed by defId rather than a field on the def itself — the same
 *  pattern data/enemies.ts already uses for FLYER_AI/isFlyerDef to extend the frozen `EnemyDef`.
 *  Every structure's own target search consults this alongside `isFlyerDef(enemy.defId)`
 *  (data/enemies.ts): `if (!structureCanHitAir(defId) && isFlyerDef(e.defId)) continue;`.
 *  Missing defId => false: a structure has to opt in to threatening the sky, not opt out — so a
 *  future ground-only tower added without touching this table is safely ground-only by default. */
export const STRUCTURE_ANTI_AIR: Record<string, boolean> = {
  crossbow: true, // full 3D aim, no height gate — unchanged behavior, now a deliberate flag
  flamethrower: false, // a ground-hugging cone that can't reach cruise altitude
  arcLightning: true, // bolts arc through open air exactly as readily as across the ground
};

export function structureCanHitAir(defId: string): boolean {
  return STRUCTURE_ANTI_AIR[defId] ?? false;
}

export const ARMORY = {
  cost: 80,
  maxSwordsmen: 3,
  respawnInterval: 8,
  spawnJitter: 1.2, // rng scatter around the sortie door
  upgrades: {
    veterans1: { cost: 70, bonusMax: 1, hpMult: 1.25 },
    veterans2: { cost: 120, damageMult: 1.5, hpMult: 1.25 }, // stacks on veterans1
    // ---- High tier (late-game gold sink task, 2026-08-27): same 600g/1600g shape ability
    // Mastery trees use (docs/GAME_DESIGN.md), not gated behind veterans1/2 for the same reason
    // Mastery isn't gated behind an ability's maxed linear ranks — this is a second, independent
    // branch point, not a continuation of the cheap one. Two mutually exclusive roots (see
    // sim/structures/armory.ts): Bleeding Strikes (stacking DoT via sim/abilityEffects.ts's
    // applyBleed — pure attrition on one tough target) vs Sundering Blows (a vulnerability mark
    // via applyVulnerability — every swordsman becomes a spotter amplifying the WHOLE army's
    // damage, not just its own). Purely behavioral: neither root touches hp/damage directly.
    bleedingStrikes1: { cost: 600, bleedDpsPerStack: 10, bleedDuration: 3, bleedMaxStacks: 3 },
    bleedingStrikes2: { cost: 1600, bleedDpsPerStack: 18, bleedDuration: 4, bleedMaxStacks: 4 }, // total, replaces tier 1
    sunderingBlows1: { cost: 600, markVulnPct: 15, markVulnDuration: 3 },
    sunderingBlows2: { cost: 1600, markVulnPct: 25, markVulnDuration: 4 }, // total, replaces tier 1
  },
};

/** Archer Barracks (spawner, chamber socket) — ranged allies that hold the wall's line and
 *  shoot. Priced above the Armory: ranged DPS-at-range is worth more than melee soak. The
 *  decision: Marksmen (fewer, harder-hitting, longer-ranged archers) vs Volley (more archers,
 *  faster fire rate) — concentrated single-target DPS vs raw volume of arrows, mutually
 *  exclusive like the crossbow's rapid/ballista split. */
export const ARCHER_BARRACKS = {
  cost: 100,
  maxArchers: 2,
  respawnInterval: 9,
  spawnJitter: 1.2,
  upgrades: {
    marksman1: { cost: 70, damageMult: 1.3 },
    marksman2: { cost: 120, damageMult: 1.7, rangeBonus: 4 }, // total, replaces marksman1
    volley1: { cost: 70, bonusMax: 1, fireRateMult: 1.3 },
    volley2: { cost: 120, bonusMax: 2, fireRateMult: 1.6 }, // total, replaces volley1
    // ---- High tier: a second, independent branch point (600g/1600g, not gated behind
    // marksman2/volley2 — same "not gated behind the linear/cheap tier" precedent as ability
    // Mastery), so the cheap axis (damage-per-archer vs roster size) and this axis (how the shot
    // itself behaves) combine into real build diversity. Broadhead Arrows reuses the frozen
    // ProjectileSpec's own `pierce` field (already plumbed for the crossbow's Ballista branch) —
    // clears a lane of enemies standing in a line. Explosive Fletching reuses `aoeRadius` (already
    // plumbed generically for ranged/caster allies via fireAt in sim/allyAI.ts, same field the ally
    // mage's splash uses) — clears whatever's clustered at the wall instead. Mutually exclusive:
    // pierce a line vs splash a cluster is the same shape of decision as the crossbow's own
    // Ballista-vs-Cannon split.
    broadheadArrows1: { cost: 600, pierce: 1 },
    broadheadArrows2: { cost: 1600, pierce: 2 }, // total, replaces tier 1
    explosiveFletching1: { cost: 600, aoeRadius: 2.0 },
    explosiveFletching2: { cost: 1600, aoeRadius: 3.0 }, // total, replaces tier 1
  },
};

/** Mage Tower (spawner, chamber socket) — caster allies: fewer and pricier than any other
 *  spawner (base cap of 1), per the task. The decision: Overload (bigger AoE nuke) vs Chilling
 *  Presence (stronger/longer slow, a control tool) are mutually exclusive; Reinforced Spire
 *  (a second mage) is an independent third root, orthogonal to which combat style you picked —
 *  so "do I want a second mage at all" is its own choice, not tied to the damage/control split. */
export const MAGE_TOWER = {
  cost: 140,
  maxMages: 1,
  respawnInterval: 14,
  spawnJitter: 1.0,
  upgrades: {
    overload1: { cost: 90, damageMult: 1.5, aoeMult: 1.2 },
    overload2: { cost: 150, damageMult: 2.1, aoeMult: 1.4 }, // total, replaces overload1
    chill1: { cost: 90, slowPctBonus: 15, durationBonus: 1 },
    chill2: { cost: 150, slowPctBonus: 30, durationBonus: 2 }, // total, replaces chill1
    reinforcedSpire: { cost: 130, bonusMax: 1 },
    // ---- High tier: independent of overload/chill/reinforcedSpire (same "not gated behind the
    // cheap tier" precedent). Arcane Residue reuses sim/abilityEffects.ts's spawnGroundEffect
    // (the exact helper the player Mage's own Volcanic Rupture/Killing Frost Mastery branches
    // use) — the blast leaves a lingering scorched patch, converting a single burst into
    // sustained area denial. Twin Casting is named after (and mechanically mirrors) the player
    // Mage's own Fork Bolt -> Arcane Fusillade Mastery: instead of one heavy nuke, the tower
    // fires an extra, weaker bolt at a second nearby target the instant it casts — trading some
    // per-target damage for actually answering a spread group instead of committing everything
    // to one target. Mutually exclusive: sustained damage over the blast site vs spreading the
    // SAME cast across multiple targets are genuinely different answers to "there's more than
    // one enemy here."
    arcaneResidue1: { cost: 600, lingerDps: 16, lingerDuration: 3, lingerRadius: 2.5 },
    arcaneResidue2: { cost: 1600, lingerDps: 28, lingerDuration: 4.5, lingerRadius: 3.2 }, // total, replaces tier 1
    twinCasting1: { cost: 600, extraBoltCount: 1, extraBoltDamageMult: 0.5 },
    twinCasting2: { cost: 1600, extraBoltCount: 2, extraBoltDamageMult: 0.65 }, // total, replaces tier 1
  },
};

/** Tank Barracks (spawner, chamber socket) — bulky, slow, high-HP melee. The roster cap never
 *  grows (2, always) — the point of a tank is that it's scarce and expensive per unit, not that
 *  you field an army of them. The decision: Plated Armor (more HP + flat damage reduction — a
 *  real mitigation curve, not just a bigger HP bar, so it's actually different from "soak more
 *  hits" in how it plays against a few heavy blows vs many light ones) vs Aggressive Stance
 *  (more damage + speed, trading pure soak for an actual threat). Mutually exclusive. */
export const TANK_BARRACKS = {
  cost: 120,
  maxTanks: 2,
  respawnInterval: 10,
  spawnJitter: 1.2,
  upgrades: {
    platedArmor1: { cost: 90, hpMult: 1.3, reductionPct: 0.1 },
    platedArmor2: { cost: 140, hpMult: 1.6, reductionPct: 0.2 }, // total, replaces platedArmor1
    aggressive1: { cost: 90, damageMult: 1.5, speedMult: 1.2 },
    aggressive2: { cost: 140, damageMult: 2.0, speedMult: 1.4 }, // total, replaces aggressive1
    // ---- High tier: independent of platedArmor/aggressive. Retaliation Plating pulses damage to
    // everything near the tank whenever IT is struck (a custom implementation, not
    // sim/abilityEffects.ts's applyThorns/pulseThornsIfReady — that machinery is keyed to
    // PlayerState and driven by a central per-tick loop over game.players only, neither of which
    // an ally participates in; see sim/allies.ts's spawnAlly for the self-contained equivalent) —
    // punishes being swarmed. Hardened Resolve instead heals the tank a flat amount on every
    // LANDED hit — sustain through successfully landing blows on one tough target, the opposite
    // scenario from Retaliation (which does nothing if nothing's in range to punish). Mutually
    // exclusive: "I expect to be surrounded" vs "I expect to duel one big thing."
    retaliationPlating1: { cost: 600, thornsDamage: 12, thornsRadius: 4 },
    retaliationPlating2: { cost: 1600, thornsDamage: 22, thornsRadius: 5 }, // total, replaces tier 1
    hardenedResolve1: { cost: 600, healOnHit: 5 },
    hardenedResolve2: { cost: 1600, healOnHit: 10 }, // total, replaces tier 1
  },
};

/** Field Hospital (spawner, chamber socket) — medic + engineer in one structure, per the
 *  roadmap. The priciest spawner: it doesn't fight at all, its value is entirely in sustain, so
 *  it needs to compete on "how much gold does this save you in repairs/potions" rather than
 *  kills. Unlike the other three spawners, Combat Medics and Corps of Sappers are NOT mutually
 *  exclusive — both are worth having on an expensive late-game building meant to do both jobs
 *  well eventually, so the decision is priority/ordering (which do you fund first) and total
 *  investment, not a permanent either/or. */
export const FIELD_HOSPITAL = {
  cost: 160,
  maxMedics: 1,
  maxEngineers: 1,
  respawnInterval: 12,
  spawnJitter: 1.2,
  upgrades: {
    medic1: { cost: 100, healMult: 1.5, rangeMult: 1.3 },
    medic2: { cost: 160, healMult: 2.0, bonusMedics: 1 }, // total, replaces medic1's heal mult
    sapper1: { cost: 100, repairMult: 1.5 },
    sapper2: { cost: 160, repairMult: 2.2, bonusEngineers: 1 }, // total, replaces sapper1
    // ---- High tier (600g/1600g, matching the ability-Mastery gold sink shape elsewhere): TWO
    // independent capstones, NOT mutually exclusive with each other or with medic1/2/sapper1/2 —
    // unlike the other four spawners' new tier, which are a single exclusive pair. This follows
    // the Field Hospital's OWN pre-existing design principle straight from this file's doc
    // comment above ("a purely-support building is meant to eventually do both jobs well, so the
    // choice is which to fund first, not either/or") rather than importing the crossbow's
    // either/or shape onto a building that was deliberately built not to have one.
    //
    // Guardian's Grace (medic side): a medic within range can save a defender from what would
    // otherwise be a killing blow, once per medic on a long cooldown, leaving them standing at a
    // fraction of max HP instead — see sim/allies.ts's tryMedicSave, called from spawnAlly's
    // takeDamage. Deliberately does NOT resurrect an already-dead unit (see that function's doc
    // comment for why: a dead ally is culled from game.allies, and its owning spawner frees the
    // slot and starts a replacement, in the same tick it dies — reviving the same object afterward
    // would silently let a roster exceed its cap). Scoped to allies only, not the player (the
    // player already has its own 5s respawn-at-the-keep system elsewhere).
    guardianGrace1: { cost: 600, reviveRange: 10, reviveHpFrac: 0.25, reviveCooldown: 20 },
    guardianGrace2: { cost: 1600, reviveRange: 12, reviveHpFrac: 0.45, reviveCooldown: 14 }, // total, replaces tier 1
    //
    // Emergency Patching (engineer side): once per WAVE, if this wall's hp drops to/below a
    // threshold during combat, an engineer instantly patches a flat chunk of its max hp back — a
    // bounded, rare, discrete event, NOT routed through the steady per-tick repairBudget/
    // ENGINEER_WALL_REPAIR_CAP accounting in sim/allyAI.ts's stepEngineer, so the "can't make a
    // wall unbreakable under sustained pressure" guarantee stays exactly as true as it already
    // was — this only ever fires once per wave per wall tier, it doesn't raise the sustained
    // hp/sec ceiling at all.
    emergencyPatch1: { cost: 600, emergencyThresholdPct: 20, emergencyPatchPct: 15 },
    emergencyPatch2: { cost: 1600, emergencyThresholdPct: 30, emergencyPatchPct: 25 }, // total, replaces tier 1
  },
};
