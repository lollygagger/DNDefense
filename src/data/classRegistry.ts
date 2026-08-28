import type { PlayerClassDef } from '../sim/types';
import { MAGE } from './mage';
import { WARRIOR } from './warrior';
import { ARCHER } from './archer';
import { TANK } from './tank';
import { WARLOCK } from './warlock';

/** Owned by [player-classes]. The single list of playable classes — split out of mage.ts once
 *  a second class existed, so a file named "mage.ts" doesn't own the registry for every class.
 *  `src/ui/screens.ts` builds the class-select cards from this; `src/player/controller.ts`
 *  still imports MAGE directly from `./mage` as its no-selection fallback, so that export
 *  stays put. Add future classes here. */
export const CLASS_REGISTRY: PlayerClassDef[] = [MAGE, WARRIOR, ARCHER, TANK, WARLOCK];
