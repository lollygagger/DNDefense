# DNDefense

First-person D&D castle wave-defense game. Three.js + TypeScript + Vite.

## Commands

- `npm run dev` — dev server at http://localhost:5173
- `npm run check` — typecheck (must pass before finishing any task)
- `npm run build` — production build

## Read these first

- [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md) — locked design decisions, balance numbers, wave tables. **Source of truth for gameplay.** Update it when design changes.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, file ownership, frozen contracts, conventions, multiplayer-readiness rules.

## Content-authoring agents

For new game content, use the project's specialist subagents in `.claude/agents/` rather than writing a prompt from scratch — each one already encodes the file layout, balance numbers, and invariants:

- **class-builder** — new playable classes (PlayerClassDef, abilities, ranks, viewmodel, registry)
- **enemy-builder** — new enemy types (EnemyDef, AI behavior, low-poly model)
- **wave-builder** — new waves and endless-scaling changes

## Hard rules

- Files marked FROZEN in ARCHITECTURE.md are shared contracts — never edit them without updating ARCHITECTURE.md and checking every consumer.
- No `Math.random()` in sim code (use `game.rng`); sim never touches scene/DOM (multiplayer readiness).
- All balance numbers live in `src/data/` — keep GAME_DESIGN.md's tables in sync when tuning.
- Keep the game playable: `npm run check` clean, app boots without console errors.
