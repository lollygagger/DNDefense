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
- **Ladders** at x = ±8 on every wall (a crenel gap on this game's merlon grid, clear of every socket and the stair ramps) give a much shorter way up than walking to the stairs at the ends. Each wall has one **back** ladder per side (courtyard-facing, on the wall's inner face) that's **always usable**, and one **front** ladder per side (field-facing) that's **build-phase only** — walking into a wall face you can't step up climbs it instead, W/S climb up/down, and stepping off the top always lands you cleanly inside the wall-top walkway, never on the parapet lip. Front ladders exist so a player who has sallied into the field can climb back onto their own wall between waves; they swing up flush against the wall top (visibly stowed, not just hidden) the instant combat starts, so a front ladder is never a free way onto a wall a wave is actively hitting. A player still on a front ladder when that happens is dropped from wherever they are and falls under normal gravity — never teleported to the top or bottom.
- **Battlements are real cover, not decoration.** Wall tops carry a solid parapet plus merlons that top out above player eye level, with ~2.4-wide crenel gaps between them. Duck behind a merlon and incoming arrows and bolts are absorbed by the stone; step into a gap to shoot back and you're exposed. Gaps are centered on x = 0 and x = ±12 so the embrasure firing positions are never walled off. Projectiles collide with wall geometry, so this applies to *your* shots too — firing while squarely behind a merlon hits the merlon.
- Player can move freely on courtyards, wall tops, and out into the open field — around a wall's flanks or off its front edge — so melee classes can actually close to melee range; an invisible far-field boundary (z ≈ -50, well short of the spawn gate at z = -80) just stops players from camping the gate itself.
- Destroyed purchasable walls become passable rubble and can be rebuilt in intermission. Structures on a destroyed wall are destroyed with it (no refund).
- Repairs cost gold proportional to damage (0.3g per HP).

### Wall sockets (5 base, up to 9 per wall with expansion)

- **3 embrasure sockets** on the front face at x = -12, 0, +12 — for **static defenses** (crossbow, future: ballista, flamethrower, oil cauldron...)
- **2 chamber sockets** at x = -6, +6 — for **spawner structures** (swordsman armory, future: archer armory, cleric chapel...). The building itself sits **in the courtyard behind its wall**, not on top of it, so it never eats walkable wall space; an archway through the wall is the door its allies sortie out through. Spawned allies still emerge at the front base of the owning wall. Because the building is at ground level, you step down off the wall to build or upgrade one.

Player installs/upgrades by looking at a socket within ~6m and pressing **E** (contextual menu).

**Expansion sockets (late-game gold sink, Phase 2 roadmap).** Each wall can purchase up to 2 more embrasure sockets (x = ±16 — the next crenel gap out from the base ±12 pair) and 2 more chamber sockets (x = ±9.5, in the ground-level gap between the base chamber and embrasure sockets) through that wall's upgrade tree (**B** menu → wall → Fortify → Expand the Wall). Each side is bought independently (west before east on each kind) at escalating cost (320g/500g for embrasures, 420g/650g for chambers), so a fully expanded wall tops out at 9 sockets — a firm, finite cap, not an infinite turret farm. New sockets get permanently unique ids continuing each kind's existing sequence (embrasure indices 3, 4; chamber indices 2, 3), so they never collide with, or invalidate, an already-installed structure's socket reference.

### Wall upgrades (per-wall tree, B menu)

Repairing HP is the boring lever; each wall (outer/middle/keep, tracked independently) also has its own small upgrade tree, bought from the **B** castle menu's "Fortify" drill-down for that wall, reusing the same upgrade-node UI the socket menu uses for structures:

- **Reinforced Stone** (180g) / **Masoned Core** (320g): flat 20%/35% damage resistance against everything that hits this wall — melee and ranged wallDps alike, plus flyer siege bursts — so it scales against big single hits the way flat extra HP never would.
- **Machicolations** (220g) / **Boiling Oil** (380g): the wall itself pours damage on enemies hugging its base — a blind spot no embrasure structure aims at — for 8/20 dmg/s within ~3.5-4 units of the front face; Boiling Oil adds a 30% scald-slow. Ground-level only (a small height gate keeps flyers immune, matching the "murder holes" theme).
- **Higher Battlements** (200g) / **Towering Battlements** (350g): this wall's merlons grow +1.0/+2.0 taller, deepening cover against ranged attacks and diving flyers — a real geometry change (mirrored exactly in both the render and the projectile-blocking check), not a stat tweak.
- **Standing Repair Crew** (260g): +15 wall HP/s regenerated for free, but only during intermission — distinct from the Field Hospital engineer's combat-phase, gold-free-but-capped repair, and useful even on a wall with nothing built on it.

All four are independently purchasable (no forced either/or) — a maxed-out wall is meant to feel like a genuine bastion once a run has gone long enough to afford one.

## Player & classes

Generic, data-driven class framework. A class = `PlayerClassDef`: max HP, move speed, a **primary** (aimed, cheap, short cooldown) + **abilities** (hotkeys, cooldowns), each with a free base rank plus purchasable ranks bought with gold (Tab menu) — 3 purchasable ranks (0/40/80/140g) is the baseline shape, but several abilities now go further: 1-2 extra late-game ranks (220g, 320g) that change *behaviour*, not just numbers, per the roadmap's late-game-depth goal. Player death ≠ game over: respawn at the keep after 5s. Out-of-combat HP regen.

**Mobility abilities.** Every class gets one signature ability tagged `role: 'mobility'` on its `AbilityDef` — a class-flavored way to reposition, especially to get up onto a wall tier without walking the stair ramps at x = ±18. Three different physical shapes share the slot: **Mage** — Blink instantly teleports (`cast()` sets the caster's position directly, clamped to the same forward-barrier/playfield bounds the WASD controller enforces, snapped to ground height at the landing point); **Warrior** — Leap is a real ballistic jump launched via the controller's `launchPlayer()` (a persistent launch velocity that rides out gravity/ground-collision exactly like walking/falling do, so it can't land outside the playfield or clip through a wall it doesn't have the height to clear), and slams down for AoE damage the instant it actually lands; **Archer** — Grapple Hook reels the caster toward a confirmed anchor over time via the controller's `pullPlayer()` (overrides movement + gravity, clamped to the playfield, bounded by a safety timeout); **Tank** — Shield Charge reuses the same `launchPlayer()` shape as Leap (a flatter arc, tuned as a barge rather than a jump) and also slams for damage + a brief stun on landing. Nothing about the mobility slot is mage-specific — a future class gets one purely by adding an `AbilityDef` with `role: 'mobility'` to its `abilities` list, picking whichever of the three physical shapes (instant teleport / launch / pull) fits.

### Mage (first class)

- 100 HP, speed 6. Staff viewmodel. Master of arcane artillery, all abilities ground-targeted AoE except its aimed bolt primary.
- **Primary — Arcane Bolt** (LMB, 0.4s cd, aimed projectile, speed 40): 20 → 30 → 45 → 65 dmg (40/80/140g). **Rank V — Piercing Bolt** (220g): 80 dmg and now pierces 1 extra enemy instead of stopping on the first hit.
- **Fireball** (key 2, 6s cd, ground-target AoE): 60 dmg r4 → 90 r5 → 130 r6 → 180 r6.5 (40/80/140g). **Rank V — Meteor Mastery** (220g): 210 dmg, damage radius unchanged, but the shockwave now also stuns everything in a much wider 10-unit ring for 1.6s (cooldown stays far above the stun, so a single caster can't approach lockdown).
- **Frost Field** (key 3, 10s cd, ground-target AoE): slow field r5 → r6.5, 40%/4s → 50%/5s → 60%/6s → 65%/7s (40/80/140g). **Rank V — Deep Freeze** (220g): r7.5, 70%/8s slow, plus a brief 1.2s stun on cast.
- **Blink** (key 4, 12s cd, ground-target mobility): short-range teleport to the targeted point, snapped to ground/wall-top height there — the fast way up onto a wall. Range 22 → 24 → 26 → 28 (40/80/140g). No damage. Never lands past the forward barrier or off the playfield edges.
- Ground targeting: press ability key → decal circle projects where the crosshair meets the ground → LMB confirms, RMB/Esc cancels.

### Warrior

- 150 HP, speed 6. Sword viewmodel (steel blade, gold crossguard/pommel). Frontline brawler: sustained melee pressure and survivability, not artillery — every ability is short-ranged and centered on the caster.
- **Primary — Cleave** (LMB, 0.35s cd, aimed melee cone, range 4 → 4.4 → 4.8 → 5.2, 100° arc): hits *every* enemy in the arc, 16 → 24 → 34 → 46 dmg each (40/80/140g). Not a projectile — scans `game.enemies` in a cone from the caster like Frost Field scans a ground circle, and calls `takeDamage()` directly. **Rank V — Whirlwind** (220g): 58 dmg, range 5.5, and the arc opens to a full 360° — hits everything around you, not just what's in front. Still pure damage, no CC, still the fastest cooldown in the game.
- **Ground Slam** (key 2, 7s cd, ground-target AoE, 6-unit cast range): damage + brief stagger. 45 → 65 → 95 → 130 dmg, radius 3 → 4, staggers for 35%/1.2s → 45%/1.6s slow (40/80/140g). A melee-range hybrid of Fireball's damage and Frost Field's control, compressed into a shockwave at your feet.
- **Second Wind** (key 3, 20s cd, instant self-heal, no targeting reticle): heals 40 → 60 → 85 → 120 HP (40/80/140g). Survivability tool — dig in and keep swinging instead of retreating.
- **Leap** (key 4, 5s cd, instant directional mobility — no reticle, no confirm): launches you up and forward along your current facing the instant you press the key. Horizontal launch speed 4.5 → 7.5, vertical launch speed a constant 18 (apex ≈ 11.6 units, comfortably clears the 6-unit wall — see src/data/warrior.ts for the arc math), giving horizontal ranges of roughly 11.6 → 19.3. Slams down for 20 → 55 AoE damage (radius 2.5 → 3) the instant you actually touch ground (40/80/140g). Punchier and far faster-cooldown than Blink, and — unlike Blink — doubles as an attack. **Rank V — Seismic Leap** (220g): speed 8.2, 75 dmg, radius 3.4 — pure scaling. **Rank VI — Earthshaker** (320g): speed 8.8, 95 dmg, radius 4, and the landing slam now stuns for 1.3s (≈26% uptime on a single target at Leap's 5s cooldown — a flinch, not a lock, on a cluster-sized radius).

### Archer

- 80 HP, speed 6.5. Bow viewmodel (recurve limb + string). Ranged skirmisher built around sustained single-target DPS and precise aim, not area denial — no ground-targeted AoE nuke anywhere in the kit.
- **Primary — Quickshot** (LMB hold-to-draw, 0.3s cd starting on release, aimed projectile, base speed 55): hold to draw over 0.7s, release to loose. Damage and arrow speed both scale with a charge fraction floored at 35% (an instant snap-release still fires a weak, fast plink, never a literal 0) up to 100% at a full draw, of 12 → 18 → 25 → 34 dmg (40/80/140g). Drawing slows you to 55% move speed. Faster, flatter, and cheaper per hit than the mage's bolt. **Rank V — Rapid Volley** (220g, 30 dmg): goes fully automatic. Hold through a *complete* draw instead of releasing and the bow locks at full power, firing again every 0.3s cooldown for as long as you hold — no redraw between shots (~3.3x the sustained attack rate, offset by a slight per-shot damage cut from rank IV). Releasing before a full draw still behaves exactly like the lower ranks. Driven by a generic `autoFire` stat any charge ability could opt into (see `player/casting.ts`'s `autoFiringId` path) — nothing archer-specific in the mechanism.
- **Piercing Shot** (key 2, 4.5s cd, aimed projectile, speed 55): a heavy arrow that punches through multiple enemies in a line. 55 → 80 → 115 → 155 dmg, pierces 1 → 2 → 2 → 3 enemies (40/80/140g). The ranged-DPS answer to Fireball that stays true to "aim, don't area-deny." **Rank V — Lancing Shot** (220g): 190 dmg, pierce effectively uncapped (99) — clears an entire lane instead of stopping after a handful of enemies.
- **Pinning Shot** (key 3, 8s cd, aimed hitscan, 45-unit range): snares the single enemy on your crosshair. 8 → 12 → 16 → 20 dmg, 55% → 65% → 75% → 85% slow for 3 → 4.5s (40/80/140g). A precision single-target control tool — the opposite of Frost Field's area slow.
- **Grapple Hook** (key 4, 10s cd, ground-target mobility, range 26 → 38): aim the reticle at a wall top or the ground and confirm — needs a real walkable anchor in range or it whiffs (toast, no cooldown spent) — then reels the Archer toward it at 30 units/s over time (not a teleport), arriving on top of the anchor; a safety timeout guarantees the pull always resolves. Longer range, shorter cooldown than Blink (40/80/140g). No damage.

### Tank

- 220 HP (highest in the game), speed 4.8 (slowest). Shield + flanged mace viewmodel. The crowd-control specialist: where the Warrior kills and the Mage deletes groups with damage, the Tank stops things. Only one ability (Shield Slam) is a real stun, and the mobility charge adds a second, weaker one — both on long cooldowns relative to their own duration, and both funneled through a shared diminishing-returns helper (`stunWithFatigue` in `src/data/tank.ts`) so repeat stuns on the *same* enemy from *either* source get progressively shorter within a rolling 6s window (halved each time, floored at 0.35s) — permanent lockdown on one target isn't possible even if a player deliberately chains both cooldowns at it. The primary and Bulwark deal zero CC on purpose.
- **Primary — Shield Bash** (LMB, 0.6s cd, aimed melee cone, range 3 → 3.9, 70° arc): 10 → 15 → 21 → 28 dmg (40/80/140g). Pure chip damage, no CC — kept honest so the Tank isn't also the best damage class.
- **Shield Slam** (key 2, 9s cd, ground-target AoE, 6-unit cast range): 25 → 38 → 52 → 70 dmg, radius 3.5 → 4.2, stuns for 1.0s → 1.3s → 1.6s → 2.0s (40/80/140g). The CC centerpiece — at max rank, ~22% stun uptime on a single target if spammed on cooldown.
- **Bulwark** (key 3, 18s cd, instant self-buff, no targeting reticle): reduces incoming damage by 40% → 50% → 60% → 70% for 4 → 6s (40/80/140g). Pure mitigation, no heal — via a new generic `applyDamageReduction()` helper in `sim/classes.ts` any class could use. Differentiates from the Warrior's Second Wind (restores lost HP) by preventing damage instead.
- **Shield Charge** (key 4, 11s cd, instant directional mobility — no reticle, no confirm): barges forward along your facing the instant you press the key, same `launchPlayer()` shape as the Warrior's Leap but flatter (vertical speed 16 vs Leap's 18 — apex ≈ 9.1, still clears the 6-unit wall). Horizontal speed 5.5 → 8.5. Slams down for 20 → 58 dmg (radius 3 → 3.6) and a 0.8s → 1.2s stun the instant it lands (40/80/140g). The Tank's second, smaller CC source — same fatigue tracking as Shield Slam.

## Structures

Ally stats/behavior are data-driven (`src/data/allies.ts`'s `AllyDef`: melee / ranged / caster /
support) — every spawner below plugs into one shared AI instead of its own bespoke code path.
**Every ally except the Engineer advances to the CURRENT forwardmost intact wall**, not
necessarily their own structure's — a barracks built on the keep still sends its squad to fight
at the outer wall while it stands, and falls back with everyone else the instant that wall falls
(each ally just re-targets its own point on the new line independently, so nothing conga-lines
across the map). Depth at that front is role-appropriate, not one shared spot: melee (Swordsman,
Tank) stand farthest out as the actual shield wall; ranged (Archer) and caster (Mage) hold a
shorter line just behind them — sheltered by the melee rank, but still comfortably inside their
own attack range, including against flyers; the Medic holds the safest post of the three ranks,
tucked into the courtyard behind the wall itself (ground enemies can never reach behind a wall
that's still standing), close enough to keep healing the player and nearby allies as the front
moves forward. The Engineer is the one exception: it stays posted at its OWN home wall instead of
following the front, because it repairs that specific wall regardless of where it physically
stands — chasing the front would only separate it from the wall it's fixing, for no benefit.

**Anti-air is an explicit per-structure flag** (`STRUCTURE_ANTI_AIR` in `src/data/structures.ts`),
not an accident of aim math — Phase 2 roadmap. Every structure's own target search consults it
alongside `isFlyerDef()`, and it's always spelled out in the structure's own description text so
the player can tell which embrasure picks answer flying enemies and which don't, without reading
code. Three of the game's four static defenses can hit air (Crossbow/Ballista/Cannon, Arc
Lightning); the Flamethrower deliberately cannot.

### Crossbow (static defense, embrasure socket) — 60g
Auto-fires bolts at the nearest enemy in a 30-unit range, front arc, aimed in full 3D — hits
flying enemies. Base: 15 dmg every 1.2s. Three mutually exclusive identities — pick one path at
first upgrade:
- **Rapid path**: I (50g) +60% fire rate → II (90g) +120% fire rate. Best sustained single-target
  DPS per gold; no range or pierce.
- **Ballista path** (range + damage + pierce, all three growing): I (50g) 2× dmg, +6 range,
  pierces 1 → II (90g) 3.5× dmg (total), +12 range (total), pierces 2. The long-reach precision
  pick — best against one tough target far out, or a whole line of them via pierce.
- **Cannon path** (new): I (50g) 3× dmg, splash radius 3, 40% projectile speed, 70% fire rate →
  II (90g) 5× dmg (total), splash radius 4.5 (total), still slow-loading and slow in flight. Heavy
  single-shot payoff against clustered or slow targets; the worst of the three against one fast,
  erratic mover (dragon) since the slow bolt needs a long lead and there's nothing to chain to if
  it whiffs.

### Flamethrower (static defense, embrasure socket) — 130g
The opposite trade from the crossbow: a very short range (7, growing to 14 at max level) but wide
continuous cone (100°, growing to 150°) of true damage-over-time (42 dps, growing to 108),
applied directly every tick rather than spawned projectiles — reads identically at any tick rate.
Devastating against a swarm packed against the wall face; useless at any real distance (a
skeleton archer standing off at range 22 never enters even the max-level cone). Ground-only —
cannot hit flying enemies at all, unlike every other static defense — so it's a deliberate
non-answer to balloons/dragons, not an oversight.
- **Inferno Nozzle** (100g): range 10, cone 124°, 68 dps.
- **Inferno Nozzle II** (170g): range 14, cone 150°, 108 dps.

### Arc Lightning Tower (static defense, embrasure socket) — 150g
A mid-range (20-unit) chain attack: each shot hits the nearest enemy in range, then jumps to the
nearest *other* enemy within jump radius of the last one hit (never repeating a target in the
same volley), with damage falling off on every jump. Base: 26 dmg every 1.6s, chains to 2
additional targets, jump radius 6. Rewards enemies standing near each other;
against one truly isolated target it's just a single, unremarkable hit — worse per-shot than a
plain crossbow bolt. Chains through the air exactly like across the ground (hits flying enemies),
making it the ranged, magical anti-air pick, as opposed to the crossbow's incidental one and the
flamethrower's total lack of one.
- **Overcharge** (110g): 34 dmg, chains to 3 targets, jump radius 7.
- **Overcharge II** (190g): 46 dmg, chains to 4 targets (total), jump radius 8.5 (total).

### Swordsman Armory (spawner, chamber socket) — 80g
Maintains up to 3 swordsman allies (60 HP, 12 dmg swings, speed 4.8); one respawns every 8s.
Allies sortie out and hold a **battle line 6 units in front of the forwardmost intact wall**
(see above — not necessarily their own), fanned out around the armory's socket so a squad
presents a front instead of stacking on one point. They engage the nearest enemy within 24 units
of that line — a 30-unit envelope measured from the wall, matching the wall's own crossbow range
— then reform on the line rather than retreating to the wall face between fights. Cannot target
flying enemies (no way to reach them); ranged/caster allies below can.
- **Veterans I** (70g): +1 max swordsman, +25% ally HP
- **Veterans II** (120g): +50% ally dmg, +25% more HP

### Archer Barracks (spawner, chamber socket) — 100g
Maintains up to 2 archers (38 HP, 9 dmg, 20 range, speed-4.2 but never chases) who hold a short
line just behind the melee rank at the CURRENT forwardmost wall (not necessarily their own — see
above), and shoot anything in range and line of sight — including flying enemies, giving the
player a buildable anti-air answer beyond their own aimed attacks and the crossbow towers.
Branching upgrade — pick one path at first upgrade:
- **Marksmen path**: I (70g) +30% dmg → II (120g) +70% dmg (total), +4 range
- **Volley path**: I (70g) +1 max archer, +30% fire rate → II (120g) +2 max archers (total), +60% fire rate (total)

### Mage Tower (spawner, chamber socket) — 140g
The priciest, smallest-roster spawner by design: a single battle-mage (32 HP) who holds a post
just behind the melee rank at the current forwardmost wall (not necessarily its own — see above)
and lobs a slow (2.6s cooldown), heavy 20-dmg bolt that explodes for AoE and slows survivors 35%
for 2.5s — including flying enemies. Branching upgrade, plus an independent capacity root:
- **Arcane Overload path**: I (90g) +50% dmg, +20% blast radius → II (150g) +110% dmg (total), +40% radius (total)
- **Chilling Presence path**: I (90g) +15% slow, +1s duration → II (150g) +30% slow (total), +2s duration (total)
- **Reinforced Spire** (130g, independent of the branch above): +1 max mage — a second caster whichever combat style you picked

### Tank Barracks (spawner, chamber socket) — 120g
Bulky, slow melee (220 HP, 8 dmg, speed 2.6) that form up slightly ahead of any swordsmen on the
forwardmost wall's line and soak hits; the roster cap never grows past 2 — a tank squad stays
small and expensive by design, not something you field an army of. Branching upgrade:
- **Plated Armor path**: I (90g) +30% HP, +10% flat damage reduction → II (140g) +60% HP (total), +20% reduction (total)
- **Aggressive Stance path**: I (90g) +50% dmg, +20% speed → II (140g) +100% dmg (total), +40% speed (total)

### Field Hospital (spawner, chamber socket) — 160g
Trains a medic (heals the player and nearby allies) and an engineer (passively repairs this
wall's HP, for free). The medic holds a sheltered post behind the CURRENT forwardmost wall,
following the fight forward like every other ally except the engineer — it needs to stay in
proximity range of whoever it's healing. The engineer instead holds its post behind its OWN home
wall regardless of where the front currently is, since it repairs that specific wall and nothing
is gained by wandering from it. Both only act once combat starts. Engineer repair never spends
gold and is capped at 40 wall-hp/sec combined per
wall tier regardless of upgrades or how many engineers are stationed there, so it meaningfully
extends a wall's life under light pressure without making it invincible under a real assault
(a single Orc Bruiser alone already out-damages the cap). Unlike the other three spawners, both
upgrade paths are independently purchasable rather than exclusive — a purely-support building is
meant to eventually do both jobs well, so the choice is which to fund first, not either/or:
- **Combat Medics**: I (100g) +50% heal amount, +30% heal range → II (160g) +100% heal amount (total), +1 medic
- **Corps of Sappers**: I (100g) +50% repair rate → II (160g) +120% repair rate (total), +1 engineer

## Enemies (v1 roster)

| Enemy | HP | Speed | Behavior | Gold |
|---|---|---|---|---|
| Goblin Grunt | 30 | 4.5 | Fast melee swarm. 8 dmg vs units, 5 DPS vs walls. Prefers nearby allies over walls. | 6 |
| Orc Bruiser | 140 | 2.2 | Slow tank, wall-breaker. 20 dmg melee, 20 DPS vs walls. | 15 |
| Skeleton Archer | 45 | 3.2 | Stops at 22 range, shoots exposed units/structures/player (7 dmg / 2.2s), else plinks walls. Arrows are stopped by merlons — using cover meaningfully cuts incoming damage. | 10 |
| Orc Warlord (wave 10 boss) | 1200 | 1.8 | Huge. 40 dmg melee, 60 DPS vs walls. | 200 |
| Hot Air Balloon (flying, wave 6+) | 320 | 1.3 | Slow, tanky siege bomber. Cruises at altitude 10, always above the merlon line, drops a bomb every 3.5s: 26 dmg AoE (r4) to any defender caught in the blast, plus a 45 flat burst to whatever wall it's currently over. Never dodges, never blocked by battlements — the only counter is DPS. | 45 |
| Dragon (flying, wave 9+) | 260 | 7.5 | Fast, dangerous breath-strafer. Cruises at 9.5, dives to 6.5 once per second in sync with its breath tick (12 dmg AoE r3 to anyone under it, plus a 10 flat wall-HP burst), then patrols side to side once it reaches the keep. The dive height is genuinely blockable by merlons (unlike the balloon) — standing still under its pass is the losing move; reposition instead. | 55 |

Melee enemies attack the nearest point of the **outermost intact wall**, spreading along its width; when it falls they pour through toward the next tier.

### Flying enemies (ignore walls) — counter-play

Flyers hold a fixed or gently oscillating altitude and advance straight down the field, ignoring
every wall's HP/collision entirely, until they reach a hold point just in front of the keep
(z=26) where they park (balloon) or patrol side-to-side across the wall (dragon) — always inside
the box the player can walk right up to, so one is never out of reach forever. They are dangerous
the whole time they're inbound, not just once parked: every attack interval they damage any
defender under their current position and chip whatever wall's footprint they're crossing, which
is why they can't simply be out-waited behind an intact lower tier.

**What can hit air, and why:**
- **The player's own aimed attacks** (Arcane Bolt, Quickshot, crossbow-style projectiles) are
  fully 3D — aim up and they hit exactly like any ground target. This is the one counter that
  always works, at any altitude, against either flyer.
- **Crossbows** auto-track flyers already, with no changes needed: their target search has no
  height gate, and their aim solution already computes a full 3D vector to the target's
  mid-height. The catch is the existing "in front of my wall" gate (`pos.z < wall.z`,
  `sim/structures.ts`, not owned by this module) — a wall's crossbow can only ever engage a flyer
  that hasn't flown past that wall's z yet. Flyers are deliberately parked at z=26 (in front of
  the keep) rather than behind it, specifically so the keep's own crossbow stays a valid passive
  counter for the whole fight instead of losing all structure counter-play the moment a flyer
  arrives.
- **Battlements matter differently for each flyer.** The balloon cruises at 10, above
  `MERLON_TOP` (8.2) at all times — never blocked by a merlon, from any angle. The dragon dives
  to 6.5 once per attack (above the plain parapet lip at 6.4, but below `MERLON_TOP`) — during a
  dive it can genuinely be blocked by an intervening wall's merlon, the same cover mechanic that
  already protects a ducking player.
- **Ground-targeted AoE** (Fireball etc.) incidentally threatens flyers too: the underlying AoE
  hit-test is XZ-only (no height check), an existing property of the shared projectile-impact
  code, not something added for flyers.
- **Melee allies cannot reach flyers** at any real altitude — they have no ranged option, and a
  height gate (`MELEE_TARGET_MAX_DY`, mirroring `ENEMY_AI.aggroMaxDy`) stops them from targeting
  or swinging at something overhead, so they never ignore the ground fight to flail at the sky.
- **Ranged and caster allies deliberately can engage flyers** — their range test is true 3D.
  Archer Barracks and Mage Tower are therefore a buildable anti-air answer, so countering air
  isn't purely the player's personal responsibility.

See `.claude/agents/enemy-builder.md`/ROADMAP.md for the full design rationale (Phase 1: "must
decide deliberately which defenses can hit air, and make it legible").

## Waves

Start gold: 150. Wave-clear bonus: 25 + 5×wave.

| Wave | Composition (count × type, spawn interval) |
|---|---|
| 1 | 6 goblins (2.5s) — tutorial pace |
| 2 | 10 goblins (2s) |
| 3 | 10 goblins (1.8s) + 2 orcs (after 15s, 8s apart) |
| 4 | 14 goblins (1.5s) + 4 orcs |
| 5 | 10 goblins + 4 skeleton archers (intro) + 3 orcs |
| 6 | 18 goblins (1.2s) + 6 archers + **1 hot air balloon** (flying debut) |
| 7 | 8 orcs (4s) + 10 goblins — tank wave |
| 8 | 20 goblins + 6 orcs + 8 archers + **1 hot air balloon** |
| 9 | 28 goblins (0.9s) + 10 archers + 4 orcs + **1 dragon** (flying debut) — swarm |
| 10 | **Orc Warlord** + 16 goblins + 6 orcs + 8 archers + **1 hot air balloon** |
| 11+ | Endless scaling: counts ×(1 + 0.15·(n−10)), HP ×(1 + 0.12·(n−10)), speed +1%/wave (cap +30%), gold ×(1 + 0.05·(n−10)); composition rotates through waves 8/9/10's templates, so flyers (and the Orc Warlord) keep recurring and scaling up forever, not just once |

## Controls

| Input | Action |
|---|---|
| Mouse look (pointer lock) | Aim |
| WASD / Space | Move / jump |
| W / S at a ladder | Climb up / down — walking into a usable ladder grabs it automatically instead of bonking into the wall; strafe (A/D) to let go, or just reach the top/bottom |
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
