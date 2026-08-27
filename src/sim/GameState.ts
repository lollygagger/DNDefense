import { EventBus } from '../core/events';
import { createRng, type Rng } from '../core/rng';
import { ProjectileSystem } from './projectiles';
import type { CastleApi, Enemy, Phase, PlayerState, System, Team, Unit } from './types';

/** FROZEN. Central sim state. All gameplay state lives here (or in castle/structures reached
 *  from here) so a future multiplayer server owns one serializable world. */
export class GameState {
  time = 0; // sim seconds elapsed
  phase: Phase = 'menu';
  gold = 150;
  goldEarned = 0;
  kills = 0;
  waveNumber = 0; // last wave started
  waveActive = false; // set by the wave system during combat

  events = new EventBus();
  rng: Rng = createRng(0xdefe75);
  projectiles = new ProjectileSystem();

  enemies: Enemy[] = [];
  allies: Unit[] = []; // structure-spawned defenders (swordsmen etc.)
  players: PlayerState[] = []; // players[0] = local player; array for future co-op

  castle!: CastleApi; // assigned by initCastle before anything ticks

  systems: System[] = [];

  get localPlayer(): PlayerState | null {
    return this.players[0] ?? null;
  }

  addSystem(s: System): void {
    this.systems.push(s);
  }

  setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.events.emit('phase:changed', { phase });
  }

  addGold(amount: number): void {
    this.gold += amount;
    if (amount > 0) this.goldEarned += amount;
    this.events.emit('gold:changed', { gold: this.gold, delta: amount });
  }

  trySpend(cost: number): boolean {
    if (this.gold < cost) return false;
    this.gold -= cost;
    this.events.emit('gold:changed', { gold: this.gold, delta: -cost });
    return true;
  }

  /** Living units on a team (attackers = enemies; defenders = allies + non-dead players). */
  unitsOfTeam(team: Team): Unit[] {
    if (team === 'attacker') return this.enemies.filter((e) => e.alive);
    return [
      ...this.allies.filter((a) => a.alive),
      ...this.players.filter((p) => p.alive),
    ];
  }

  gameOver(): void {
    if (this.phase === 'gameover') return;
    this.setPhase('gameover');
    this.events.emit('game:over', {
      waves: this.waveNumber,
      kills: this.kills,
      goldEarned: this.goldEarned,
    });
  }
}
