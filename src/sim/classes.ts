import { Vector3 } from 'three';
import { allocId, type AbilityDef, type PlayerClassDef, type PlayerState } from './types';
import type { GameState } from './GameState';
import { PLAYER_SPAWN } from '../data/castle';

/** Owned by [player-classes]. Generic class framework: any PlayerClassDef plugs in here.
 *  Exported signatures are contract (UI uses them for the upgrade menu). */

/** Generic, additive damage-mitigation buff — not tied to any one class mechanically, even
 *  though the Tank's Bulwark (src/data/tank.ts) is its only caller today. Stored off to the
 *  side via a WeakMap keyed by the PlayerState object itself, rather than as a field on
 *  PlayerState (frozen in sim/types.ts): costs nothing once the buff expires or the player
 *  object goes away, and needs no changes to the shared contract. Stacking mirrors
 *  sim/status.ts's applySlow: the stronger (lower) factor always wins, and either a stronger
 *  reapplication or a longer duration extends the window — a weak reapplication never
 *  downgrades an existing stronger mitigation. */
const damageReduction = new WeakMap<PlayerState, { factor: number; until: number }>();

export function applyDamageReduction(
  player: PlayerState,
  game: GameState,
  factor: number, // fraction of incoming damage that still gets through (0.4 = take 40%)
  seconds: number
): void {
  const until = game.time + seconds;
  const cur = damageReduction.get(player);
  const curFactor = cur && game.time < cur.until ? cur.factor : 1;
  if (factor <= curFactor) {
    damageReduction.set(player, { factor, until: Math.max(until, cur?.until ?? 0) });
  } else if (until > (cur?.until ?? 0)) {
    damageReduction.set(player, { factor: curFactor, until });
  }
}

function damageMultiplier(player: PlayerState, game: GameState): number {
  const dr = damageReduction.get(player);
  return dr && game.time < dr.until ? dr.factor : 1;
}

export function createPlayer(classDef: PlayerClassDef): PlayerState {
  const player: PlayerState = {
    id: allocId(),
    team: 'defender',
    pos: new Vector3(PLAYER_SPAWN.x, PLAYER_SPAWN.y, PLAYER_SPAWN.z),
    radius: 0.5,
    height: 1.7,
    hp: classDef.maxHp,
    maxHp: classDef.maxHp,
    alive: true,
    classDef,
    abilityRanks: {},
    cooldowns: {},
    respawnAt: null,
    // Three.js cameras look down -Z at yaw 0, and the field is at -Z, so 0 faces the horde.
    yaw: 0,
    pitch: 0,
    takeDamage(amount: number, game: GameState) {
      if (!this.alive) return;
      this.hp -= amount * damageMultiplier(this, game);
      game.events.emit('player:damaged', { hp: this.hp, maxHp: this.maxHp });
      if (this.hp <= 0) {
        this.hp = 0;
        this.alive = false;
        this.respawnAt = game.time + 5;
        game.events.emit('player:died', {});
      }
    },
  };
  for (const a of allAbilities(classDef)) player.abilityRanks[a.id] = 0;
  return player;
}

export function allAbilities(classDef: PlayerClassDef): AbilityDef[] {
  return [classDef.primary, ...classDef.abilities];
}

export function getAbilityDef(classDef: PlayerClassDef, abilityId: string): AbilityDef | null {
  return allAbilities(classDef).find((a) => a.id === abilityId) ?? null;
}

/** Merged stats for the player's current rank of an ability (rank stats override lower ranks). */
export function getAbilityStats(player: PlayerState, abilityId: string): Record<string, number> {
  const def = getAbilityDef(player.classDef, abilityId);
  if (!def) return {};
  const rank = player.abilityRanks[abilityId] ?? 0;
  const stats: Record<string, number> = {};
  for (let i = 0; i <= rank && i < def.ranks.length; i++) {
    Object.assign(stats, def.ranks[i].stats);
  }
  return stats;
}

export function nextRankCost(player: PlayerState, abilityId: string): number | null {
  const def = getAbilityDef(player.classDef, abilityId);
  if (!def) return null;
  const next = def.ranks[(player.abilityRanks[abilityId] ?? 0) + 1];
  return next ? next.cost : null; // null = maxed
}

export function buyAbilityRank(game: GameState, player: PlayerState, abilityId: string): boolean {
  const cost = nextRankCost(player, abilityId);
  if (cost === null || !game.trySpend(cost)) return false;
  player.abilityRanks[abilityId] = (player.abilityRanks[abilityId] ?? 0) + 1;
  return true;
}

/** Cast an ability if off cooldown. origin = caster eye position, aimPoint = target point.
 *  `chargeFraction` (0..1) is optional and only meaningful for abilities with a `charge`
 *  descriptor (see types.ts) — casting.ts computes it from held draw time and passes it through
 *  here rather than cast() reaching back into input state, so cast() stays sim-only. Merged into
 *  the stats bag as `stats.charge` (generic key, not archer-specific) so any ability's cast() can
 *  read `stats.charge ?? 1` to scale damage/speed by draw strength. */
export function tryCast(
  game: GameState,
  player: PlayerState,
  abilityId: string,
  origin: Vector3,
  aimPoint: Vector3,
  chargeFraction?: number
): boolean {
  if (!player.alive) return false;
  const def = getAbilityDef(player.classDef, abilityId);
  if (!def) return false;
  if ((player.cooldowns[abilityId] ?? 0) > game.time) return false;
  player.cooldowns[abilityId] = game.time + def.cooldown;
  const stats = getAbilityStats(player, abilityId);
  if (chargeFraction !== undefined) stats.charge = chargeFraction;
  def.cast(game, player, origin, aimPoint, stats);
  game.events.emit('ability:cast', { id: abilityId });
  return true;
}

export function initClasses(game: GameState): void {
  // Player respawn + out-of-combat regen
  game.addSystem({
    tick(dt) {
      if (game.phase === 'menu' || game.phase === 'gameover') return;
      for (const p of game.players) {
        if (!p.alive && p.respawnAt !== null && game.time >= p.respawnAt) {
          p.alive = true;
          p.hp = p.maxHp;
          p.respawnAt = null;
          p.pos.set(PLAYER_SPAWN.x, PLAYER_SPAWN.y, PLAYER_SPAWN.z);
          game.events.emit('player:respawned', {});
        }
        if (p.alive && p.hp < p.maxHp && game.phase === 'build') {
          p.hp = Math.min(p.maxHp, p.hp + 5 * dt);
        }
      }
    },
  });
}
