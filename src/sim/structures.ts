import { Vector3 } from 'three';
import type { GameState } from './GameState';
import type { Enemy, Socket, StructureDef, StructureInstance, UpgradeNode, Unit } from './types';
import { ARMORY, CROSSBOW, SWORDSMAN } from '../data/structures';
import { guardPostFor, spawnSwordsman } from './allies';

/** Owned by [structures-allies]. Structure definition registry + per-tick driver.
 *  registerStructureDef/getStructureDef signatures are contract (castle + UI call them). */

/** Narrow view of the castle sim for line-of-sight checks — the same local-interface trick
 *  sim/projectiles.ts uses so the frozen CastleApi never has to know about battlement geometry. */
interface CastleBlocking {
  blocksProjectile(from: Vector3, to: Vector3, outHit: Vector3): boolean;
}

const tmpAim = new Vector3();
const tmpLosHit = new Vector3();

/** True when castle geometry stands between a muzzle and an enemy. Now that walls stop
 *  projectiles, "in front of my wall and in range" is no longer the same as "shootable": a
 *  tier-2 or tier-3 crossbow will happily lock onto enemies massed against an intact tier-1
 *  wall and feed every bolt into the back of it, silently wasting a structure the player paid
 *  for. Aim at the enemy's mid-height, matching where bolts actually converge. */
function shotBlocked(game: GameState, muzzle: Vector3, e: Enemy): boolean {
  tmpAim.set(e.pos.x, e.pos.y + e.height * 0.5, e.pos.z);
  return (game.castle as unknown as CastleBlocking).blocksProjectile(muzzle, tmpAim, tmpLosHit);
}

const defs = new Map<string, StructureDef>();

export function registerStructureDef(def: StructureDef): void {
  defs.set(def.id, def);
}

export function getStructureDef(id: string): StructureDef | null {
  return defs.get(id) ?? null;
}

export function getStructureDefsForSocket(kind: 'embrasure' | 'chamber'): StructureDef[] {
  return [...defs.values()].filter((d) => d.socketKind === kind);
}

export const CROSSBOW_DEF_ID = 'crossbow';
export const ARMORY_DEF_ID = 'armory';

// ---------- Crossbow ----------

/** Extra fields the crossbow instance exposes beyond the generic StructureInstance contract,
 *  for structureView.ts to read (aiming/recoil visuals). Narrowing cast target:
 *  `socket.structure as CrossbowInstance` after checking `defId === CROSSBOW_DEF_ID`. */
export interface CrossbowInstance extends StructureInstance {
  /** Current facing yaw, radians, atan2(dx,dz) convention (0 = +Z, matches enemyView's models).
   *  Rests at Math.PI (facing the field, -Z) when no target is tracked. */
  aimYaw: number;
  /** id of the enemy currently tracked/aimed at, or null when idle. */
  targetId: number | null;
  /** game.time of the last shot fired. structureView uses `game.time - firedAt` to drive a
   *  brief recoil kick animation. */
  firedAt: number;
}

function resolveCrossbowStats(purchased: string[]): {
  fireRateMult: number;
  damageMult: number;
  pierce: number;
  isBallista: boolean;
} {
  // Branches replace, not stack: rapid2/ballista2 supersede rapid1/ballista1 entirely.
  const fireRateMult = purchased.includes('rapid2')
    ? CROSSBOW.upgrades.rapid2.fireRateMult
    : purchased.includes('rapid1')
      ? CROSSBOW.upgrades.rapid1.fireRateMult
      : 1;
  const isBallista = purchased.includes('ballista1') || purchased.includes('ballista2');
  const damageMult = purchased.includes('ballista2')
    ? CROSSBOW.upgrades.ballista2.damageMult
    : purchased.includes('ballista1')
      ? CROSSBOW.upgrades.ballista1.damageMult
      : 1;
  const pierce = purchased.includes('ballista2')
    ? CROSSBOW.upgrades.ballista2.pierce
    : purchased.includes('ballista1')
      ? CROSSBOW.upgrades.ballista1.pierce
      : 0;
  return { fireRateMult, damageMult, pierce, isBallista };
}

class CrossbowStructure implements CrossbowInstance {
  defId = CROSSBOW_DEF_ID;
  socketId: string;
  purchased: string[] = [];

  aimYaw = Math.PI;
  targetId: number | null = null;
  firedAt = -Infinity;

  private nextFireAt = 0;
  // last-sample tracking for linear lead estimation of the current target
  private trackId: number | null = null;
  private trackX = 0;
  private trackZ = 0;
  private trackT = 0;

  constructor(private socket: Socket) {
    this.socketId = socket.id;
  }

  tick(_dt: number, game: GameState): void {
    const wall = game.castle.walls[this.socket.tier - 1];
    const muzzle = this.socket.muzzlePos;

    let target: Enemy | null = null;
    let bestDist = CROSSBOW.range;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.pos.z >= wall.z) continue; // not in front of this wall
      const dx = e.pos.x - muzzle.x;
      const dz = e.pos.z - muzzle.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= bestDist) continue;
      // Only pay for the line-of-sight test on candidates that would actually win, so this
      // costs a handful of checks per tick rather than one per enemy.
      if (shotBlocked(game, muzzle, e)) continue;
      bestDist = d;
      target = e;
    }

    if (!target) {
      this.targetId = null;
      this.trackId = null;
      return;
    }
    this.targetId = target.id;

    // Linear lead: estimate the target's velocity from its position at the last time we
    // looked at it (reset when the target changes), cap the lead by maxLeadTime.
    let vx = 0;
    let vz = 0;
    if (this.trackId === target.id) {
      const dt2 = game.time - this.trackT;
      if (dt2 > 1e-4) {
        vx = (target.pos.x - this.trackX) / dt2;
        vz = (target.pos.z - this.trackZ) / dt2;
      }
    }
    this.trackId = target.id;
    this.trackX = target.pos.x;
    this.trackZ = target.pos.z;
    this.trackT = game.time;

    const leadTime = Math.min(bestDist / CROSSBOW.projectileSpeed, CROSSBOW.maxLeadTime);
    const aimX = target.pos.x + vx * leadTime;
    const aimZ = target.pos.z + vz * leadTime;
    const aimY = target.pos.y + target.height * 0.5;

    const ddx = aimX - muzzle.x;
    const ddz = aimZ - muzzle.z;
    if (ddx * ddx + ddz * ddz > 1e-6) this.aimYaw = Math.atan2(ddx, ddz);

    if (game.time < this.nextFireAt) return;

    const stats = resolveCrossbowStats(this.purchased);
    this.nextFireAt = game.time + CROSSBOW.fireInterval / stats.fireRateMult;

    const vel = new Vector3(ddx, aimY - muzzle.y, ddz);
    if (vel.lengthSq() < 1e-6) vel.set(0, 0, -1);
    vel.normalize().multiplyScalar(CROSSBOW.projectileSpeed);

    game.projectiles.spawn({
      pos: muzzle.clone(),
      vel,
      team: 'defender',
      damage: CROSSBOW.damage * stats.damageMult,
      radius: CROSSBOW.projectileRadius,
      pierce: stats.pierce,
      ttl: CROSSBOW.projectileTtl,
      kind: stats.isBallista ? 'ballista' : 'crossbow',
    });
    this.firedAt = game.time;
  }
}

const crossbowDef: StructureDef = {
  id: CROSSBOW_DEF_ID,
  name: 'Crossbow',
  desc: 'Auto-fires bolts at the nearest enemy in range. Branch into rapid fire or heavy ballista bolts.',
  cost: CROSSBOW.cost,
  socketKind: 'embrasure',
  upgrades: [
    {
      id: 'rapid1',
      name: 'Rapid Windlass',
      desc: '+60% fire rate.',
      cost: CROSSBOW.upgrades.rapid1.cost,
      requires: null,
      excludes: ['ballista1'],
    },
    {
      id: 'rapid2',
      name: 'Rapid Windlass II',
      desc: '+120% fire rate (total), from a reinforced double-string windlass.',
      cost: CROSSBOW.upgrades.rapid2.cost,
      requires: 'rapid1',
    },
    {
      id: 'ballista1',
      name: 'Ballista Bolts',
      desc: '2x damage; heavier bolts pierce 1 extra target.',
      cost: CROSSBOW.upgrades.ballista1.cost,
      requires: null,
      excludes: ['rapid1'],
    },
    {
      id: 'ballista2',
      name: 'Ballista Bolts II',
      desc: '3.5x damage; pierces 2 extra targets.',
      cost: CROSSBOW.upgrades.ballista2.cost,
      requires: 'ballista1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, _game: GameState): StructureInstance {
    return new CrossbowStructure(socket);
  },
};

// ---------- Swordsman Armory ----------

class ArmoryStructure implements StructureInstance {
  defId = ARMORY_DEF_ID;
  socketId: string;
  purchased: string[] = [];

  private disabled = false;
  private spawned: { unit: Unit; slot: number }[] = [];
  private nextSpawnAt = 0;
  // Fixed-size slot pool for the battle line, sized to the largest squad this armory can ever
  // field (base + Veterans I's +1 max). A freed slot (its swordsman died) is reused rather than
  // slot numbers climbing forever, which would otherwise spread the line wider and wider over a
  // long game (see lineSlotOffset in allies.ts — slot N sits ceil(N/2) spacings from center).
  private slotFree: boolean[] = new Array(ARMORY.maxSwordsmen + ARMORY.upgrades.veterans1.bonusMax).fill(true);

  constructor(private socket: Socket) {
    this.socketId = socket.id;
  }

  /** Called once right after construction (from the def's create()) to sortie the first
   *  swordsman immediately, per design ("one respawns every 8s" starts after the first). */
  bootstrap(game: GameState): void {
    this.spawnOne(game);
    this.nextSpawnAt = game.time + ARMORY.respawnInterval;
  }

  tick(_dt: number, game: GameState): void {
    if (this.spawned.some((a) => !a.unit.alive)) {
      for (const a of this.spawned) if (!a.unit.alive) this.slotFree[a.slot] = true;
      this.spawned = this.spawned.filter((a) => a.unit.alive);
    }
    if (this.disabled) return;

    const maxAllowed =
      ARMORY.maxSwordsmen + (this.purchased.includes('veterans1') ? ARMORY.upgrades.veterans1.bonusMax : 0);
    if (this.spawned.length < maxAllowed && game.time >= this.nextSpawnAt) {
      this.spawnOne(game);
      this.nextSpawnAt = game.time + ARMORY.respawnInterval;
    }
  }

  onDestroyed(_game: GameState): void {
    // Safe to call twice: just stops future respawns. Already-sortied swordsmen stay in
    // game.allies and keep fighting under their own AI (ally.ts), independent of this instance.
    this.disabled = true;
  }

  private spawnOne(game: GameState): void {
    // maxAllowed in tick() guards this so a free slot always exists; the -1 fallback is just
    // defensive (never actually hit).
    const found = this.slotFree.findIndex((free) => free);
    const slot = found === -1 ? this.slotFree.length - 1 : found;
    this.slotFree[slot] = false;

    const jx = game.rng.range(-ARMORY.spawnJitter, ARMORY.spawnJitter);
    const jz = game.rng.range(-ARMORY.spawnJitter, ARMORY.spawnJitter);
    const pos = this.socket.muzzlePos.clone();
    pos.x += jx;
    pos.z += jz;

    const v1 = this.purchased.includes('veterans1');
    const v2 = this.purchased.includes('veterans2');
    const hp =
      SWORDSMAN.hp *
      (v1 ? ARMORY.upgrades.veterans1.hpMult : 1) *
      (v2 ? ARMORY.upgrades.veterans2.hpMult : 1);
    const damage = SWORDSMAN.damage * (v2 ? ARMORY.upgrades.veterans2.damageMult : 1);

    // Guard post = the battle line in front of THIS wall (wall.z is that wall's front face,
    // same for tier 1/2/3 — see guardPostFor's doc comment), fanned laterally around the
    // chamber socket's x so multiple swordsmen from one armory present a front, not a stack.
    const wall = game.castle.walls[this.socket.tier - 1];
    const guard = guardPostFor(wall.z, this.socket.localX, slot);

    const unit = spawnSwordsman(game, pos, { hp, damage }, guard);
    this.spawned.push({ unit, slot });
  }
}

const armoryDef: StructureDef = {
  id: ARMORY_DEF_ID,
  name: 'Swordsman Armory',
  desc: 'Maintains a squad of swordsmen who sortie out to guard the wall front.',
  cost: ARMORY.cost,
  socketKind: 'chamber',
  upgrades: [
    {
      id: 'veterans1',
      name: 'Veterans I',
      desc: `+${ARMORY.upgrades.veterans1.bonusMax} max swordsman, +25% ally HP.`,
      cost: ARMORY.upgrades.veterans1.cost,
      requires: null,
    },
    {
      id: 'veterans2',
      name: 'Veterans II',
      desc: '+50% ally damage, +25% more HP.',
      cost: ARMORY.upgrades.veterans2.cost,
      requires: 'veterans1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, game: GameState): StructureInstance {
    const instance = new ArmoryStructure(socket);
    instance.bootstrap(game);
    return instance;
  },
};

export function initStructures(game: GameState): void {
  registerStructureDef(crossbowDef);
  registerStructureDef(armoryDef);

  game.addSystem({
    tick(dt) {
      if (game.phase === 'menu' || game.phase === 'gameover') return;
      for (const wall of game.castle.walls) {
        if (!wall.built || wall.hp <= 0) continue;
        for (const socket of wall.sockets) socket.structure?.tick(dt, game);
      }
    },
  });
}
