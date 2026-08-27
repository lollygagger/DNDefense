import type { Vector3 } from 'three';
import type { Phase } from '../sim/types';

/** Typed cross-module event map. Add new events here (and note them in docs/ARCHITECTURE.md). */
export interface EventMap {
  'enemy:spawned': { defId: string };
  'enemy:killed': { defId: string; pos: Vector3; gold: number };
  'wall:damaged': { tier: number };
  'wall:destroyed': { tier: number };
  'wall:built': { tier: number };
  'structure:built': { socketId: string; defId: string };
  'structure:destroyed': { socketId: string; defId: string };
  'wave:started': { n: number };
  'wave:cleared': { n: number };
  'phase:changed': { phase: Phase };
  'player:damaged': { hp: number; maxHp: number };
  'player:died': Record<string, never>;
  'player:respawned': Record<string, never>;
  'gold:changed': { gold: number; delta: number };
  'ability:cast': { id: string };
  'game:over': { waves: number; kills: number; goldEarned: number };
  'ui:toast': { text: string };
}

type Handler<K extends keyof EventMap> = (e: EventMap[K]) => void;

export class EventBus {
  private handlers = new Map<keyof EventMap, Set<Handler<never>>>();

  on<K extends keyof EventMap>(type: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof EventMap>(type: K, e: EventMap[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as Handler<K>)(e);
  }
}
