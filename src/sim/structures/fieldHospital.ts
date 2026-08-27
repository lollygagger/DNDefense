import type { GameState } from '../GameState';
import type { Socket, StructureDef, StructureInstance, UpgradeNode, Unit } from '../types';
import { guardPostFor, spawnAlly, type AllyDef } from '../allies';
import { getAllyDef } from '../../data/allies';
import { FIELD_HOSPITAL } from '../../data/structures';

/** Owned by [structures-allies]. Field Hospital — spawns both medics (heal player + nearby
 *  allies) and engineers (passively repair their home wall), per the roadmap's "medic + engineer,
 *  one structure". Runs two independent rosters in parallel rather than reusing SpawnerStructure
 *  (which only knows how to manage one ally type) — everything else about each roster (slot
 *  pooling, respawn cadence, upgrade-driven stat/count growth) mirrors it closely on purpose.
 *
 *  DECISION — "active only during combat" (see also the doc comment on stepSupport in
 *  sim/allies.ts): medics/engineers spawn and walk to their post on the same build+combat
 *  schedule every other ally uses, but only ACT (heal or repair) once game.phase === 'combat'.
 *  Spawning is not itself phase-gated, so building a Field Hospital mid-intermission visibly
 *  starts training staff right away instead of looking inert until the horn sounds. */

export const FIELD_HOSPITAL_DEF_ID = 'fieldHospital';

function medicMax(purchased: string[]): number {
  return FIELD_HOSPITAL.maxMedics + (purchased.includes('medic2') ? FIELD_HOSPITAL.upgrades.medic2.bonusMedics : 0);
}
function engineerMax(purchased: string[]): number {
  return FIELD_HOSPITAL.maxEngineers + (purchased.includes('sapper2') ? FIELD_HOSPITAL.upgrades.sapper2.bonusEngineers : 0);
}
function medicOverrides(base: AllyDef, purchased: string[]): Partial<AllyDef> {
  const m2 = purchased.includes('medic2');
  const m1 = purchased.includes('medic1');
  const healMult = m2 ? FIELD_HOSPITAL.upgrades.medic2.healMult : m1 ? FIELD_HOSPITAL.upgrades.medic1.healMult : 1;
  const rangeMult = m1 ? FIELD_HOSPITAL.upgrades.medic1.rangeMult : 1;
  return { healAmount: (base.healAmount ?? 0) * healMult, healRange: (base.healRange ?? 0) * rangeMult };
}
function engineerOverrides(base: AllyDef, purchased: string[]): Partial<AllyDef> {
  const s2 = purchased.includes('sapper2');
  const s1 = purchased.includes('sapper1');
  const repairMult = s2 ? FIELD_HOSPITAL.upgrades.sapper2.repairMult : s1 ? FIELD_HOSPITAL.upgrades.sapper1.repairMult : 1;
  return { repairRate: (base.repairRate ?? 0) * repairMult };
}

/** One half of the dual roster (all the medic or all the engineer bookkeeping). Kept as a
 *  small helper class rather than duplicating the same four fields/three methods twice inline. */
class Roster {
  private spawned: { unit: Unit; slot: number }[] = [];
  private nextSpawnAt = 0;
  private slotFree: boolean[];

  constructor(
    private allyDefId: string,
    private maxPossible: number,
    private maxFor: (purchased: string[]) => number,
    private overridesFor: (base: AllyDef, purchased: string[]) => Partial<AllyDef>,
  ) {
    this.slotFree = new Array(maxPossible).fill(true);
  }

  bootstrap(game: GameState, socket: Socket): void {
    this.spawnOne(game, socket, []);
    this.nextSpawnAt = game.time + FIELD_HOSPITAL.respawnInterval;
  }

  tick(game: GameState, socket: Socket, purchased: string[], disabled: boolean): void {
    if (this.spawned.some((a) => !a.unit.alive)) {
      for (const a of this.spawned) if (!a.unit.alive) this.slotFree[a.slot] = true;
      this.spawned = this.spawned.filter((a) => a.unit.alive);
    }
    if (disabled) return;
    if (this.spawned.length < this.maxFor(purchased) && game.time >= this.nextSpawnAt) {
      this.spawnOne(game, socket, purchased);
      this.nextSpawnAt = game.time + FIELD_HOSPITAL.respawnInterval;
    }
  }

  private spawnOne(game: GameState, socket: Socket, purchased: string[]): void {
    const found = this.slotFree.findIndex((free) => free);
    const slot = found === -1 ? this.slotFree.length - 1 : found;
    this.slotFree[slot] = false;

    const jx = game.rng.range(-FIELD_HOSPITAL.spawnJitter, FIELD_HOSPITAL.spawnJitter);
    const jz = game.rng.range(-FIELD_HOSPITAL.spawnJitter, FIELD_HOSPITAL.spawnJitter);
    const pos = socket.muzzlePos.clone();
    pos.x += jx;
    pos.z += jz;

    const base = getAllyDef(this.allyDefId);
    const def: AllyDef = { ...base, ...this.overridesFor(base, purchased) };
    const wall = game.castle.walls[socket.tier - 1];
    const guard = guardPostFor(def, wall, socket.tier, socket.localX, slot);
    const unit = spawnAlly(game, def, pos, guard, socket.tier);
    this.spawned.push({ unit, slot });
  }
}

class FieldHospitalStructure implements StructureInstance {
  defId = FIELD_HOSPITAL_DEF_ID;
  socketId: string;
  purchased: string[] = [];

  private disabled = false;
  private medics = new Roster(
    'medic',
    FIELD_HOSPITAL.maxMedics + FIELD_HOSPITAL.upgrades.medic2.bonusMedics,
    medicMax,
    medicOverrides,
  );
  private engineers = new Roster(
    'engineer',
    FIELD_HOSPITAL.maxEngineers + FIELD_HOSPITAL.upgrades.sapper2.bonusEngineers,
    engineerMax,
    engineerOverrides,
  );

  constructor(private socket: Socket) {
    this.socketId = socket.id;
  }

  bootstrap(game: GameState): void {
    this.medics.bootstrap(game, this.socket);
    this.engineers.bootstrap(game, this.socket);
  }

  tick(_dt: number, game: GameState): void {
    this.medics.tick(game, this.socket, this.purchased, this.disabled);
    this.engineers.tick(game, this.socket, this.purchased, this.disabled);
  }

  onDestroyed(_game: GameState): void {
    this.disabled = true;
  }
}

export const fieldHospitalDef: StructureDef = {
  id: FIELD_HOSPITAL_DEF_ID,
  name: 'Field Hospital',
  desc: 'Trains a medic (heals you and nearby allies) and an engineer (slowly repairs this wall, for free) — both work only once combat starts.',
  cost: FIELD_HOSPITAL.cost,
  socketKind: 'chamber',
  upgrades: [
    {
      id: 'medic1',
      name: 'Combat Medics',
      desc: '+50% heal amount, +30% heal range.',
      cost: FIELD_HOSPITAL.upgrades.medic1.cost,
      requires: null,
    },
    {
      id: 'medic2',
      name: 'Combat Medics II',
      desc: '+100% heal amount (total), +1 medic.',
      cost: FIELD_HOSPITAL.upgrades.medic2.cost,
      requires: 'medic1',
    },
    {
      id: 'sapper1',
      name: 'Corps of Sappers',
      desc: '+50% wall repair rate.',
      cost: FIELD_HOSPITAL.upgrades.sapper1.cost,
      requires: null,
    },
    {
      id: 'sapper2',
      name: 'Corps of Sappers II',
      desc: '+120% wall repair rate (total), +1 engineer.',
      cost: FIELD_HOSPITAL.upgrades.sapper2.cost,
      requires: 'sapper1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new FieldHospitalStructure(socket);
    instance.bootstrap(game);
    return instance;
  },
};
