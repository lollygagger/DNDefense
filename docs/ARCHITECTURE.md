# DNDefense — Technical Architecture

*Source of truth for code structure. Read GAME_DESIGN.md first.*

## Stack

- **TypeScript (strict) + Vite + Three.js**, browser game. `npm run dev` → http://localhost:5173
- No physics engine. Player/enemy movement uses a `worldHeight(x, z)` height query from the castle module; combat uses simple radius checks.
- UI is an HTML/CSS overlay (`#ui` div), not in-engine.

## Sim / render separation (multiplayer readiness)

The game must remain refactorable to server-authoritative co-op. Rules:

1. **All gameplay state lives in `GameState`** (`src/sim/`) and is mutated only inside the fixed-rate `tick()` (60 Hz accumulator loop in `src/core/loop.ts`). Render code reads sim state, never writes it.
2. **No `Math.random()` in sim code** — use `game.rng` (seeded mulberry32). Render-only cosmetics may use `Math.random()`.
3. **Player input becomes commands** (move vector, cast ability at point, build structure X in socket Y). Commands are the only way input touches the sim. A future server replays the same commands.
4. `GameState.players` is an **array** — one entry today, N in co-op later. The local controller drives `players[0]`.
5. Cross-module communication goes through the typed `EventBus` (`src/core/events.ts`) or `GameState` — never through render objects.

Pragmatism: sim code may use `three`'s `Vector3` as a math type, but must never touch the scene, meshes, DOM, or materials.

## Module map & ownership

Files marked **FROZEN** are the shared contracts — do not modify them; if a contract is missing something, add adapter code in your own module and flag it for the integrator.

```
index.html                  FROZEN   canvas + #ui root
src/main.ts                 FROZEN   boot order, module wiring (one addition: initPlayground, last)
src/core/loop.ts            FROZEN   fixed-tick accumulator (60 Hz), render on rAF (+ pause gate, see below)
src/core/events.ts          FROZEN   typed EventBus + event map
src/core/rng.ts             FROZEN   seeded RNG
src/sim/types.ts            FROZEN   shared interfaces (Unit, Wall, Socket, defs...)
src/sim/GameState.ts        FROZEN   state container, gold/trySpend, addSystem
src/sim/projectiles.ts      [world-castle] (was FROZEN) shared projectile sim (all shooters use this)
src/render/scene.ts         FROZEN   renderer/scene/camera creation, resize
src/render/fx.ts            FROZEN   shared particle bursts + ground decal rings

src/sim/castle.ts           [world-castle]      walls, HP, sockets, worldHeight, build/repair API,
                                                 blocksProjectile (battlement collision, see below)
src/render/world.ts         [world-castle]      terrain, sky, lighting, environment props
src/render/castleView.ts    [world-castle]      wall/socket meshes + socket-state markers, damage states, rubble

src/sim/enemies.ts          [enemies-waves]     enemy defs registry, AI, combat
src/sim/waves.ts            [enemies-waves]     wave scheduler, endless scaling
src/data/enemies.ts         [enemies-waves]     enemy balance data
src/data/waves.ts           [enemies-waves]     wave 1-10 definitions
src/render/enemyView.ts     [enemies-waves]     instanced enemy meshes, health bars
src/sim/damageEvents.ts     [enemies-waves]     sim->render damage-event queue (DoT bucketing)
src/render/floatingText.ts  [ability-fx]        pooled floating combat-text sprites
src/sim/runSnapshot.ts      [ui]                capture/restore a run's progression (pure, no browser APIs)
src/ui/saveStorage.ts       [ui]                localStorage persistence + autosave timing
src/ui/pause.ts             [ui]                pause overlay (pointer-lock-loss driven)

src/player/controller.ts    [player-classes]    pointer lock, WASD, worldHeight collision
src/player/casting.ts       [player-classes]    aim raycast, ground-target reticle, cast commands
src/sim/classes.ts          [player-classes]    generic class framework (defs, cooldowns, ranks)
src/data/mage.ts            [player-classes]    mage class definition + ability effects
src/render/viewmodel.ts     [player-classes]    first-person staff, cast VFX hooks

src/sim/structures.ts       [structures-allies] structure framework + crossbow + armory logic
src/sim/allies.ts           [structures-allies] swordsman AI
src/data/structures.ts      [structures-allies] structure/upgrade balance data
src/render/structureView.ts [structures-allies] crossbow/armory meshes
src/render/allyView.ts      [structures-allies] ally meshes + health bars

src/ui/hud.ts               [ui]                HP/gold/wave/ability bar, crosshair, toasts
src/ui/menus.ts             [ui]                socket build menu, wall repair, Tab class upgrades
src/ui/screens.ts           [ui]                start screen (class select), game over
src/ui/style.css            [ui]                all UI styling
src/ui/playground.ts        [ui]                sandbox/testing mode (opt-in, see below)
```

Every module exposes `init<Name>(game: Game): void` and registers systems via `game.addSystem({ tick?, render? })`. `main.ts` calls the inits in dependency order. Stub implementations exist for every module so the app always compiles; agents replace stub internals but keep the exported signatures.

## Key contracts (defined in src/sim/types.ts)

- `Unit` — anything alive: enemies, allies, players. `hp/maxHp/team/pos/radius/alive/takeDamage()`.
- `Wall` — `tier (1|2|3), z, built, hp/maxHp, sockets[]`. Castle exposes `outermostIntactWall()`, `worldHeight(x,z)`, `buildWall(tier)`, `repairWall(tier)`, `buildStructure(socketId, defId)`, `getSocketAt(worldPos, maxDist)`.
- `StructureDef` / `StructureInstance` — data-driven defs with an upgrade tree (`UpgradeNode[]`, branch-capable); instances get `tick(dt)`.
- `PlayerClassDef` / `AbilityDef` — `targeting: 'aimed' | 'ground'`, cooldown, ranks with per-rank stats + gold costs, `cast(game, casterPos, aimPoint, rank)`.
- `EnemyDef` — stats + `behavior: 'melee' | 'ranged' | 'boss'`.
- `WaveDef` — `entries: { type, count, interval, delay }[]`; `getWave(n)` returns designed waves 1–10, generated beyond.
- Projectiles: `game.projectiles.spawn({ pos, vel, team, damage, radius, aoeRadius?, pierce?, ttl, kind })` — used by mage bolts, crossbows, skeleton archers. `kind` is a string the render layer maps to a look. Every projectile's per-tick step is also checked against intact-wall battlement geometry (see "Battlements are real cover" below) before ground/unit collision.

## Battlements are real cover (projectile blocking)

Merlons and the parapet are no longer purely cosmetic: `sim/castle.ts` exposes a
`blocksProjectile(from, to, outHit): boolean` method on the `Castle` class that
`sim/projectiles.ts` consults every tick, for every in-flight projectile, before the existing
ground/unit checks. This is **not** part of the frozen `CastleApi` in `sim/types.ts` — adding it
there would force every other `CastleApi` consumer to know about battlement geometry. Instead
`sim/projectiles.ts` declares a narrow local interface (`CastleBlocking`) with just that one
method and reads `game.castle` through it via a cast, exactly like the task's guidance for
extending a frozen-adjacent contract without touching the frozen file.

`sim/projectiles.ts` was marked FROZEN; it is now owned by [world-castle] with two hard
constraints preserved: `ProjectileSystem.spawn()`'s signature and the `ProjectileSpec` shape are
byte-for-byte unchanged, and all castle-awareness is delegated to the castle query above —
`projectiles.ts` itself contains no wall/merlon-specific numbers.

**Geometry model.** Per wall, two z-bands (wall-relative, front face = 0):
- `[-0.2, MERLON_DEPTH-0.2]` (i.e. `[-0.2, 0.5]`) — the parapet/merlon band. Height is
  `PARAPET_TOP` (6.4) everywhere, or `MERLON_TOP` (8.2) where x falls inside a merlon.
- `[0.5, WALL_THICKNESS]` (i.e. `[0.5, 6]`) — body-only band, flat `WALL_HEIGHT` (6).

`blocksProjectile` does a swept check of the tick's straight-line step against both bands (not
just the endpoint), so a fast bolt can't tunnel through the thin 0.7-unit parapet band in one
tick. It's O(walls × 2) per projectile per tick, allocates nothing (one module-scope scratch
`Vector3`, plain function references instead of closures).

**Merlon/crenel arithmetic.** Constants (`src/data/castle.ts`): `MERLON_WIDTH = 1.6`,
`MERLON_SPACING = 4` (center-to-center), so crenel gap width = `4 - 1.6 = 2.4`. Merlon top =
`WALL_HEIGHT + PARAPET_HEIGHT + MERLON_HEIGHT = 6 + 0.4 + 1.8 = 8.2`, comfortably above the
player's standing eye height on a wall top (`WALL_HEIGHT + EYE_HEIGHT = 6 + 1.6 = 7.6`).

`render/castleView.ts` lays out merlon centers symmetrically about x=0, forced to an **even**
count (`rawMerlonCount = floor(2*(W-1)/spacing)+1 = floor(38/4)+1 = 10`, already even for these
constants). For an even, symmetric layout, the midpoint between the two centermost merlons is
provably exactly x=0 (general proof: with `startX = -((n-1)*S)/2` and the two center merlons at
indices `n/2-1` and `n/2`, their midpoint is `startX + (n/2 - 0.5)*S = 0` for any even `n`). Since
gaps repeat every `MERLON_SPACING` from that x=0 gap, every gap center is an exact multiple of 4:
`..., -8, -4, 0, 4, 8, 12, 16, ...` — which includes both x=0 and x=±12 (the embrasure socket
positions) automatically, with no special-casing needed. `sim/castle.ts`'s `isMerlonX(x)` reuses
this fact in closed form (`Math.round(x/MERLON_SPACING)*MERLON_SPACING` finds the nearest gap
center; x is a merlon if it's more than half the gap width away from that) instead of walking an
array of merlon instances, so the blocking query stays O(1) per band per wall.

If `MERLON_SPACING` or the socket x-positions (`EMBRASURE_XS` in `data/castle.ts`) ever change,
re-verify that every embrasure x is still a multiple of `MERLON_SPACING`, and that the render
merlon count stays even — both files enforce evenness independently but neither can detect a
spacing choice that breaks the "12 divides evenly" alignment.

## Event map (core/events.ts)

`enemy:spawned`, `enemy:killed {def, pos, gold}`, `wall:damaged {tier}`, `wall:destroyed {tier}`, `wall:built {tier}`, `structure:built {socket}`, `structure:destroyed {socket}`, `wave:started {n}`, `wave:cleared {n}`, `phase:changed {phase}`, `player:damaged`, `player:died`, `player:respawned`, `gold:changed {gold, delta}`, `ability:cast {id}`, `game:over {waves, kills, gold}`, `ui:toast {text}`.

## Conventions

- **All balance numbers live in `src/data/`** — no magic gameplay numbers inline.
- Art is procedural low-poly: Three.js primitives, flat-shaded `MeshLambertMaterial`/`MeshStandardMaterial`, strong silhouette + color coding (goblins green, orcs red-brown, skeletons bone-white, allies blue, mage purple). Use `InstancedMesh` for anything that appears in numbers (enemies, allies, projectiles).
- Game phases: `menu → build ⇄ combat → gameover`. Phase changes only via `GameState.setPhase()`.
- Keep files under ~400 lines; split rather than grow.
- `npm run check` (tsc --noEmit) must pass before you finish any task.


## Playground mode (`src/ui/playground.ts`)

An opt-in sandbox for testing, enabled from a checkbox on the start screen or by adding
`?playground` to the URL. It keeps gold topped up, lets the wave counter be set directly
(so late waves can be reached without playing 25 rounds), buys out a class's whole kit
including mastery trees in one click, and offers god mode plus a clear-the-field button.

Two notes for anyone editing it:
- The `?playground` flag is parsed at **module load**, not inside `initPlayground()`. `main.ts`'s
  boot order runs `initScreens()` first, and the start screen reads the flag to pre-tick its
  checkbox — parsing at import time is what keeps the URL and the checkbox in agreement.
- It is the one addition to the FROZEN `main.ts` boot order, appended last so it can never
  affect the initialization of anything else. It registers a normal system like every other
  module and touches no sim internals beyond public `GameState` APIs.

It deliberately looks like a dev tool (cool cyan against the game's warm gold, a persistent
corner badge) because it invalidates the economy and difficulty everything else is tuned around.

## Pause + run persistence (`core/loop.ts`, `sim/runSnapshot.ts`, `ui/saveStorage.ts`, `ui/pause.ts`)

**The one change to a FROZEN file.** `core/loop.ts` gained a module-local pause flag plus
`setLoopPaused()` / `isLoopPaused()`; `startLoop`'s signature and every existing behaviour are
untouched, and `main.ts` (its only consumer) needed no edit. The gate has to live there because the
sim's entire notion of "now" is `game.time`, which only that loop advances, and every deadline in
the game is an absolute comparison against it — cooldowns, `respawnAt`, the wave scheduler's spawn
times, DoT bucket flushes. A pause that stopped calling `tick()` but let time run would silently
burn all of them. Freezing the accumulator is the single place that covers every one at once
without each system having to learn about pausing. Render systems keep running while paused (with
`dt` clamped to 0) so the frozen world stays drawn under the translucent overlay.

*Multiplayer caveat:* this is a strictly local convenience and is the one place that knowingly
breaks the "any client can be replaced by a server" framing. A server-authoritative build must not
gate the shared simulation on one client's pause — the split there is that the server owns the
accumulator and a paused client merely stops rendering and sending input. Flagged in the file.

**The sim/platform split is deliberate.** `sim/runSnapshot.ts` is pure: it captures a run to a
plain JSON-able object and replays one back, and touches no browser API, so it stays inside the
"sim never touches the platform" rule and a future server could reuse it verbatim. `ui/saveStorage.ts`
owns everything environmental — the localStorage key, schema-version and shape validation, autosave
debouncing, and the wording on the resume card.

**Restore is a replay, not an assignment.** Rather than writing fields back onto the castle and
player, `restoreRun()` re-issues the saved purchases through the same public APIs the menus call
(`buildWall`/`upgradeWall`/`buildStructure`/`upgradeStructure`/`buyAbilityRank`/`buyAbilityTreeNode`)
with gold temporarily raised so none can fail on cost. Everything derived therefore rebuilds itself
and cannot drift from a hand-built run: expansion sockets are created by the wall node that grants
them, structures get real runtime instances, `wall:built`/`structure:built` fire so the render views
build their meshes, and battlement collision fns get rebuilt. `purchased` arrays are push-ordered,
so replaying in array order always satisfies each node's `requires` chain. Restore assumes a fresh
`GameState` — every route back to the title screen reloads the page first.

**Snapshots hold progression only**, never live combat state; see GAME_DESIGN.md's "Pausing and
saving" for why, and for why saves are written only during the build phase.

Both modules are wired from `initScreens()` rather than `main.ts`, whose boot order stays frozen —
`ui/screens.ts` already owns the title screen the resume card lives on, and it runs after every sim
and render system exists, which is exactly what a restore replay needs.
