import type { PlayerClassDef } from '../sim/types';

/** Which class the player picked on the start screen.
 *
 *  Deliberately dependency-free: it imports no registry and no concrete class, so both the
 *  UI (which writes the selection) and the player controller (which reads it at spawn) can
 *  depend on it without an import cycle through the class data files.
 *
 *  ui/screens.ts calls setSelectedClass() as the player picks a card; player/controller.ts
 *  reads it in initPlayer() and falls back to a default when nothing was chosen (e.g. the
 *  start screen was skipped). */

let selected: PlayerClassDef | null = null;

export function setSelectedClass(def: PlayerClassDef): void {
  selected = def;
}

export function getSelectedClass(): PlayerClassDef | null {
  return selected;
}
