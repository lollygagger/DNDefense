# DNDefense — Roadmap

Source: the player's roadmap, 2026-08-26. Overall intent: **much more late-game depth** — lots
to build, lots to upgrade, and real gold sinks once the player is rich.

Status key: ✅ done · 🚧 in progress · ⬜ planned

## Foundations

These unblock large parts of the roadmap, so they land before the content that needs them.

- ✅ **Status effects** (`src/sim/status.ts`) — `applyStun` / `isStunned` / `applySlow` /
  `moveMultiplier`, with a `stunUntil` field on `Unit`. Stacking rules live in one place
  (longer stun wins, stronger slow wins). Needed by: Tank, meteor stun, leap stun, arc lightning.
- 🚧 **Flying enemy support** — enemies that ignore walls and pathing entirely. Needed by:
  hot air balloons, dragons. Forces a real answer to "which defenses can hit air?".
- 🚧 **Data-driven ally roster** — today `spawnSwordsman` hardcodes one ally type. Generalising to
  an `AllyDef` (melee / ranged / caster / support behaviours) is what makes five new spawners
  data instead of five new code paths.

## Phase 1 — in progress

- 🚧 Flying enemies: **hot air balloon** (slow, tanky, drifts over walls) and **dragon** (fast,
  strafing, breath attack). Waves updated to introduce them.
- 🚧 Ally roster generalised + new spawners: **archer**, **mage**, **tank**, and a combined
  **medic + engineer** barracks (medic heals player/allies, engineer repairs walls and
  structures; both active only during combat).
- 🚧 **Melee allies advance to the forwardmost intact wall** rather than defending their own
  wall's line — a barracks on the keep should still send its swordsmen to the front.
- 🚧 **Tank class** — bulky, stun-heavy, the crowd-control answer to swarms.
- 🚧 **Late-game ability depth**: higher ranks that change *behaviour*, not just numbers —
  archer's Quickshot goes full auto, the mage's meteor gains a wide stun, the warrior's Leap
  gains AoE damage scaling into an AoE stun.

## Phase 2 — next

- ⬜ **Flamethrower tower** — short range, wide AoE that grows substantially with level.
- ⬜ **Crossbow third path**: keep Rapid, extend **Ballista** (range + damage + pierce), add
  **Cannon** (big slow projectile, heavy splash). Three mutually exclusive identities.
- ⬜ **Arc lightning** tower or upgrade — chains between targets.
- ⬜ **More spawner capacity late-game** — the ability to add sockets/structures as the run goes
  long, so a rich player has somewhere to put the gold.
- ⬜ **Deeper wall upgrades** — walls as an upgrade tree, not just HP to repair.

## Phase 3 — later

- ⬜ **Ladders**: permanent ladders at the back of each wall; front-face ladders that are only
  usable between waves. Needs a climbing movement mode in the controller.
- ⬜ More enemy variety aimed at *new player decisions* (something that punishes clumping,
  something that outranges you, something that forces you off a wall).
- ⬜ Co-op multiplayer (the sim has been kept refactorable for it throughout — see
  ARCHITECTURE.md's sim/render separation rules).

## Design principles for this roadmap

- **Late-game upgrades should change behaviour, not just multiply numbers.** "Goes fully
  automatic", "now stuns", "now chains" are the interesting kind; +10% damage is not.
- **Every new structure and enemy should create a decision.** A new tower that is strictly
  better than the crossbow is a downgrade to the game; a tower that is better *against
  specific things* is content.
- **Air units must have a real counter.** If everything can shoot up, flying is cosmetic; if
  nothing can, it's unfair. Decide deliberately which defenses can hit air, and make it legible.
- Keep it data-driven: new classes, enemies, waves and allies should be data plus a model, not
  new branching logic. See `.claude/agents/` for the authoring guides.
