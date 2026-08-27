import { GameState } from './sim/GameState';
import { startLoop } from './core/loop';
import { initScene, R } from './render/scene';
import { initWorld } from './render/world';
import { initCastle } from './sim/castle';
import { initCastleView } from './render/castleView';
import { initStructures } from './sim/structures';
import { initAllies } from './sim/allies';
import { initEnemies } from './sim/enemies';
import { initWaves } from './sim/waves';
import { initClasses } from './sim/classes';
import { initPlayer } from './player/controller';
import { initCasting } from './player/casting';
import { initViewmodel } from './render/viewmodel';
import { initEnemyView } from './render/enemyView';
import { initStructureView } from './render/structureView';
import { initAllyView } from './render/allyView';
import { initFx } from './render/fx';
import { initHud } from './ui/hud';
import { initMenus } from './ui/menus';
import { initScreens } from './ui/screens';

/** FROZEN boot order. Sim modules first (castle before its consumers), then player,
 *  then render views, then UI. */

const game = new GameState();

initScene(game);
initWorld(game);

initCastle(game);
initStructures(game);
initAllies(game);
initEnemies(game);
initWaves(game);
game.addSystem({ tick: (dt) => game.projectiles.tick(dt, game) });

initClasses(game);
initPlayer(game);
initCasting(game);

initCastleView(game);
initEnemyView(game);
initStructureView(game);
initAllyView(game);
initViewmodel(game);
initFx(game);

initHud(game);
initMenus(game);
initScreens(game);

startLoop(game, () => R.renderer.render(R.scene, R.camera));

// debugging convenience
Object.assign(window as unknown as Record<string, unknown>, { game, R });
