import { Vector3 } from 'three';
import type { GameState } from './GameState';
import type { CastleApi, Socket, StructureInstance, Wall, WallTier } from './types';
import { getStructureDef } from './structures';
import {
  CHAMBER_BUILDING_OFFSET,
  CHAMBER_DOOR_FRONT_OFFSET,
  CHAMBER_XS,
  EMBRASURE_MUZZLE_FRONT_OFFSET,
  EMBRASURE_MUZZLE_HEIGHT_FRAC,
  EMBRASURE_XS,
  MERLON_DEPTH,
  MERLON_HEIGHT,
  MERLON_SPACING,
  MERLON_WIDTH,
  PARAPET_HEIGHT,
  REPAIR_COST_PER_HP,
  STAIR_HALF_WIDTH,
  STAIR_LENGTH,
  STAIR_X,
  WALL_COST,
  WALL_HALF_WIDTH,
  WALL_HEIGHT,
  WALL_HP,
  WALL_THICKNESS,
  WALL_Z,
} from '../data/castle';

/** Owned by [world-castle]. Sim model of the castle: walls, HP, sockets, walkable heights,
 *  build/repair/structure APIs. The exported init/API signatures are contract — internals are yours. */

// ---- Projectile-blocking geometry ----------------------------------------------------------
// Mirrors the cosmetic mesh layout in render/castleView.ts exactly (same constants, same local
// z placement) so what the player sees is what actually stops arrows. The parapet/merlon band
// sits in front of the wall body, at wall-relative z in [BAND_FRONT_Z, BAND_BACK_Z] (matches
// castleView's parapet/merlon local z = MERLON_DEPTH / 2 - 0.2, +/- half depth). Behind that
// band, only the plain wall body (relative z in [BAND_BACK_Z, WALL_THICKNESS], height
// WALL_HEIGHT) is solid — the open-air space above the walkable top in the middle of the wall's
// thickness blocks nothing (matches the real geometry: no floating stone back there).
const BAND_FRONT_Z = -0.2;
const BAND_BACK_Z = MERLON_DEPTH - 0.2; // 0.5
const PARAPET_TOP = WALL_HEIGHT + PARAPET_HEIGHT; // 6.4 — continuous, full width, no gaps
const MERLON_TOP = PARAPET_TOP + MERLON_HEIGHT; // 8.2 — only within a merlon's x-footprint
const MERLON_GAP_HALF = (MERLON_SPACING - MERLON_WIDTH) / 2; // 1.2 — half the crenel gap width

/** True if x falls inside a merlon's footprint rather than a crenel gap. Crenel gaps repeat
 *  every MERLON_SPACING, centered on every multiple of it (0, ±MERLON_SPACING, ±2*MERLON_SPACING,
 *  ...) — by construction (render/castleView.ts always builds an even number of merlons,
 *  symmetric about x=0), so with MERLON_SPACING=4 a gap centers exactly on x=0 and x=±12 (the
 *  embrasure sockets). See docs/ARCHITECTURE.md for the full arithmetic. */
function isMerlonX(x: number): boolean {
  const nearestGapCenter = Math.round(x / MERLON_SPACING) * MERLON_SPACING;
  return Math.abs(x - nearestGapCenter) > MERLON_GAP_HALF;
}

function battlementHeightAt(x: number): number {
  if (Math.abs(x) > WALL_HALF_WIDTH) return 0;
  return isMerlonX(x) ? MERLON_TOP : PARAPET_TOP;
}

function bodyHeightAt(x: number): number {
  return Math.abs(x) > WALL_HALF_WIDTH ? 0 : WALL_HEIGHT;
}

// Scratch vector for blocksProjectile's internal band checks. Reused every call (never
// allocated) — safe because it's written then immediately read before any other call can run
// (single-threaded, no re-entrancy).
const bandHitScratch = new Vector3();

/** Swept check within one wall-relative z-band [zLo, zHi]: does the segment
 *  (x0,y0,z0)->(x0+dx,y0+dy,z0+dz) dip at/below `heightAt(x)` anywhere its z lies in that band?
 *  Writes the entry point (wall-relative z) into `out` and returns true if so. `heightAt` is a
 *  plain function reference (not a closure) so this allocates nothing. */
function checkBand(
  x0: number,
  y0: number,
  z0: number,
  dx: number,
  dy: number,
  dz: number,
  zLo: number,
  zHi: number,
  heightAt: (x: number) => number,
  out: Vector3
): boolean {
  let tA: number;
  let tB: number;
  if (dz === 0) {
    if (z0 < zLo || z0 > zHi) return false;
    tA = 0;
    tB = 1;
  } else {
    const t1 = (zLo - z0) / dz;
    const t2 = (zHi - z0) / dz;
    tA = Math.max(0, Math.min(t1, t2));
    tB = Math.min(1, Math.max(t1, t2));
    if (tA > tB) return false;
  }
  const xA = x0 + dx * tA;
  const xB = x0 + dx * tB;
  const yA = y0 + dy * tA;
  const yB = y0 + dy * tB;
  const h = heightAt((xA + xB) / 2);
  if (h <= 0 || Math.min(yA, yB) > h) return false;
  out.set(xA, Math.min(yA, h), z0 + dz * tA);
  return true;
}

function makeSockets(tier: WallTier, z: number): Socket[] {
  const sockets: Socket[] = [];
  EMBRASURE_XS.forEach((x, i) => {
    sockets.push({
      id: `w${tier}-e${i}`,
      kind: 'embrasure',
      tier,
      localX: x,
      // interaction anchor on the wall top
      worldPos: new Vector3(x, WALL_HEIGHT, z + WALL_THICKNESS / 2),
      // bolts fire from the front face, above mid height
      muzzlePos: new Vector3(x, WALL_HEIGHT * EMBRASURE_MUZZLE_HEIGHT_FRAC, z - EMBRASURE_MUZZLE_FRONT_OFFSET),
      structure: null,
    });
  });
  CHAMBER_XS.forEach((x, i) => {
    sockets.push({
      id: `w${tier}-c${i}`,
      kind: 'chamber',
      tier,
      // interaction anchor + barracks building position: on the ground, in the courtyard
      // BEHIND the wall (not on the wall top — that's the whole point of moving it), through
      // a cosmetic archway at the wall's back face. See CHAMBER_BUILDING_OFFSET's comment.
      worldPos: new Vector3(x, 0, z + WALL_THICKNESS + CHAMBER_BUILDING_OFFSET),
      // allies still sortie out at the front base of the wall, through the matching archway on
      // the front face — muzzlePos keeps its exact prior meaning/formula, untouched by the
      // building move, so allies keep emerging in front of the wall to fight.
      muzzlePos: new Vector3(x, 0, z - CHAMBER_DOOR_FRONT_OFFSET),
      localX: x,
      structure: null,
    });
  });
  return sockets;
}

class Castle implements CastleApi {
  walls: Wall[];

  constructor(private game: GameState) {
    this.walls = ([1, 2, 3] as WallTier[]).map((tier) => ({
      tier,
      z: WALL_Z[tier],
      built: tier === 3, // the keep pre-exists; tiers 1-2 are purchased
      hp: tier === 3 ? WALL_HP[3] : 0,
      maxHp: WALL_HP[tier],
      cost: WALL_COST[tier],
      sockets: makeSockets(tier, WALL_Z[tier]),
    }));
  }

  outermostIntactWall(): Wall | null {
    for (const w of this.walls) if (w.built && w.hp > 0) return w;
    return null;
  }

  worldHeight(x: number, z: number): number {
    for (const w of this.walls) {
      if (!w.built || w.hp <= 0) continue;
      // wall top
      if (Math.abs(x) <= WALL_HALF_WIDTH && z >= w.z && z <= w.z + WALL_THICKNESS) {
        return WALL_HEIGHT;
      }
      // stair ramps behind the wall at both ends
      const backZ = w.z + WALL_THICKNESS;
      if (z > backZ && z <= backZ + STAIR_LENGTH) {
        for (const sx of [-STAIR_X, STAIR_X]) {
          if (Math.abs(x - sx) <= STAIR_HALF_WIDTH) {
            const t = (z - backZ) / STAIR_LENGTH;
            return WALL_HEIGHT * (1 - t);
          }
        }
      }
    }
    return 0;
  }

  /** Projectile-blocking query. Not part of the frozen CastleApi contract (types.ts) — read via
   *  a narrow local interface + cast from sim/projectiles.ts, see docs/ARCHITECTURE.md. Given
   *  one tick's straight-line step from `from` to `to`, returns true and writes the crossing
   *  point into `outHit` if an intact wall's body, parapet, or merlon blocks the shot somewhere
   *  along the step. Crenel gaps and anything beyond |x| > WALL_HALF_WIDTH pass freely. Cheap
   *  and allocation-free: safe to call for every in-flight projectile every tick.
   *  Deliberately has NO opening at the chamber sockets' x positions: the archway castleView.ts
   *  renders through the wall there (front + back faces) for the barracks' sally port is cosmetic
   *  only. Bodyheight/battlement height stay flat across the whole wall width — punching a real
   *  hole here would let enemy projectiles (skeleton archers) shoot straight through the wall,
   *  which is a much worse trade than a decorative archway that doesn't quite look load-bearing. */
  blocksProjectile(from: Vector3, to: Vector3, outHit: Vector3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    for (const w of this.walls) {
      if (!w.built || w.hp <= 0) continue;
      const z0 = from.z - w.z;
      const loZ = Math.min(z0, z0 + dz);
      const hiZ = Math.max(z0, z0 + dz);
      if (hiZ < BAND_FRONT_Z || loZ > WALL_THICKNESS) continue; // step never enters this wall

      if (
        checkBand(from.x, from.y, z0, dx, dy, dz, BAND_FRONT_Z, BAND_BACK_Z, battlementHeightAt, bandHitScratch) ||
        checkBand(from.x, from.y, z0, dx, dy, dz, BAND_BACK_Z, WALL_THICKNESS, bodyHeightAt, bandHitScratch)
      ) {
        outHit.set(bandHitScratch.x, bandHitScratch.y, bandHitScratch.z + w.z);
        return true;
      }
    }
    return false;
  }

  canBuildWall(tier: WallTier): boolean {
    const w = this.walls[tier - 1];
    return !w.built && tier !== 3 && this.game.gold >= w.cost;
  }

  buildWall(tier: WallTier): boolean {
    const w = this.walls[tier - 1];
    if (w.built || tier === 3) return false;
    if (!this.game.trySpend(w.cost)) return false;
    w.built = true;
    w.hp = w.maxHp;
    this.game.events.emit('wall:built', { tier });
    return true;
  }

  repairCost(tier: WallTier): number {
    const w = this.walls[tier - 1];
    if (!w.built) return 0;
    return Math.ceil((w.maxHp - w.hp) * REPAIR_COST_PER_HP);
  }

  repairWall(tier: WallTier): boolean {
    const w = this.walls[tier - 1];
    if (!w.built || w.hp >= w.maxHp) return false;
    if (!this.game.trySpend(this.repairCost(tier))) return false;
    w.hp = w.maxHp;
    return true;
  }

  damageWall(tier: WallTier, amount: number, game: GameState): void {
    const w = this.walls[tier - 1];
    if (!w.built || w.hp <= 0) return;
    w.hp -= amount;
    game.events.emit('wall:damaged', { tier });
    if (w.hp > 0) return;

    w.hp = 0;
    // structures die with their wall
    for (const s of w.sockets) {
      if (s.structure) {
        s.structure.onDestroyed?.(game);
        game.events.emit('structure:destroyed', { socketId: s.id, defId: s.structure.defId });
        s.structure = null;
      }
    }
    if (tier === 3) {
      game.events.emit('wall:destroyed', { tier });
      game.gameOver();
    } else {
      w.built = false; // rubble; can be rebuilt in intermission
      game.events.emit('wall:destroyed', { tier });
    }
  }

  buildStructure(socketId: string, defId: string): boolean {
    const socket = this.getSocketById(socketId);
    const def = getStructureDef(defId);
    if (!socket || !def || socket.structure) return false;
    if (socket.kind !== def.socketKind) return false;
    const wall = this.walls[socket.tier - 1];
    if (!wall.built || wall.hp <= 0) return false;
    if (!this.game.trySpend(def.cost)) return false;
    socket.structure = def.create(socket, this.game);
    this.game.events.emit('structure:built', { socketId, defId });
    return true;
  }

  upgradeStructure(socketId: string, nodeId: string): boolean {
    const socket = this.getSocketById(socketId);
    const structure = socket?.structure as StructureInstance | undefined | null;
    if (!socket || !structure) return false;
    const def = getStructureDef(structure.defId);
    const node = def?.upgrades.find((n) => n.id === nodeId);
    if (!def || !node) return false;
    if (structure.purchased.includes(nodeId)) return false;
    if (node.requires && !structure.purchased.includes(node.requires)) return false;
    // branch exclusivity, both directions
    for (const ownedId of structure.purchased) {
      const owned = def.upgrades.find((n) => n.id === ownedId);
      if (owned?.excludes?.includes(nodeId)) return false;
      if (node.excludes?.includes(ownedId)) return false;
    }
    if (!this.game.trySpend(node.cost)) return false;
    structure.purchased.push(nodeId);
    return true;
  }

  getSocketById(id: string): Socket | null {
    for (const w of this.walls) {
      const s = w.sockets.find((s) => s.id === id);
      if (s) return s;
    }
    return null;
  }

  getSocketNear(pos: Vector3, maxDist: number): Socket | null {
    let best: Socket | null = null;
    let bestD = maxDist;
    for (const w of this.walls) {
      if (!w.built) continue;
      for (const s of w.sockets) {
        const d = s.worldPos.distanceTo(pos);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    }
    return best;
  }
}

export function initCastle(game: GameState): void {
  const castle = new Castle(game);
  game.castle = castle;
}
