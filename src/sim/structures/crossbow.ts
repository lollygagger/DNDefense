import { Vector3 } from 'three';
import type { GameState } from '../GameState';
import type { Enemy, Socket, StructureDef, StructureInstance, UpgradeNode } from '../types';
import { CROSSBOW, structureCanHitAir } from '../../data/structures';
import { isFlyerDef } from '../../data/enemies';

/** Owned by [structures-allies]. The original static defense, now with a third mutually
 *  exclusive upgrade identity (Cannon, alongside Rapid/Ballista — Phase 2 roadmap). Anti-air is
 *  now an explicit, legible decision too: `structureCanHitAir('crossbow')` is `true` in
 *  data/structures.ts (unchanged behavior — the crossbow always aimed in full 3D with no height
 *  gate — but it's now a deliberate flag instead of an accident of the aim math, consulted the
 *  same way a future ground-only structure would be). */

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

export const CROSSBOW_DEF_ID = 'crossbow';

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

export type CrossbowIdentity = 'base' | 'rapid' | 'ballista' | 'cannon';

interface CrossbowStats {
  identity: CrossbowIdentity;
  fireRateMult: number;
  damageMult: number;
  pierce: number;
  rangeBonus: number;
  aoeRadius: number;
  projectileSpeedMult: number;
  projectileRadius: number;
}

/** Branches replace, not stack (rapidN/ballistaN/cannonN supersede their own tier-1 entirely),
 *  and the three roots are mutually exclusive (see crossbowDef's `excludes`) — exactly one of
 *  base/rapid/ballista/cannon applies at any time. */
function resolveCrossbowStats(purchased: string[]): CrossbowStats {
  if (purchased.includes('cannon2') || purchased.includes('cannon1')) {
    const t = purchased.includes('cannon2') ? CROSSBOW.upgrades.cannon2 : CROSSBOW.upgrades.cannon1;
    return {
      identity: 'cannon',
      fireRateMult: t.fireRateMult,
      damageMult: t.damageMult,
      pierce: 0, // aoeRadius does the multi-target work; pierce would be redundant (see ProjectileSystem.impact)
      rangeBonus: 0,
      aoeRadius: t.aoeRadius,
      projectileSpeedMult: t.projectileSpeedMult,
      projectileRadius: t.projectileRadius,
    };
  }
  if (purchased.includes('ballista2') || purchased.includes('ballista1')) {
    const t = purchased.includes('ballista2') ? CROSSBOW.upgrades.ballista2 : CROSSBOW.upgrades.ballista1;
    return {
      identity: 'ballista',
      fireRateMult: 1,
      damageMult: t.damageMult,
      pierce: t.pierce,
      rangeBonus: t.rangeBonus,
      aoeRadius: 0,
      projectileSpeedMult: 1,
      projectileRadius: CROSSBOW.projectileRadius,
    };
  }
  if (purchased.includes('rapid2') || purchased.includes('rapid1')) {
    const t = purchased.includes('rapid2') ? CROSSBOW.upgrades.rapid2 : CROSSBOW.upgrades.rapid1;
    return {
      identity: 'rapid',
      fireRateMult: t.fireRateMult,
      damageMult: 1,
      pierce: 0,
      rangeBonus: 0,
      aoeRadius: 0,
      projectileSpeedMult: 1,
      projectileRadius: CROSSBOW.projectileRadius,
    };
  }
  return {
    identity: 'base',
    fireRateMult: 1,
    damageMult: 1,
    pierce: 0,
    rangeBonus: 0,
    aoeRadius: 0,
    projectileSpeedMult: 1,
    projectileRadius: CROSSBOW.projectileRadius,
  };
}

const PROJECTILE_KIND: Record<CrossbowIdentity, string> = {
  base: 'crossbow',
  rapid: 'crossbow', // rapid fire keeps the plain bolt look; structureView adds a glowing accent instead
  ballista: 'ballista',
  cannon: 'cannonball', // new kind — render/fx.ts falls back to a generic look until it gets a bespoke one
};

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
    const stats = resolveCrossbowStats(this.purchased);
    const range = CROSSBOW.range + stats.rangeBonus;
    const speed = CROSSBOW.projectileSpeed * stats.projectileSpeedMult;
    // Anti-air gate (Phase 2 roadmap): a deliberate flag, not an accident of 3D aim math. True
    // for the crossbow (unchanged behavior) — see STRUCTURE_ANTI_AIR in data/structures.ts.
    const hitsAir = structureCanHitAir(CROSSBOW_DEF_ID);

    let target: Enemy | null = null;
    let bestDist = range;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.pos.z >= wall.z) continue; // not in front of this wall — keeps flyers parked at the keep engageable
      if (!hitsAir && isFlyerDef(e.defId)) continue;
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

    const leadTime = Math.min(bestDist / speed, CROSSBOW.maxLeadTime);
    const aimX = target.pos.x + vx * leadTime;
    const aimZ = target.pos.z + vz * leadTime;
    const aimY = target.pos.y + target.height * 0.5;

    const ddx = aimX - muzzle.x;
    const ddz = aimZ - muzzle.z;
    if (ddx * ddx + ddz * ddz > 1e-6) this.aimYaw = Math.atan2(ddx, ddz);

    if (game.time < this.nextFireAt) return;

    this.nextFireAt = game.time + CROSSBOW.fireInterval / stats.fireRateMult;

    const vel = new Vector3(ddx, aimY - muzzle.y, ddz);
    if (vel.lengthSq() < 1e-6) vel.set(0, 0, -1);
    vel.normalize().multiplyScalar(speed);

    // ttl computed from this shot's own range/speed (see data/structures.ts's doc comment on
    // ttlSafetyFactor) so a Ballista's extended range or a Cannon's slowed bolt each still get
    // enough flight time to reach their own max range, instead of a one-size-fits-all constant.
    const ttl = (range * CROSSBOW.ttlSafetyFactor) / speed;

    game.projectiles.spawn({
      pos: muzzle.clone(),
      vel,
      team: 'defender',
      damage: CROSSBOW.damage * stats.damageMult,
      radius: stats.projectileRadius,
      aoeRadius: stats.aoeRadius,
      pierce: stats.pierce,
      ttl,
      kind: PROJECTILE_KIND[stats.identity],
    });
    this.firedAt = game.time;
  }
}

export const crossbowDef: StructureDef = {
  id: CROSSBOW_DEF_ID,
  name: 'Crossbow',
  desc: 'Auto-fires bolts at the nearest enemy in range, aimed in full 3D — hits flying enemies too. Branch into rapid fire, a long-ranged piercing ballista, or a slow splash-damage cannon.',
  cost: CROSSBOW.cost,
  socketKind: 'embrasure',
  // Three mutually exclusive roots (requires: null + excludes the other two roots). castle.ts's
  // upgradeStructure() branch-exclusivity check is generic over the whole purchased list in both
  // directions, so this needs no changes there — it already scales past two branches. The
  // socket menu's branchColumns() (src/ui/menus.ts) builds one column per root by walking each
  // requires-chain, so it also needs no changes: a third root just becomes a third column.
  upgrades: [
    {
      id: 'rapid1',
      name: 'Rapid Windlass',
      desc: '+60% fire rate.',
      cost: CROSSBOW.upgrades.rapid1.cost,
      requires: null,
      excludes: ['ballista1', 'cannon1'],
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
      desc: '2x damage, +6 range; heavier bolts pierce 1 extra target.',
      cost: CROSSBOW.upgrades.ballista1.cost,
      requires: null,
      excludes: ['rapid1', 'cannon1'],
    },
    {
      id: 'ballista2',
      name: 'Ballista Bolts II',
      desc: '3.5x damage (total), +12 range (total), pierces 2 extra targets.',
      cost: CROSSBOW.upgrades.ballista2.cost,
      requires: 'ballista1',
    },
    {
      id: 'cannon1',
      name: 'Mounted Cannon',
      desc: 'Replaces the bolt with a big, slow cannonball that explodes for splash damage (radius 3) — heavy against clustered enemies, slower to reload and to reach its target.',
      cost: CROSSBOW.upgrades.cannon1.cost,
      requires: null,
      excludes: ['rapid1', 'ballista1'],
    },
    {
      id: 'cannon2',
      name: 'Mounted Cannon II',
      desc: 'Bigger shot, bigger blast (radius 4.5), 5x base damage (total) — still slow-loading, still a lumbering shell in flight.',
      cost: CROSSBOW.upgrades.cannon2.cost,
      requires: 'cannon1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, _game: GameState): StructureInstance {
    return new CrossbowStructure(socket);
  },
};
