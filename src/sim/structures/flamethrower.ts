import { Vector3 } from 'three';
import type { GameState } from '../GameState';
import type { Enemy, Socket, StructureDef, StructureInstance, UpgradeNode } from '../types';
import { FLAMETHROWER, structureCanHitAir } from '../../data/structures';
import { isFlyerDef } from '../../data/enemies';

/** Owned by [structures-allies]. Flamethrower — Phase 2 roadmap's "short range but big aoe that
 *  increases with level," and the deliberate opposite trade from the crossbow: a very short,
 *  wide cone of continuous fire instead of one precise long-range bolt. Devastating against a
 *  swarm packed against the wall face; useless at any real distance (a skeleton archer standing
 *  off at range 22 never enters even the max-level 14-range cone) and can't touch anything
 *  airborne at all (see STRUCTURE_ANTI_AIR in data/structures.ts).
 *
 *  DAMAGE MODEL — true damage-over-time, not a projectile-spam loop. Every tick it applies
 *  `dps * dt` directly to every enemy currently inside its cone via `takeDamage`, the same
 *  "apply straight to the unit" shape sim/flyers.ts's attack() uses for the balloon/dragon's
 *  area attacks — never a spawned Projectile per target. Total damage dealt over any span of
 *  time is exactly `dps * elapsedSeconds` regardless of the sim's tick rate: nothing here scales
 *  with how often tick() happens to run. */

interface CastleBlocking {
  blocksProjectile(from: Vector3, to: Vector3, outHit: Vector3): boolean;
}

const tmpAim = new Vector3();
const tmpLosHit = new Vector3();

/** Same LOS precedent as the crossbow's shotBlocked: an intervening intact wall (or its own
 *  merlon) stops the flame jet exactly like it stops a bolt, so a tier-2/3 flamethrower can't
 *  cook enemies massed against an intact lower wall through solid stone. */
function shotBlocked(game: GameState, muzzle: Vector3, e: Enemy): boolean {
  tmpAim.set(e.pos.x, e.pos.y + e.height * 0.5, e.pos.z);
  return (game.castle as unknown as CastleBlocking).blocksProjectile(muzzle, tmpAim, tmpLosHit);
}

export const FLAMETHROWER_DEF_ID = 'flamethrower';

/** Extra fields structureView.ts reads for the turret mesh/flame-jet visual. */
export interface FlamethrowerInstance extends StructureInstance {
  /** Fixed facing (atan2(dx,dz) convention, 0 = +Z) — this is a stationary emplacement that
   *  bathes its whole cone in fire at once rather than tracking one target, so it always faces
   *  straight out from its wall (Math.PI, matching the crossbow's idle convention). */
  aimYaw: number;
  /** True on any tick it actually connected with at least one enemy — drives the "is it
   *  burning" visual instead of a flame jet that looks permanently on regardless of range. */
  active: boolean;
  /** Current level's reach/arc, resolved from purchased upgrades, so structureView can size the
   *  flame-cone visual to match what actually deals damage instead of a fixed prop. */
  currentRange: number;
  currentHalfArcDeg: number;
}

function resolveFlamethrowerStats(purchased: string[]): { range: number; halfArcDeg: number; dps: number } {
  if (purchased.includes('inferno2')) return FLAMETHROWER.upgrades.inferno2;
  if (purchased.includes('inferno1')) return FLAMETHROWER.upgrades.inferno1;
  return { range: FLAMETHROWER.range, halfArcDeg: FLAMETHROWER.halfArcDeg, dps: FLAMETHROWER.dps };
}

class FlamethrowerStructure implements FlamethrowerInstance {
  defId = FLAMETHROWER_DEF_ID;
  socketId: string;
  purchased: string[] = [];

  aimYaw = Math.PI; // permanently faces the field — a fixed nozzle, nothing to track
  active = false;
  currentRange = FLAMETHROWER.range;
  currentHalfArcDeg = FLAMETHROWER.halfArcDeg;

  private nextFxAt = 0;

  constructor(private socket: Socket) {
    this.socketId = socket.id;
  }

  tick(dt: number, game: GameState): void {
    const wall = game.castle.walls[this.socket.tier - 1];
    const muzzle = this.socket.muzzlePos;
    const stats = resolveFlamethrowerStats(this.purchased);
    this.currentRange = stats.range;
    this.currentHalfArcDeg = stats.halfArcDeg;
    // Anti-air gate (Phase 2 roadmap) — always false today (STRUCTURE_ANTI_AIR in
    // data/structures.ts): a ground-hugging cone of flame can't reach cruise altitude, so this
    // is a deliberate non-answer to balloons/dragons rather than an accident of range math.
    const hitsAir = structureCanHitAir(FLAMETHROWER_DEF_ID);
    const cosHalfArc = Math.cos((stats.halfArcDeg * Math.PI) / 180);

    let hitAny = false;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.pos.z >= wall.z) continue; // only the field side of this wall
      if (!hitsAir && isFlyerDef(e.defId)) continue;
      const dx = e.pos.x - muzzle.x;
      const dz = e.pos.z - muzzle.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > stats.range * stats.range) continue;
      if (distSq > 1e-6) {
        // Cone test: cos(angle) between (dx,dz) and the fixed outward normal (0,-1 in x,z).
        const facing = -dz / Math.sqrt(distSq);
        if (facing < cosHalfArc) continue;
      }
      if (shotBlocked(game, muzzle, e)) continue;
      e.takeDamage(stats.dps * dt, game);
      hitAny = true;
    }
    this.active = hitAny;

    if (hitAny && game.time >= this.nextFxAt) {
      this.nextFxAt = game.time + FLAMETHROWER.fxPulseInterval;
      // A throttled, honest snapshot of the live cone (real radius/duration, per the AoE-
      // indicator rule) rather than a discrete "blast" the way a projectile's aoeRadius is —
      // this is continuous, so the indicator just pulses at the current range while it's
      // actually connecting, instead of flooding the FX layer with one impact per 60Hz tick.
      game.projectiles.impacts.push({
        pos: new Vector3(muzzle.x, muzzle.y, muzzle.z - stats.range * 0.5),
        kind: 'flame',
        aoe: true,
        radius: stats.range * 0.5,
        duration: FLAMETHROWER.fxPulseInterval,
      });
    }
  }
}

export const flamethrowerDef: StructureDef = {
  id: FLAMETHROWER_DEF_ID,
  name: 'Flamethrower',
  desc: `Very short range (${FLAMETHROWER.range}) but a wide cone of continuous fire that burns everything caught in it every tick — devastating against a swarm packed against the wall, useless at any real distance. Ground-only: the flame cannot reach flying enemies. Cone reach and width grow substantially with level.`,
  cost: FLAMETHROWER.cost,
  socketKind: 'embrasure',
  upgrades: [
    {
      id: 'inferno1',
      name: 'Inferno Nozzle',
      desc: `Range ${FLAMETHROWER.upgrades.inferno1.range}, cone ${FLAMETHROWER.upgrades.inferno1.halfArcDeg * 2}°, ${FLAMETHROWER.upgrades.inferno1.dps} dps.`,
      cost: FLAMETHROWER.upgrades.inferno1.cost,
      requires: null,
    },
    {
      id: 'inferno2',
      name: 'Inferno Nozzle II',
      desc: `Range ${FLAMETHROWER.upgrades.inferno2.range}, cone ${FLAMETHROWER.upgrades.inferno2.halfArcDeg * 2}°, ${FLAMETHROWER.upgrades.inferno2.dps} dps.`,
      cost: FLAMETHROWER.upgrades.inferno2.cost,
      requires: 'inferno1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, _game: GameState): StructureInstance {
    return new FlamethrowerStructure(socket);
  },
};
