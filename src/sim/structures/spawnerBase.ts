import type { GameState } from '../GameState';
import type { Socket, StructureInstance, Unit } from '../types';
import { guardPostFor, spawnAlly, type AllyDef } from '../allies';
import { getAllyDef } from '../../data/allies';

/** Owned by [structures-allies]. Generic single-ally-type spawner: maintains up to N of one
 *  AllyDef, respawning one at a time, with upgrade-driven stat/roster growth. This is what the
 *  Swordsman Armory, Archer Barracks, Mage Tower, and Tank Barracks all reduce to — they differ
 *  only in *which* ally they spawn and how their own upgrades transform its base stats, which
 *  is exactly the data-driven shape the ally roster generalization was for. The Field Hospital
 *  is the one spawner that doesn't fit this (it runs two rosters at once — medic + engineer —
 *  so it gets its own dedicated class in fieldHospital.ts). */

export interface SpawnerConfig {
  defId: string; // structure def id (for the instance's StructureInstance.defId)
  allyDefId: string; // key into ALLY_DEFS — which ally this structure spawns
  baseMax: number; // roster cap with no upgrades
  respawnInterval: number;
  spawnJitter: number; // rng scatter around the sortie point
  /** Absolute cap this spawner could ever reach across all its upgrades — sizes the slot pool
   *  once, so a freed slot (its ally died) is reused instead of slot numbers climbing forever
   *  (see lineSlotOffset in sim/allies.ts — slot N sits ceil(N/2) spacings from center, so an
   *  ever-growing slot number would spread the line wider and wider over a long game). */
  maxPossible: number;
  /** Current roster cap given purchased upgrade ids. */
  maxFor(purchased: string[]): number;
  /** Per-instance AllyDef overrides derived from purchased upgrade ids, applied on top of the
   *  base ALLY_DEFS entry at spawn time (future upgrades only affect allies spawned afterward —
   *  same rule the original Armory's Veterans upgrades used). */
  overridesFor(base: AllyDef, purchased: string[]): Partial<AllyDef>;
}

export class SpawnerStructure implements StructureInstance {
  defId: string;
  socketId: string;
  purchased: string[] = [];

  private disabled = false;
  private spawned: { unit: Unit; slot: number }[] = [];
  private nextSpawnAt = 0;
  private slotFree: boolean[];

  constructor(
    private socket: Socket,
    private cfg: SpawnerConfig,
  ) {
    this.socketId = socket.id;
    this.defId = cfg.defId;
    this.slotFree = new Array(cfg.maxPossible).fill(true);
  }

  /** Called once right after construction (from the def's create()) to sortie the first ally
   *  immediately, per the established design ("one respawns every Ns" starts after the first). */
  bootstrap(game: GameState): void {
    this.spawnOne(game);
    this.nextSpawnAt = game.time + this.cfg.respawnInterval;
  }

  tick(_dt: number, game: GameState): void {
    if (this.spawned.some((a) => !a.unit.alive)) {
      for (const a of this.spawned) if (!a.unit.alive) this.slotFree[a.slot] = true;
      this.spawned = this.spawned.filter((a) => a.unit.alive);
    }
    if (this.disabled) return;

    const maxAllowed = this.cfg.maxFor(this.purchased);
    if (this.spawned.length < maxAllowed && game.time >= this.nextSpawnAt) {
      this.spawnOne(game);
      this.nextSpawnAt = game.time + this.cfg.respawnInterval;
    }
  }

  onDestroyed(_game: GameState): void {
    // Safe to call twice: just stops future respawns. Already-sortied allies stay in
    // game.allies and keep fighting under their own AI, independent of this instance.
    this.disabled = true;
  }

  private spawnOne(game: GameState): void {
    // maxAllowed in tick() guards this so a free slot always exists; the -1 fallback is just
    // defensive (never actually hit).
    const found = this.slotFree.findIndex((free) => free);
    const slot = found === -1 ? this.slotFree.length - 1 : found;
    this.slotFree[slot] = false;

    const jx = game.rng.range(-this.cfg.spawnJitter, this.cfg.spawnJitter);
    const jz = game.rng.range(-this.cfg.spawnJitter, this.cfg.spawnJitter);
    const pos = this.socket.muzzlePos.clone();
    pos.x += jx;
    pos.z += jz;

    const base = getAllyDef(this.cfg.allyDefId);
    const def: AllyDef = { ...base, ...this.cfg.overridesFor(base, this.purchased) };

    const wall = game.castle.walls[this.socket.tier - 1];
    const guard = guardPostFor(def, wall, this.socket.tier, this.socket.localX, slot);

    const unit = spawnAlly(game, def, pos, guard, this.socket.tier);
    this.spawned.push({ unit, slot });
  }
}
