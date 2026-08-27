import { Vector3 } from 'three';
import type { GameState } from './GameState';
import type { CastleApi, Socket, StructureInstance, Wall, WallTier } from './types';
import { getStructureDef } from './structures';
import {
  BAND_BACK_Z,
  BAND_FRONT_Z,
  bandHitScratch,
  battlementHeightAt,
  bodyHeightAt,
  checkBand,
  isMerlonX,
  MERLON_TOP,
  PARAPET_TOP,
} from './castleBlocking';
import { findLadderAt, type LadderInfo } from './ladders';
import {
  extraSocketSpecFor,
  tickWallEffects,
  wallDamageReductionPct as reductionPctFor,
  wallMerlonBonus as merlonBonusFor,
  WALL_UPGRADE_TREE,
  type ExtraSocketSpec,
} from './wallUpgrades';
import {
  CHAMBER_BUILDING_OFFSET,
  CHAMBER_DOOR_FRONT_OFFSET,
  CHAMBER_XS,
  EMBRASURE_MUZZLE_FRONT_OFFSET,
  EMBRASURE_MUZZLE_HEIGHT_FRAC,
  EMBRASURE_XS,
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
 *  build/repair/structure APIs. The exported init/API signatures are contract — internals are
 *  yours. Projectile-blocking geometry primitives live in sim/castleBlocking.ts and the wall
 *  upgrade tree/effects in sim/wallUpgrades.ts — both split out to keep this file under the
 *  ~400-line guideline (see each file's header for why). */

/** Builds one embrasure socket at wall-relative x, for either the initial 3 or a purchased
 *  extra one (sim/wallUpgrades.ts's West/East Bastion nodes) — identical geometry either way. */
function makeEmbrasureSocket(tier: WallTier, z: number, x: number, index: number): Socket {
  return {
    id: `w${tier}-e${index}`,
    kind: 'embrasure',
    tier,
    localX: x,
    // interaction anchor on the wall top
    worldPos: new Vector3(x, WALL_HEIGHT, z + WALL_THICKNESS / 2),
    // bolts fire from the front face, above mid height
    muzzlePos: new Vector3(x, WALL_HEIGHT * EMBRASURE_MUZZLE_HEIGHT_FRAC, z - EMBRASURE_MUZZLE_FRONT_OFFSET),
    structure: null,
  };
}

/** Builds one chamber socket at wall-relative x, for either the initial 2 or a purchased extra
 *  one (sim/wallUpgrades.ts's West/East Annex nodes) — identical geometry either way. */
function makeChamberSocket(tier: WallTier, z: number, x: number, index: number): Socket {
  return {
    id: `w${tier}-c${index}`,
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
  };
}

function makeSockets(tier: WallTier, z: number): Socket[] {
  const sockets: Socket[] = [];
  EMBRASURE_XS.forEach((x, i) => sockets.push(makeEmbrasureSocket(tier, z, x, i)));
  CHAMBER_XS.forEach((x, i) => sockets.push(makeChamberSocket(tier, z, x, i)));
  return sockets;
}

/** Builds the Socket a purchased expansion node (West/East Bastion/Annex) unlocks. See
 *  sim/wallUpgrades.ts's extraSocketSpecFor for the id -> kind/x/index mapping. */
function makeExtraSocket(tier: WallTier, z: number, spec: ExtraSocketSpec): Socket {
  return spec.kind === 'embrasure'
    ? makeEmbrasureSocket(tier, z, spec.x, spec.index)
    : makeChamberSocket(tier, z, spec.x, spec.index);
}

class Castle implements CastleApi {
  walls: Wall[];

  // Per-wall purchased wall-upgrade ids (sim/wallUpgrades.ts's WALL_UPGRADE_TREE). Wall
  // (sim/types.ts) is FROZEN and has no room for this field, so it lives here instead, keyed on
  // the Wall object itself — the same "adapter code in your own module" shape blocksProjectile
  // already uses to extend CastleApi without touching the frozen contract.
  private wallPurchasedMap = new WeakMap<Wall, string[]>();
  // Per-wall battlement-height function for blocksProjectile, cached so the hot per-tick path
  // never allocates a closure — only rebuilt on construction and after a successful upgradeWall()
  // (a rare, menu-click-driven event, not a tick). Index matches `this.walls` (tier 1..3 -> 0..2).
  private battlementFns: ((x: number) => number)[] = [];

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
    for (const w of this.walls) this.wallPurchasedMap.set(w, []);
    this.rebuildBattlementFns();
  }

  /** Live (not copied) purchased-id list for a wall — internal use only (damageWall,
   *  blocksProjectile's rebuild, upgradeWall). External callers get wallPurchased() instead,
   *  which copies, so nothing outside this class can mutate the source list. */
  private purchasedFor(w: Wall): string[] {
    return this.wallPurchasedMap.get(w) ?? [];
  }

  /** Rebuilds the cached per-wall battlement-height closures from each wall's current Higher
   *  Battlements rank. Only called on construction and right after a successful upgradeWall() —
   *  cheap (at most 3 tiny closures) and keeps blocksProjectile's hot path allocation-free. */
  private rebuildBattlementFns(): void {
    this.battlementFns = this.walls.map((w) => {
      const bonus = merlonBonusFor(this.purchasedFor(w));
      if (bonus === 0) return battlementHeightAt; // common case: reuse the shared fn, no allocation
      return (x: number) => {
        if (Math.abs(x) > WALL_HALF_WIDTH) return 0;
        return isMerlonX(x) ? MERLON_TOP + bonus : PARAPET_TOP; // only merlons grow; the parapet lip doesn't
      };
    });
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

      // Higher Battlements (per-wall) only affects the parapet/merlon band's height function;
      // the plain wall-body band is identical for every wall regardless of upgrades.
      const battlementFn = this.battlementFns[w.tier - 1];
      if (
        checkBand(from.x, from.y, z0, dx, dy, dz, BAND_FRONT_Z, BAND_BACK_Z, battlementFn, bandHitScratch) ||
        checkBand(from.x, from.y, z0, dx, dy, dz, BAND_BACK_Z, WALL_THICKNESS, bodyHeightAt, bandHitScratch)
      ) {
        outHit.set(bandHitScratch.x, bandHitScratch.y, bandHitScratch.z + w.z);
        return true;
      }
    }
    return false;
  }

  /** Ladder query. Not part of the frozen CastleApi (types.ts) — same reasoning as
   *  blocksProjectile/wallMerlonBonus above; player/controller.ts reads it through its own
   *  narrow local interface + cast. Delegates entirely to sim/ladders.ts's findLadderAt, which
   *  is what actually owns the geometry and the front-ladder combat-phase gate — this is just
   *  the wiring that hands it this castle's live wall list and current phase. */
  ladderAt(x: number, y: number, z: number): LadderInfo | null {
    return findLadderAt(this.walls, this.game.phase, x, y, z);
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
    // Reinforced Stone/Masoned Core: flat % resistance, applied uniformly here so every damage
    // source (melee/ranged wallDps, flyer siege bursts) benefits the same way with no changes
    // needed at any call site.
    const reduction = reductionPctFor(this.purchasedFor(w));
    w.hp -= amount * (1 - reduction);
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

  /** Read-only copy of a wall's purchased upgrade ids (sim/wallUpgrades.ts's WALL_UPGRADE_TREE),
   *  for ui/menus.ts to render. Not part of the frozen CastleApi — see this class's doc comments
   *  on blocksProjectile for why; ui/menus.ts reads it through its own narrow local interface. */
  wallPurchased(tier: WallTier): string[] {
    return [...this.purchasedFor(this.walls[tier - 1])];
  }

  /** Current Higher Battlements merlon-height bonus for a wall (0 if not purchased). Not part of
   *  the frozen CastleApi; render/castleView.ts reads it through its own narrow local interface
   *  so its merlon meshes match exactly what blocksProjectile is actually checking against. */
  wallMerlonBonus(tier: WallTier): number {
    return merlonBonusFor(this.purchasedFor(this.walls[tier - 1]));
  }

  /** Purchase one node of a wall's upgrade tree (sim/wallUpgrades.ts's WALL_UPGRADE_TREE) —
   *  the wall-level analogue of upgradeStructure(). Same validation shape (owned/requires/
   *  excludes) plus one extra step: an expansion node (West/East Bastion/Annex) also pushes a
   *  brand-new Socket onto the wall, built from its pre-vetted geometry (extraSocketSpecFor) —
   *  the id is permanently unique/stable (continues that kind's existing index sequence) so it
   *  can never collide with, or invalidate, an already-installed structure's socketId. Not part
   *  of the frozen CastleApi; ui/menus.ts reads it through its own narrow local interface. */
  upgradeWall(tier: WallTier, nodeId: string): boolean {
    const w = this.walls[tier - 1];
    if (!w.built || w.hp <= 0) return false;
    const node = WALL_UPGRADE_TREE.find((n) => n.id === nodeId);
    if (!node) return false;
    const purchased = this.purchasedFor(w);
    if (purchased.includes(nodeId)) return false;
    if (node.requires && !purchased.includes(node.requires)) return false;
    for (const ownedId of purchased) {
      const owned = WALL_UPGRADE_TREE.find((n) => n.id === ownedId);
      if (owned?.excludes?.includes(nodeId)) return false;
      if (node.excludes?.includes(ownedId)) return false;
    }
    if (!this.game.trySpend(node.cost)) return false;
    purchased.push(nodeId);
    const spec = extraSocketSpecFor(nodeId);
    if (spec) w.sockets.push(makeExtraSocket(w.tier, w.z, spec));
    this.rebuildBattlementFns(); // cheap; only Higher Battlements nodes actually change the result
    return true;
  }

  /** Drives the two GameState-mutating fortification effects (auto-repair, machicolations) —
   *  see sim/wallUpgrades.ts's tickWallEffects. Called every tick from initCastle's system. */
  tickUpgradeEffects(dt: number, game: GameState): void {
    tickWallEffects(dt, game, this.walls, (w) => this.purchasedFor(w));
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
  game.addSystem({
    tick(dt) {
      castle.tickUpgradeEffects(dt, game);
    },
  });
}
