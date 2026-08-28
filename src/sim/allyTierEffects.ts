import type { GameState } from './GameState';
import type { Enemy, Wall, WallTier } from './types';
import { applyBleed, applyVulnerability } from './abilityEffects';
import { TANK_THORNS_PULSE_COOLDOWN } from '../data/allies';
import type { AllyDef, AllyUnit } from './allies';

/** Owned by [structures-allies]. Behavior hooks for the five spawners' 600g/1600g high-tier
 *  upgrades (late-game spawner-upgrades task, 2026-08-27) — split out of sim/allies.ts and
 *  sim/allyAI.ts purely to keep those files under the ~400-line guideline, the exact same
 *  reasoning sim/abilityEffects.ts was split out of sim/classes.ts for. Nothing here is called
 *  from outside sim/allies.ts / sim/allyAI.ts. See data/structures.ts's ARMORY/ARCHER_BARRACKS/
 *  MAGE_TOWER/TANK_BARRACKS/FIELD_HOSPITAL `upgrades` doc comments for the design rationale
 *  behind each of these; this file is pure mechanism. */

/** Swordsman Armory's high tier (mutually exclusive — see data/structures.ts): Bleeding Strikes
 *  stacks a DoT via the same generic sim/abilityEffects.ts helper the player Warrior's own
 *  Bloodletting Mastery uses; Sundering Blows marks the target so the WHOLE army's damage (not
 *  just this swordsman's) hits harder for a few seconds. Called from stepMelee right after a
 *  landed hit, skipped if that hit was lethal (no point marking a corpse). */
export function applyMeleeHitEffects(def: AllyDef, target: Enemy, game: GameState): void {
  if (def.bleedDpsPerStack) applyBleed(target, game, def.bleedDpsPerStack, def.bleedDuration ?? 3, def.bleedMaxStacks ?? 5);
  if (def.markVulnPct) applyVulnerability(target, game, 1 + def.markVulnPct / 100, def.markVulnDuration ?? 3);
}

/** Field Hospital's Guardian's Grace: called only when a hit would otherwise drop `victim` to 0
 *  hp (see spawnAlly's takeDamage in sim/allies.ts). Looks for a living medic with the upgrade
 *  (`def.reviveRange` set) within range and off its OWN cooldown (per-medic, via `nextReviveAt`
 *  — a medic can't save the whole army every tick), and if one exists, claims its cooldown and
 *  returns the hp `victim` should be left at instead of dying. Returns null if no medic can help
 *  (the normal death path runs).
 *
 *  DELIBERATELY does not resurrect an already-dead unit. `initAllies`'s tick culls a dead ally
 *  from `game.allies` (and its owning SpawnerStructure/Roster notices next tick, frees the slot,
 *  and starts counting toward a natural replacement) before any support ally could ever act on
 *  it — reviving the same object afterward would race that bookkeeping and could let a roster
 *  silently exceed its cap (the revived unit plus a freshly-spawned replacement). Intercepting
 *  the killing blow BEFORE hp ever reaches 0 sidesteps that race entirely: the unit's `alive`
 *  flag never flips, so nothing else in the game (slot tracking, the cull above) ever has
 *  anything to notice. Scoped to allies only — the player has its own respawn system elsewhere
 *  and isn't touched here. */
export function tryMedicSave(victim: AllyUnit, game: GameState): number | null {
  for (const a of game.allies) {
    const medic = a as AllyUnit;
    if (!medic.alive || medic.def.supportKind !== 'medic' || !medic.def.reviveRange) continue;
    if (medic === victim || game.time < medic.nextReviveAt) continue;
    const dx = medic.pos.x - victim.pos.x;
    const dz = medic.pos.z - victim.pos.z;
    if (dx * dx + dz * dz > medic.def.reviveRange * medic.def.reviveRange) continue;
    medic.nextReviveAt = game.time + (medic.def.reviveCooldown ?? 20);
    game.projectiles.impacts.push({ pos: victim.pos.clone(), kind: 'secondWind', aoe: false });
    return Math.max(1, Math.round(victim.maxHp * (medic.def.reviveHpFrac ?? 0.25)));
  }
  return null;
}

/** Tank Barracks' Retaliation Plating: whenever `unit` takes damage and survives, pulse damage
 *  to enemies clustered around it. A self-contained equivalent of sim/abilityEffects.ts's
 *  applyThorns/pulseThornsIfReady rather than a reuse of it — that machinery is keyed on
 *  PlayerState and driven by a central tick over game.players only, so an ally (never a
 *  PlayerState, and never visited by that loop) can't plug into it without either an illegitimate
 *  cast or editing that FROZEN-adjacent file. Rate-limited independently of how many attackers
 *  hit the same tank in one tick (TANK_THORNS_PULSE_COOLDOWN), same reasoning as the ability
 *  version: a swarm alpha-striking one tank can't chain this into an instant AoE nuke of itself. */
export function pulseThornsIfReady(unit: AllyUnit, game: GameState): void {
  const def = unit.def;
  if (!def.thornsDamage || game.time < unit.nextThornsAt) return;
  unit.nextThornsAt = game.time + TANK_THORNS_PULSE_COOLDOWN;
  const r2 = (def.thornsRadius ?? 3) * (def.thornsRadius ?? 3);
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const dx = e.pos.x - unit.pos.x;
    const dz = e.pos.z - unit.pos.z;
    if (dx * dx + dz * dz > r2) continue;
    e.takeDamage(def.thornsDamage, game);
  }
}

/** Field Hospital's Emergency Patching/Triage Protocols (independent of the engineer's steady
 *  repair trickle in sim/allyAI.ts's stepEngineer — see data/structures.ts's FIELD_HOSPITAL.
 *  upgrades doc comment on why this building's high tier isn't a mutually-exclusive pair like the
 *  other four spawners'): once per WAVE, if `wall` has dropped to/below a threshold, instantly
 *  restore a flat chunk of its max hp. A discrete, rare, bounded event — deliberately NOT routed
 *  through the steady per-tick repairBudget/ENGINEER_WALL_REPAIR_CAP accounting, so it can never
 *  raise the sustained hp/sec ceiling that guarantee depends on; it only ever fires once per wave
 *  per wall tier, via `emergencyPatchedWave` (shared across every engineer touching that wall,
 *  same sharing shape repairBudget already uses). Caller (stepEngineer) already guards
 *  `wall.built && wall.hp > 0` before this runs. */
export function applyEmergencyPatch(
  ally: AllyUnit,
  def: AllyDef,
  wall: Wall,
  game: GameState,
  emergencyPatchedWave: Map<WallTier, number>,
): void {
  if (!def.emergencyPatchPct) return;
  if (wall.hp > wall.maxHp * ((def.emergencyThresholdPct ?? 20) / 100)) return;
  if (emergencyPatchedWave.get(wall.tier) === game.waveNumber) return;
  emergencyPatchedWave.set(wall.tier, game.waveNumber);
  wall.hp = Math.min(wall.maxHp, wall.hp + wall.maxHp * (def.emergencyPatchPct / 100));
  game.projectiles.impacts.push({ pos: ally.pos.clone(), kind: 'secondWind', aoe: false });
}
