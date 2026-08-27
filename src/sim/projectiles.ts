import { Vector3 } from 'three';
import type { GameState } from './GameState';
import type { ProjectileSpec } from './types';

/** Shared projectile simulation — mage bolts, crossbow bolts, enemy arrows all live here so
 *  collision, AoE, and rendering are implemented once. Spawn via game.projectiles.spawn().
 *  Formerly FROZEN; [wall-cover] was authorized to add castle-geometry blocking (battlements
 *  stopping shots) on the condition that spawn()'s signature and ProjectileSpec stay exactly as
 *  they are and blocking is driven entirely through a castle query — see docs/ARCHITECTURE.md. */

/** Narrow view of the castle sim needed here: does battlement geometry block a shot passing
 *  from `from` to `to` this tick? Not part of the frozen CastleApi (types.ts) — the concrete
 *  Castle class in sim/castle.ts implements this; we reach it via a local interface + cast so
 *  types.ts never has to know about it. */
interface CastleBlocking {
  blocksProjectile(from: Vector3, to: Vector3, outHit: Vector3): boolean;
}

export interface Projectile extends ProjectileSpec {
  ttl: number;
  pierce: number;
  gravity: number;
  alive: boolean;
  hitIds: Set<number>;
}

export interface Impact {
  pos: Vector3;
  kind: string;
  aoe: boolean;
  /** True gameplay radius of the effect, when it has one. The FX layer draws AoE indicators
   *  from this so what the player sees is what the sim actually hit — an indicator sourced
   *  from a copy of the balance numbers silently goes stale the first time someone retunes
   *  an ability, and a circle that lies about its radius is worse than no circle, because
   *  players position around it. */
  radius?: number;
  /** How long the effect actually persists (a slow/stagger window), for lingering visuals. */
  duration?: number;
}

const tmp = new Vector3();
const tmpFrom = new Vector3();
const tmpHit = new Vector3();
const tmpMuzzle = new Vector3();

/** Spawn point for a shot fired from a caster's eye: `offset` units ahead along `dir`, but
 *  never on the far side of castle geometry that should have stopped it.
 *
 *  A bare forward offset is a cover exploit. The parapet/merlon band is only MERLON_DEPTH
 *  (0.7) deep, so an offset larger than that lets a player standing on a wall's front lip
 *  place their projectile past a merlon that ought to have blocked the shot — and the
 *  per-tick sweep never sees it, because the projectile's whole life begins beyond the wall.
 *  Cover that works everywhere except point-blank is worse than no cover: it's unpredictable.
 *  Aim-blocked shots start at the impact point instead, so they detonate against the stone. */
export function muzzlePoint(
  game: GameState,
  origin: Vector3,
  dir: Vector3,
  offset: number
): Vector3 {
  const out = origin.clone().addScaledVector(dir, offset);
  const castle = game.castle as unknown as CastleBlocking;
  if (castle.blocksProjectile(origin, out, tmpMuzzle)) out.copy(tmpMuzzle);
  return out;
}

export class ProjectileSystem {
  list: Projectile[] = [];
  /** Impacts since last render frame — consumed (and cleared) by the FX layer. */
  impacts: Impact[] = [];

  spawn(spec: ProjectileSpec): Projectile {
    const p: Projectile = {
      ...spec,
      pos: spec.pos.clone(),
      vel: spec.vel.clone(),
      ttl: spec.ttl ?? 4,
      pierce: spec.pierce ?? 0,
      gravity: spec.gravity ?? 0,
      alive: true,
      hitIds: new Set(),
    };
    this.list.push(p);
    return p;
  }

  tick(dt: number, game: GameState): void {
    for (const p of this.list) {
      if (!p.alive) continue;
      p.ttl -= dt;
      if (p.ttl <= 0) {
        p.alive = false;
        continue;
      }
      if (p.gravity) p.vel.y -= p.gravity * dt;
      tmpFrom.copy(p.pos);
      p.pos.addScaledVector(p.vel, dt);

      // Castle geometry: an intact wall's body, parapet, or merlon absorbs the shot. Checked
      // as a swept segment (tmpFrom -> p.pos) so a fast bolt can't tunnel through the thin
      // parapet/merlon band in one tick. Crenel gaps and shots that clear the top pass through.
      const castle = game.castle as unknown as CastleBlocking;
      if (castle.blocksProjectile(tmpFrom, p.pos, tmpHit)) {
        p.pos.copy(tmpHit);
        this.impact(p, game);
        continue;
      }

      // Ground impact
      const groundY = game.castle ? game.castle.worldHeight(p.pos.x, p.pos.z) : 0;
      if (p.pos.y <= groundY) {
        p.pos.y = groundY;
        this.impact(p, game);
        continue;
      }

      // Unit collision (opposing team only)
      const targets = game.unitsOfTeam(p.team === 'attacker' ? 'defender' : 'attacker');
      for (const u of targets) {
        if (p.hitIds.has(u.id)) continue;
        const dx = p.pos.x - u.pos.x;
        const dz = p.pos.z - u.pos.z;
        const rr = p.radius + u.radius;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (p.pos.y < u.pos.y - 0.2 || p.pos.y > u.pos.y + u.height + 0.2) continue;

        if (p.aoeRadius && p.aoeRadius > 0) {
          this.impact(p, game);
          break;
        }
        u.takeDamage(p.damage, game);
        p.hitIds.add(u.id);
        if (p.pierce > 0) {
          p.pierce -= 1;
        } else {
          this.impacts.push({ pos: p.pos.clone(), kind: p.kind, aoe: false });
          p.onImpact?.(game, p.pos);
          p.alive = false;
          break;
        }
      }
    }
    if (this.list.length > 64 && this.list.some((p) => !p.alive)) {
      this.list = this.list.filter((p) => p.alive);
    }
  }

  private impact(p: Projectile, game: GameState): void {
    p.alive = false;
    if (p.aoeRadius && p.aoeRadius > 0) {
      const targets = game.unitsOfTeam(p.team === 'attacker' ? 'defender' : 'attacker');
      for (const u of targets) {
        tmp.copy(u.pos).sub(p.pos);
        tmp.y = 0;
        if (tmp.length() <= p.aoeRadius + u.radius) u.takeDamage(p.damage, game);
      }
    }
    this.impacts.push({
      pos: p.pos.clone(),
      kind: p.kind,
      aoe: !!p.aoeRadius,
      radius: p.aoeRadius, // the radius this blast actually damaged
    });
    p.onImpact?.(game, p.pos);
  }
}
