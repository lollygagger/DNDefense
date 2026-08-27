# DNDefense — Game Design Document

*Working title: DNDefense. First-person D&D-flavored castle wave defense.*
*This is the source of truth for game design. Update it when decisions change.*

## Locked design decisions (from the player, 2026-08-26)

| Decision | Choice |
|---|---|
| Perspective | First person, on castle walls |
| Combat style | **Hybrid**: aimed primary attack (crosshair projectile) + ground-targeted AoE abilities (aim a decal circle on the ground, confirm to cast) |
| Wall mechanics | Walls have HP. Enemies batter them down, breach, and advance to the next tier. **Lose when the innermost keep wall falls.** |
| Building | **Slot-based**: 3 fixed wall tiers; each wall has fixed sockets that structures install into |
| Run structure | **Endless**: waves 1–10 are hand-designed, wave 11+ procedurally scale forever. Score = waves survived |
| Engine | Browser: Three.js + TypeScript + Vite (runs on Windows & Mac, multiplayer-friendly, wrappable as desktop app later) |
| First class | Mage (class system must be generic/data-driven for future classes) |
| First structures | Crossbow (static, upgrade branches: faster vs bigger bolts) and Swordsman Armory (spawns melee allies) |

## Core loop

1. **Intermission (build phase)** — spend gold: build wall tiers, install/upgrade structures in sockets, upgrade your class abilities, repair walls. Press **G** ("sound the horn") when ready.
2. **Combat phase** — enemies march from the north field toward the castle. Fight from the wall tops with aimed spells and AoE, supported by your structures and allies.
3. Kills grant **gold**. Wave cleared → bonus gold → back to intermission.
4. Repeat forever; runs end when the keep wall is destroyed. Game-over screen shows waves survived, kills, gold earned.

## The castle (spatial layout)

World axes: **X** = lateral (along walls), **Z** = depth (enemies approach from -Z toward +Z), **Y** = up.

- Enemy spawn gate at **z = -80**. Open field from z = -80 to z = 0.
- **Tier 1 wall (outermost)** at z = 0 — purchasable (100g)
- **Tier 2 wall (middle)** at z = 15 — purchasable (100g)
- **Tier 3 wall (keep)** at z = 30 — free, always exists. **If it falls, game over.**
- Walls span x = -20..+20, are ~6 units tall and ~6 thick, with walkable tops and stairs at both ends (x ≈ ±18). Tier spacing (15) minus thickness (6) leaves 9-deep courtyards between tiers.
- **Battlements are real cover, not decoration.** Wall tops carry a solid parapet plus merlons that top out above player eye level, with ~2.4-wide crenel gaps between them. Duck behind a merlon and incoming arrows and bolts are absorbed by the stone; step into a gap to shoot back and you're exposed. Gaps are centered on x = 0 and x = ±12 so the embrasure firing positions are never walled off. Projectiles collide with wall geometry, so this applies to *your* shots too — firing while squarely behind a merlon hits the merlon.
- Player can move freely on courtyards, wall tops, and out into the open field — around a wall's flanks or off its front edge — so melee classes can actually close to melee range; an invisible far-field boundary (z ≈ -50, well short of the spawn gate at z = -80) just stops players from camping the gate itself.
- Destroyed purchasable walls become passable rubble and can be rebuilt in intermission. Structures on a destroyed wall are destroyed with it (no refund).
- Repairs cost gold proportional to damage (0.3g per HP).

### Wall sockets (per wall, 5 total)

- **3 embrasure sockets** on the front face at x = -12, 0, +12 — for **static defenses** (crossbow, future: ballista, flamethrower, oil cauldron...)
- **2 chamber sockets** at x = -6, +6 — for **spawner structures** (swordsman armory, future: archer armory, cleric chapel...). The building itself sits **in the courtyard behind its wall**, not on top of it, so it never eats walkable wall space; an archway through the wall is the door its allies sortie out through. Spawned allies still emerge at the front base of the owning wall. Because the building is at ground level, you step down off the wall to build or upgrade one.

Player installs/upgrades by looking at a socket within ~6m and pressing **E** (contextual menu).

## Player & classes

Generic, data-driven class framework. A class = `PlayerClassDef`: max HP, move speed, a **primary** (aimed, cheap, short cooldown) + **abilities** (hotkeys, cooldowns), each with 3 upgrade ranks bought with gold (Tab menu). Player death ≠ game over: respawn at the keep after 5s. Out-of-combat HP regen.

**Mobility abilities.** Every class gets one signature ability tagged `role: 'mobility'` on its `AbilityDef` — a class-flavored way to reposition, especially to get up onto a wall tier without walking the stair ramps at x = ±18. Three different physical shapes share the slot: **Mage** — Blink instantly teleports (`cast()` sets the caster's position directly, clamped to the same forward-barrier/playfield bounds the WASD controller enforces, snapped to ground height at the landing point); **Warrior** — Leap is a real ballistic jump launched via the controller's `launchPlayer()` (a persistent launch velocity that rides out gravity/ground-collision exactly like walking/falling do, so it can't land outside the playfield or clip through a wall it doesn't have the height to clear), and slams down for AoE damage the instant it actually lands; **Archer** — Grapple Hook reels the caster toward a confirmed anchor over time via the controller's `pullPlayer()` (overrides movement + gravity, clamped to the playfield, bounded by a safety timeout). Nothing about the mobility slot is mage-specific — a future class gets one purely by adding an `AbilityDef` with `role: 'mobility'` to its `abilities` list, picking whichever of the three physical shapes (instant teleport / launch / pull) fits.

### Mage (first class)

- 100 HP, speed 6. Staff viewmodel. Master of arcane artillery, all abilities ground-targeted AoE except its aimed bolt primary.
- **Primary — Arcane Bolt** (LMB, 0.4s cd, aimed projectile, speed 40): 20 → 30 → 45 → 65 dmg (ranks cost 40/80/140g)
- **Fireball** (key 2, 6s cd, ground-target AoE): 60 dmg r4 → 90 r5 → 130 r6 → 180 r6.5 (40/80/140g)
- **Frost Field** (key 3, 10s cd, ground-target AoE): slow field r5 → r6.5, 40%/4s → 50%/5s → 60%/6s → 65%/7s (40/80/140g)
- **Blink** (key 4, 12s cd, ground-target mobility): short-range teleport to the targeted point, snapped to ground/wall-top height there — the fast way up onto a wall. Range 22 → 24 → 26 → 28 (40/80/140g). No damage. Never lands past the forward barrier or off the playfield edges.
- Ground targeting: press ability key → decal circle projects where the crosshair meets the ground → LMB confirms, RMB/Esc cancels.

### Warrior

- 150 HP, speed 6. Sword viewmodel (steel blade, gold crossguard/pommel). Frontline brawler: sustained melee pressure and survivability, not artillery — every ability is short-ranged and centered on the caster.
- **Primary — Cleave** (LMB, 0.35s cd, aimed melee cone, range 4 → 4.4 → 4.8 → 5.2, 100° arc): hits *every* enemy in the arc, 16 → 24 → 34 → 46 dmg each (40/80/140g). Not a projectile — scans `game.enemies` in a cone from the caster like Frost Field scans a ground circle, and calls `takeDamage()` directly.
- **Ground Slam** (key 2, 7s cd, ground-target AoE, 6-unit cast range): damage + brief stagger. 45 → 65 → 95 → 130 dmg, radius 3 → 4, staggers for 35%/1.2s → 45%/1.6s slow (40/80/140g). A melee-range hybrid of Fireball's damage and Frost Field's control, compressed into a shockwave at your feet.
- **Second Wind** (key 3, 20s cd, instant self-heal, no targeting reticle): heals 40 → 60 → 85 → 120 HP (40/80/140g). Survivability tool — dig in and keep swinging instead of retreating.
- **Leap** (key 4, 5s cd, instant directional mobility — no reticle, no confirm): launches you up and forward along your current facing the instant you press the key. Horizontal launch speed 4.5 → 7.5, vertical launch speed a constant 18 (apex ≈ 11.6 units, comfortably clears the 6-unit wall — see src/data/warrior.ts for the arc math), giving horizontal ranges of roughly 11.6 → 19.3. Slams down for 20 → 55 AoE damage (radius 2.5 → 3) the instant you actually touch ground (40/80/140g). Punchier and far faster-cooldown than Blink, and — unlike Blink — doubles as an attack.

### Archer

- 80 HP, speed 6.5. Bow viewmodel (recurve limb + string). Ranged skirmisher built around sustained single-target DPS and precise aim, not area denial — no ground-targeted AoE nuke anywhere in the kit.
- **Primary — Quickshot** (LMB hold-to-draw, 0.3s cd starting on release, aimed projectile, base speed 55): hold to draw over 0.7s, release to loose. Damage and arrow speed both scale with a charge fraction floored at 35% (an instant snap-release still fires a weak, fast plink, never a literal 0) up to 100% at a full draw, of 12 → 18 → 25 → 34 dmg (40/80/140g). Drawing slows you to 55% move speed. Faster, flatter, and cheaper per hit than the mage's bolt.
- **Piercing Shot** (key 2, 4.5s cd, aimed projectile, speed 55): a heavy arrow that punches through multiple enemies in a line. 55 → 80 → 115 → 155 dmg, pierces 1 → 2 → 2 → 3 enemies (40/80/140g). The ranged-DPS answer to Fireball that stays true to "aim, don't area-deny."
- **Pinning Shot** (key 3, 8s cd, aimed hitscan, 45-unit range): snares the single enemy on your crosshair. 8 → 12 → 16 → 20 dmg, 55% → 65% → 75% → 85% slow for 3 → 4.5s (40/80/140g). A precision single-target control tool — the opposite of Frost Field's area slow.
- **Grapple Hook** (key 4, 10s cd, ground-target mobility, range 26 → 38): aim the reticle at a wall top or the ground and confirm — needs a real walkable anchor in range or it whiffs (toast, no cooldown spent) — then reels the Archer toward it at 30 units/s over time (not a teleport), arriving on top of the anchor; a safety timeout guarantees the pull always resolves. Longer range, shorter cooldown than Blink (40/80/140g). No damage.

## Structures

### Crossbow (static defense, embrasure socket) — 60g
Auto-fires bolts at the nearest enemy in a 30-unit range, front arc. Base: 15 dmg every 1.2s.
Branching upgrade — pick one path at first upgrade:
- **Rapid path**: I (50g) +60% fire rate → II (90g) +120% fire rate
- **Ballista path**: I (50g) 2× dmg, bigger bolt, pierces 1 → II (90g) 3.5× dmg, pierces 2

### Swordsman Armory (spawner, chamber socket) — 80g
Maintains up to 3 swordsman allies (60 HP, 12 dmg swings, speed 4.8); one respawns every 8s. Allies sortie out and hold a **battle line 6 units in front of their wall**, fanned out around the armory's socket so a squad presents a front instead of stacking on one point. They engage the nearest enemy within 24 units of that line — a 30-unit envelope measured from the wall, matching the wall's own crossbow range — then reform on the line rather than retreating to the wall face between fights.
- **Veterans I** (70g): +1 max swordsman, +25% ally HP
- **Veterans II** (120g): +50% ally dmg, +25% more HP

## Enemies (v1 roster)

| Enemy | HP | Speed | Behavior | Gold |
|---|---|---|---|---|
| Goblin Grunt | 30 | 4.5 | Fast melee swarm. 8 dmg vs units, 5 DPS vs walls. Prefers nearby allies over walls. | 6 |
| Orc Bruiser | 140 | 2.2 | Slow tank, wall-breaker. 20 dmg melee, 20 DPS vs walls. | 15 |
| Skeleton Archer | 45 | 3.2 | Stops at 22 range, shoots exposed units/structures/player (7 dmg / 2.2s), else plinks walls. Arrows are stopped by merlons — using cover meaningfully cuts incoming damage. | 10 |
| Orc Warlord (wave 10 boss) | 1200 | 1.8 | Huge. 40 dmg melee, 60 DPS vs walls. | 200 |

Melee enemies attack the nearest point of the **outermost intact wall**, spreading along its width; when it falls they pour through toward the next tier.

## Waves

Start gold: 150. Wave-clear bonus: 25 + 5×wave.

| Wave | Composition (count × type, spawn interval) |
|---|---|
| 1 | 6 goblins (2.5s) — tutorial pace |
| 2 | 10 goblins (2s) |
| 3 | 10 goblins (1.8s) + 2 orcs (after 15s, 8s apart) |
| 4 | 14 goblins (1.5s) + 4 orcs |
| 5 | 10 goblins + 4 skeleton archers (intro) + 3 orcs |
| 6 | 18 goblins (1.2s) + 6 archers |
| 7 | 8 orcs (4s) + 10 goblins — tank wave |
| 8 | 20 goblins + 6 orcs + 8 archers |
| 9 | 28 goblins (0.9s) + 10 archers + 4 orcs — swarm |
| 10 | **Orc Warlord** + 16 goblins + 6 orcs + 8 archers |
| 11+ | Endless scaling: counts ×(1 + 0.15·(n−10)), HP ×(1 + 0.12·(n−10)), speed +1%/wave (cap +30%), gold ×(1 + 0.05·(n−10)); composition rotates through mixes |

## Controls

| Input | Action |
|---|---|
| Mouse look (pointer lock) | Aim |
| WASD / Space | Move / jump |
| LMB | Primary attack / confirm ground-target cast (Archer: hold to draw the bow, release to loose — see Archer primary) |
| 2, 3, 4 | Use class abilities — ground-targeted ones (including Grapple Hook) arm a decal reticle first and confirm with LMB, aimed ones cast instantly (varies by class, see Player & classes). Grapple Hook's confirm additionally needs a real walkable anchor in range, or it whiffs. Warrior's Leap is the one exception: it's directional, not targeted — pressing its key launches you along your current facing immediately, no reticle at all |
| RMB / Esc | Cancel ability targeting |
| E | Socket menu (build/upgrade structure in the socket you're near) |
| B | Castle menu (build/repair wall tiers) |
| Tab | Class upgrade menu |
| G | Start next wave (intermission) |

## Future (out of scope for v1, design toward it)

- More classes (Cleric...), more structures/enemies, boss variety
- **Multiplayer**: co-op party defense. The simulation is built for it now — see ARCHITECTURE.md (deterministic fixed tick, command-based input, seeded RNG, multi-player state list).
- Desktop packaging (Tauri/Electron), audio, save/meta-progression
