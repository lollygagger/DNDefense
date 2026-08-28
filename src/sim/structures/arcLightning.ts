import { Vector3 } from 'three';
import type { GameState } from '../GameState';
import type { Enemy, Socket, StructureDef, StructureInstance, UpgradeNode } from '../types';
import { ARC_LIGHTNING, structureCanHitAir } from '../../data/structures';
import { isFlyerDef } from '../../data/enemies';

/** Owned by [structures-allies]. Arc Lightning Tower — Phase 2 roadmap's "chains between
 *  targets," built as its own embrasure structure rather than a fourth crossbow branch (see the
 *  design writeup on ARC_LIGHTNING in data/structures.ts for why a new tower creates a cleaner
 *  three-way embrasure decision than diluting the crossbow's newly-three-way one). Mid-range,
 *  rewards enemies standing near each other by jumping between them with falling-off damage;
 *  weak against one truly isolated target, where it's just a single hit at base damage.
 *
 *  Also the deliberate ranged, magical anti-air pick (STRUCTURE_ANTI_AIR = true in
 *  data/structures.ts): unlike the flamethrower's ground-hugging cone, a lightning arc reaches a
 *  low-flying target exactly as readily as a ground one. */

interface CastleBlocking {
  blocksProjectile(from: Vector3, to: Vector3, outHit: Vector3): boolean;
}

const tmpAim = new Vector3();
const tmpLosHit = new Vector3();

/** Same LOS precedent as the crossbow: only the *first* hit needs a clear line to the muzzle —
 *  an intact lower wall shouldn't let a tier-3 tower zap through it. Later chain jumps are short
 *  hops within the same small cluster the first hit already proved was visible, so they skip
 *  this check rather than re-testing wall geometry on every hop. */
function shotBlocked(game: GameState, muzzle: Vector3, e: Enemy): boolean {
  tmpAim.set(e.pos.x, e.pos.y + e.height * 0.5, e.pos.z);
  return (game.castle as unknown as CastleBlocking).blocksProjectile(muzzle, tmpAim, tmpLosHit);
}

export const ARC_LIGHTNING_DEF_ID = 'arcLightning';

/** Extra fields structureView.ts reads for the turret mesh (aim rotation + a fire-flash pulse,
 *  the same shape as CrossbowInstance). */
export interface ArcLightningInstance extends StructureInstance {
  aimYaw: number;
  targetId: number | null;
  firedAt: number;
}

function resolveArcLightningStats(purchased: string[]): {
  damage: number;
  chainJumps: number;
  chainRadius: number;
  range: number;
} {
  if (purchased.includes('overcharge2')) return ARC_LIGHTNING.upgrades.overcharge2;
  if (purchased.includes('overcharge1')) return ARC_LIGHTNING.upgrades.overcharge1;
  return {
    damage: ARC_LIGHTNING.damage,
    chainJumps: ARC_LIGHTNING.chainJumps,
    chainRadius: ARC_LIGHTNING.chainRadius,
    range: ARC_LIGHTNING.range,
  };
}

class ArcLightningStructure implements ArcLightningInstance {
  defId = ARC_LIGHTNING_DEF_ID;
  socketId: string;
  purchased: string[] = [];

  aimYaw = Math.PI;
  targetId: number | null = null;
  firedAt = -Infinity;

  private nextFireAt = 0;

  constructor(private socket: Socket) {
    this.socketId = socket.id;
  }

  tick(_dt: number, game: GameState): void {
    const wall = game.castle.walls[this.socket.tier - 1];
    const muzzle = this.socket.muzzlePos;
    // Anti-air gate (Phase 2 roadmap) — true for this tower (data/structures.ts): a chain can
    // jump to (and start on) a flying enemy exactly like a grounded one.
    const hitsAir = structureCanHitAir(ARC_LIGHTNING_DEF_ID);
    // Resolved before acquisition, not just before firing: range is now a per-level stat, so it
    // has to gate which enemies this tower will even track.
    const stats = resolveArcLightningStats(this.purchased);

    let first: Enemy | null = null;
    let bestDist = stats.range; // resolved per level — Overcharge extends reach, not just damage
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.pos.z >= wall.z) continue; // in front of this wall only — same gate every embrasure structure uses
      if (!hitsAir && isFlyerDef(e.defId)) continue;
      const dx = e.pos.x - muzzle.x;
      const dz = e.pos.z - muzzle.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= bestDist) continue;
      if (shotBlocked(game, muzzle, e)) continue;
      bestDist = d;
      first = e;
    }

    if (!first) {
      this.targetId = null;
      return;
    }
    this.targetId = first.id;
    const ddx = first.pos.x - muzzle.x;
    const ddz = first.pos.z - muzzle.z;
    if (ddx * ddx + ddz * ddz > 1e-6) this.aimYaw = Math.atan2(ddx, ddz);

    if (game.time < this.nextFireAt) return;
    this.nextFireAt = game.time + ARC_LIGHTNING.fireInterval;
    this.firedAt = game.time;

    // Instant hitscan chain (no travelling Projectile — matches Frost Field/Blink's precedent
    // of writing straight into game.projectiles.impacts for a non-physical effect, per
    // render/fx.ts's file header). Never revisits a target within the same volley.
    const hit = new Set<number>();
    let current = first;
    let dmg = stats.damage;
    for (let jump = 0; ; jump++) {
      current.takeDamage(dmg, game);
      hit.add(current.id);
      game.projectiles.impacts.push({ pos: current.pos.clone(), kind: 'lightning', aoe: false });
      if (jump >= stats.chainJumps) break;
      dmg *= ARC_LIGHTNING.chainFalloff;

      let next: Enemy | null = null;
      let bestJump = stats.chainRadius;
      for (const e of game.enemies) {
        if (!e.alive || hit.has(e.id)) continue;
        if (!hitsAir && isFlyerDef(e.defId)) continue;
        const dx = e.pos.x - current.pos.x;
        const dy = e.pos.y - current.pos.y;
        const dz = e.pos.z - current.pos.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= bestJump) continue;
        bestJump = d;
        next = e;
      }
      if (!next) break;
      current = next;
    }
  }
}

export const arcLightningDef: StructureDef = {
  id: ARC_LIGHTNING_DEF_ID,
  name: 'Arc Lightning Tower',
  desc: `Long-reaching bolt (range ${ARC_LIGHTNING.range}) that chains to nearby enemies — including flying ones — with damage falling off each jump. Rewards enemies standing close together; against one isolated target it's just a single, unremarkable hit.`,
  cost: ARC_LIGHTNING.cost,
  socketKind: 'embrasure',
  upgrades: [
    {
      id: 'overcharge1',
      name: 'Overcharge',
      desc: `${ARC_LIGHTNING.upgrades.overcharge1.damage} damage, range ${ARC_LIGHTNING.upgrades.overcharge1.range}, chains to ${ARC_LIGHTNING.upgrades.overcharge1.chainJumps} more targets, jump radius ${ARC_LIGHTNING.upgrades.overcharge1.chainRadius}.`,
      cost: ARC_LIGHTNING.upgrades.overcharge1.cost,
      requires: null,
    },
    {
      id: 'overcharge2',
      name: 'Overcharge II',
      desc: `${ARC_LIGHTNING.upgrades.overcharge2.damage} damage, range ${ARC_LIGHTNING.upgrades.overcharge2.range} — far enough to reach the archers' firing line — chains to ${ARC_LIGHTNING.upgrades.overcharge2.chainJumps} more targets (total), jump radius ${ARC_LIGHTNING.upgrades.overcharge2.chainRadius}.`,
      cost: ARC_LIGHTNING.upgrades.overcharge2.cost,
      requires: 'overcharge1',
    },
  ] satisfies UpgradeNode[],
  create(socket: Socket, _game: GameState): StructureInstance {
    return new ArcLightningStructure(socket);
  },
};
