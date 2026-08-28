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

**Socket state is always readable at a distance.** Every socket carries a permanent marker, so you never have to remember where you put something or walk the whole wall to find it:

| Socket state | Marker |
| --- | --- |
| Empty | Cyan plot marker — a glowing slit on the wall face (embrasure) or a ground ring in the courtyard (chamber) |
| Built, an upgrade you can afford | Gold beacon (ring + stem + gem) that slowly spins and bobs |
| Built, an upgrade you can't afford yet | The same beacon, dim gold and still |
| Built, tree finished | Dim green beacon, still — present, but deliberately not asking for attention |

One hue means one thing across both socket kinds: **cyan** = nothing here yet, **gold** = spend gold here, **green** = done.

During the **build phase** beacons draw *through* walls and buildings, so one look around shows every structure you own and which ones will take your gold — including those on a wall you're standing behind. The instant combat starts they revert to normal occlusion so they can never hide an enemy. The **[E]** prompt spells out the same state in words (`— upgrades available`, `(320g)` when short, or `— fully upgraded`).

**Expansion sockets (late-game gold sink, Phase 2 roadmap).** Each wall can purchase up to 2 more embrasure sockets (x = ±16 — the next crenel gap out from the base ±12 pair) and 2 more chamber sockets (x = ±9.5, in the ground-level gap between the base chamber and embrasure sockets) through that wall's upgrade tree (**B** menu → wall → Fortify → Expand the Wall). Each side is bought independently (west before east on each kind) at escalating cost (320g/500g for embrasures, 420g/650g for chambers), so a fully expanded wall tops out at 9 sockets — a firm, finite cap, not an infinite turret farm. New sockets get permanently unique ids continuing each kind's existing sequence (embrasure indices 3, 4; chamber indices 2, 3), so they never collide with, or invalidate, an already-installed structure's socket reference.

### Wall upgrades (per-wall tree, B menu)

Repairing HP is the boring lever; each wall (outer/middle/keep, tracked independently) also has its own small upgrade tree, bought from the **B** castle menu's "Fortify" drill-down for that wall, reusing the same upgrade-node UI the socket menu uses for structures:

- **Reinforced Stone** (180g) / **Masoned Core** (320g): flat 20%/35% damage resistance against everything that hits this wall — melee and ranged wallDps alike, plus flyer siege bursts — so it scales against big single hits the way flat extra HP never would.
- **Machicolations** (220g) / **Boiling Oil** (380g): the wall itself pours damage on enemies hugging its base — a blind spot no embrasure structure aims at — for 8/20 dmg/s within ~3.5-4 units of the front face; Boiling Oil adds a 30% scald-slow. Ground-level only (a small height gate keeps flyers immune, matching the "murder holes" theme).
- **Higher Battlements** (200g) / **Towering Battlements** (350g): this wall's merlons grow +1.0/+2.0 taller, deepening cover against ranged attacks and diving flyers — a real geometry change (mirrored exactly in both the render and the projectile-blocking check), not a stat tweak.
- **Standing Repair Crew** (260g): +15 wall HP/s regenerated for free, but only during intermission — distinct from the Field Hospital engineer's combat-phase, gold-free-but-capped repair, and useful even on a wall with nothing built on it.

All four are independently purchasable (no forced either/or) — a maxed-out wall is meant to feel like a genuine bastion once a run has gone long enough to afford one.

## Player & classes

Generic, data-driven class framework. A class = `PlayerClassDef`: max HP, move speed, a **primary** (aimed, cheap, short cooldown) + **abilities** (hotkeys, cooldowns), each with a free base rank plus purchasable ranks bought with gold (Tab menu) — 3 purchasable ranks (0/40/80/140g) is the baseline shape, and several abilities go further with 1-2 extra linear ranks (220g, 320g) that change *behaviour*, not just numbers. Player death ≠ game over: respawn at the keep after 5s. Out-of-combat HP regen.

### Late-game ability Mastery trees

Every ability on every class (primaries included) also carries a **Mastery tree** hanging off the end of its linear ranks: a small branching node tree, mechanically identical to a structure's upgrade branches (`UpgradeNode`: id/cost/requires/excludes — see `sim/abilityTree.ts`, which reuses the exact machinery `sim/castle.ts`'s `upgradeStructure`/`upgradeWall` and `ui/menuWidgets.ts`'s `branchColumns`/`upgradeNodeHtml` already use for structures and walls, rather than inventing a second progression system). Every ability's tree has **two mutually exclusive root branches**, each with a **tier-1 node (600g) and a tier-2 capstone (1600g)** that requires it — picking one branch locks out the other, exactly like the crossbow's Rapid/Ballista/Cannon split. Not gated behind maxing the linear ranks first (structures don't force that either): the steep tier costs relative to a maxed linear kit (~260-540g total) already make rushing a mastery node a poor trade in practice. A node's stats are always *absolute totals* that override the linear ranks, so a purchased node only needs to name what it changes — see each class's table below for the full branch list, and `data/<class>Tree.ts` for the implementation-level numbers.

The **Tab menu** shows each ability's Mastery branches as upgrade-tree columns directly under its linear-rank row (`ui/classMenu.ts`). The **HUD ability bar** shows Mastery progress as small violet diamond pips next to the (gold, circular) rank pips; if an ability's linear ranks would need more than 5 dots to show individually, the bar switches to a compact "rank/max" number instead so the 58px slot never gets unreadable as kits grow deeper (`ui/hud.ts`).

**Skill combos (rewarding class familiarity).** Some of the kit pays off extra for players who
learn how the pieces fit together. These are deliberately *additive* — never required, never a
rotation you must memorise, and the baseline use of every ability is unchanged for a player who
never discovers them. They cost nothing but timing:

- **Warrior — aerial Ground Slam.** Cast Ground Slam while airborne (after a jump or a Leap) and
  the Warrior is driven straight down instead of aiming a reticle, resolving the slam where they
  actually land with up to **+75% damage**, scaled by how far they fell (full bonus at ~8 units).
  Leap → Slam is the signature combo. Radius and stagger are unchanged at every height, so the
  AoE indicator never lies about its reach.
- **Archer — Steady Aim.** Loosing Piercing Shot *while still holding a bow draw* borrows the
  draw's steadiness for up to **+50% damage** at a full draw. Hotkey abilities never cancel a
  draw, so weaving the two is purely a matter of knowing you can.
- **Warlock — Focused Curse.** Casting Curse of Agony *while Soul Siphon is actively channelling*
  borrows the beam's live ramp for up to **+50%** to the curse's damage and its damage-taken
  mark — the same "read a live hold-state from another ability's cast()" trick Steady Aim uses,
  just applied to a channel instead of a draw. Hotkey abilities never interrupt the channel, so
  holding the beam with one hand and popping the curse with the other is purely a matter of
  knowing you can.

### Status & effect clarity

Every active status on an enemy shows as a small icon above it — **stun**, a heavy **root** (a slow
severe enough to nearly immobilise), a milder **slow**, a **mark** (taking increased damage),
**bleed**, and **burn** (standing in a damage zone). Icons are capped at **2 per enemy** with a
fixed priority (hard CC first, ground-zone burn last), so a wave of 80 enemies stays readable
instead of becoming a wall of symbols. Glyphs are silhouette-distinct, not merely colour-coded, so
they survive colourblindness and distance.

**Damage numbers** float off each enemy as it's hit, so you can tell a glancing hit from a real
one without reading health bars. A hit on a **marked** target renders hotter and larger, making the
mark's payoff visible rather than theoretical, and a **killing blow** always renders on its own at
full size. Continuous damage (bleeds, burns, standing in a zone) is the readability risk here — at
60 ticks a second across a wave of 80 enemies it would be a wall of ones — so rapid repeat hits on
the same enemy accumulate and surface as a **single periodic number** instead of one per tick.
Concurrent floaters are capped, and overflow is dropped rather than queued.

Ground effects follow a **visual language keyed to function, not to which ability made them**:
damage zones glow warm and pulse steadily, slow zones glow cool and pulse gently, anything that
stuns or staggers flashes in sharp and bright (clearly a moment, not a standing hazard), and marks
read as corrupted violet. A stun landing always produces the same unmistakable flash regardless of
which of the several stun sources caused it — "stun" is one concept everywhere it appears.

Indicators are held to the same honesty rule as AoE reticles: an icon only shows a status the sim
actually has active, and any effect implying a radius or duration is sized from the real gameplay
values (see `Impact.radius`/`duration`), because players position around what they see.

**Mobility abilities.** Every class gets one signature ability tagged `role: 'mobility'` on its `AbilityDef` — a class-flavored way to reposition, especially to get up onto a wall tier without walking the stair ramps at x = ±18. Four different physical shapes share the slot: **Mage** — Blink instantly teleports (`cast()` sets the caster's position directly, clamped to the same forward-barrier/playfield bounds the WASD controller enforces, snapped to ground height at the landing point); **Warrior** — Leap is a real ballistic jump launched via the controller's `launchPlayer()` (a persistent launch velocity that rides out gravity/ground-collision exactly like walking/falling do, so it can't land outside the playfield or clip through a wall it doesn't have the height to clear), and slams down for AoE damage the instant it actually lands; **Archer** — Grapple Hook reels the caster toward a confirmed anchor over time via the controller's `pullPlayer()` (overrides movement + gravity, clamped to the playfield, bounded by a safety timeout); **Tank** — Shield Charge reuses the same `launchPlayer()` shape as Leap (a flatter arc, tuned as a barge rather than a jump) and also slams for damage + a brief stun on landing; **Warlock** — Umbral Flight is the fourth and newest shape: real flight via the controller's `flyPlayer()`, which suspends gravity for a fixed window while leaving horizontal input, wall collision and the playfield clamp completely untouched. It is the only one that hands control back to the player for its whole duration instead of playing out a fixed trajectory, which is exactly what a channelling class wants — the others move you somewhere, this one lets you *stay* somewhere. Nothing about the mobility slot is mage-specific — a future class gets one purely by adding an `AbilityDef` with `role: 'mobility'` to its `abilities` list, picking whichever of the four physical shapes (instant teleport / launch / pull / flight) fits.

### Mage (first class)

- 100 HP, speed 6. Staff viewmodel. Master of arcane artillery, all abilities ground-targeted AoE except its aimed bolt primary.
- **Primary — Arcane Bolt** (LMB, 0.4s cd, aimed projectile, speed 40): 20 → 30 → 45 → 65 dmg (40/80/140g). **Rank V — Piercing Bolt** (220g): 80 dmg and now pierces 1 extra enemy instead of stopping on the first hit.
  **Mastery** (600g/1600g, pick one): *Fork Bolt → Arcane Fusillade* — splits into 2 (45 dmg each) then 3 (55 dmg each) spread bolts, no pierce; clears a cluster of separate targets. *Empowered Bolt → Overcharged Bolt* — trades pierce for a single 150 → 260 dmg hit with a 25% → 40% slow; the execute button for one tough target.
- **Fireball** (key 2, 6s cd, ground-target AoE): 60 dmg r4 → 90 r5 → 130 r6 → 180 r6.5 (40/80/140g). **Rank V — Meteor Mastery** (220g): 210 dmg, damage radius unchanged, but the shockwave now also stuns everything in a much wider 10-unit ring for 1.6s (cooldown stays far above the stun, so a single caster can't approach lockdown).
  **Mastery** (600g/1600g, pick one): *Meteor Storm → Meteor Swarm* — 2 then 4 extra fragments (70/100 dmg, r3-3.5) scattered up to 6-8 units from the blast; covers a much wider footprint against a spread group. *Volcanic Rupture → Molten Rupture* — a heavier single impact (260 → 320 dmg) leaves a burning crater (35 → 55 dmg/s for 4-6s); punishes wall-huggers and tanky targets that stand and fight.
- **Frost Field** (key 3, 10s cd, ground-target AoE): slow field r5 → r6.5, 40%/4s → 50%/5s → 60%/6s → 65%/7s (40/80/140g). **Rank V — Deep Freeze** (220g): r7.5, 70%/8s slow, plus a brief 1.2s stun on cast.
  **Mastery** (600g/1600g, pick one): *Permafrost → Eternal Frost* — once the main slow fades, a weaker 30% → 45% chill lingers 5-7s longer; a chokepoint that stays cold. *Killing Frost → Hoarfrost* — the field itself now burns for 18 → 32 dmg/s; converts pure control into a real damage source.
- **Blink** (key 4, 12s cd, ground-target mobility): short-range teleport to the targeted point, snapped to ground/wall-top height there — the fast way up onto a wall. Range 22 → 24 → 26 → 28 (40/80/140g). No damage. Never lands past the forward barrier or off the playfield edges.
  **Mastery** (600g/1600g, pick one): *Blink Cascade → Blink Torrent* — a second, then third, banked charge usable back-to-back before the full cooldown returns; built for constant repositioning. *Arcane Rebound → Violent Rebound* — leaves a detonating rune (60 → 110 dmg, 40% → 55% slow) at the point you blinked from; punishes anyone chasing you.
- Ground targeting: press ability key → decal circle projects where the crosshair meets the ground → LMB confirms, RMB/Esc cancels.

### Warrior

- 150 HP, speed 6. Sword viewmodel (steel blade, gold crossguard/pommel). Frontline brawler: sustained melee pressure and survivability, not artillery — every ability is short-ranged and centered on the caster.
- **Primary — Cleave** (LMB, 0.35s cd, aimed melee cone, range 4 → 4.4 → 4.8 → 5.2, 100° arc): hits *every* enemy in the arc, 16 → 24 → 34 → 46 dmg each (40/80/140g). Not a projectile — scans `game.enemies` in a cone from the caster like Frost Field scans a ground circle, and calls `takeDamage()` directly. **Rank V — Whirlwind** (220g): 58 dmg, range 5.5, and the arc opens to a full 360° — hits everything around you, not just what's in front. Still pure damage, no CC, still the fastest cooldown in the game.
  **Mastery** (600g/1600g, pick one): *Bloodletting → Hemorrhage* — every hit stacks a bleed (14 → 26 dmg/s per stack, up to 5); a tough single target caught under repeated Cleaves bleeds hard. *Momentum → Unstoppable* — every kill refunds 0.2s → 0.35s off Cleave's own cooldown; chain kills through a weak swarm and the blade barely stops.
- **Ground Slam** (key 2, 7s cd, ground-target AoE, 6-unit cast range): damage + brief stagger. 45 → 65 → 95 → 130 dmg, radius 3 → 4, staggers for 35%/1.2s → 45%/1.6s slow (40/80/140g). A melee-range hybrid of Fireball's damage and Frost Field's control, compressed into a shockwave at your feet.
  **Mastery** (600g/1600g, pick one): *Aftershock → Seismic Aftershock* — the shockwave washes out to a 7-9 unit outer ring (40 → 65 dmg, 25% → 35% slow) beyond the normal blast; reaches enemies the tight inner radius alone would miss. *Fracture → Shatterpoint* — cracks armor instead of reaching further: +25% → 40% damage taken from your own Cleave/Leap for 3-4s; a setup for your own combo.
- **Second Wind** (key 3, 20s cd, instant self-heal, no targeting reticle): heals 40 → 60 → 85 → 120 HP (40/80/140g). Survivability tool — dig in and keep swinging instead of retreating.
  **Mastery** (600g/1600g, pick one): *Adrenaline Surge → Berserker's Surge* — heals 100 → 150 and grants +20% → 35% damage on all attacks for 5-6s; turns recovery into a counter-offensive. *Battle Fortitude → Unbreakable* — heals 100 → 150 and cuts incoming damage 25% → 35% for 3-4s; a Bulwark-lite bolted onto the heal.
- **Leap** (key 4, 5s cd, instant directional mobility — no reticle, no confirm): launches you up and forward along your current facing the instant you press the key. Horizontal launch speed 4.5 → 7.5, vertical launch speed a constant 18 (apex ≈ 11.6 units, comfortably clears the 6-unit wall — see src/data/warrior.ts for the arc math), giving horizontal ranges of roughly 11.6 → 19.3. Slams down for 20 → 55 AoE damage (radius 2.5 → 3) the instant you actually touch ground (40/80/140g). Punchier and far faster-cooldown than Blink, and — unlike Blink — doubles as an attack. **Rank V — Seismic Leap** (220g): speed 8.2, 75 dmg, radius 3.4 — pure scaling. **Rank VI — Earthshaker** (320g): speed 8.8, 95 dmg, radius 4, and the landing slam now stuns for 1.3s (≈26% uptime on a single target at Leap's 5s cooldown — a flinch, not a lock, on a cluster-sized radius).
  **Mastery** (600g/1600g, pick one): *Rolling Thunder → Thunderclap* — the landing slam knocks everything hit back 2.5 → 3.5 units; buys space instead of just damage. *War Leap → Restless War Leap* — sheds the landing slam's damage growth for a cooldown cut to 60% → 40% of normal (~2s → ~1.25s); a repeatable gap-closer for chaining leaps across the field.

### Archer

- 80 HP, speed 6.5. Bow viewmodel (recurve limb + string). Ranged skirmisher built around sustained single-target DPS and precise aim, not area denial — no ground-targeted AoE nuke anywhere in the kit.
- **Primary — Quickshot** (LMB hold-to-draw, 0.3s cd starting on release, aimed projectile, base speed 55): hold to draw over 0.7s, release to loose. Damage and arrow speed both scale with a charge fraction floored at 35% (an instant snap-release still fires a weak, fast plink, never a literal 0) up to 100% at a full draw, of 12 → 18 → 25 → 34 dmg (40/80/140g). Drawing slows you to 55% move speed. Faster, flatter, and cheaper per hit than the mage's bolt. **Rank V — Rapid Volley** (220g, 30 dmg): goes fully automatic. Hold through a *complete* draw instead of releasing and the bow locks at full power, firing again every 0.3s cooldown for as long as you hold — no redraw between shots (~3.3x the sustained attack rate, offset by a slight per-shot damage cut from rank IV). Releasing before a full draw still behaves exactly like the lower ranks. Driven by a generic `autoFire` stat any charge ability could opt into (see `player/casting.ts`'s `autoFiringId` path) — nothing archer-specific in the mechanism.
  **Mastery** (600g/1600g, pick one — the flagship "full auto branches further" example): *Ballistic Rounds → Siege Rounds* — full-auto arrows become slow, heavy cannonballs (26 → 34 dmg, splash radius 2.5 → 3.5) at ~55%/50% fire rate; a hand-held siege weapon against a packed lane. *Storm Quiver → Tempest Quiver* — full-auto arrows arc to 2 → 4 nearby enemies on hit (radius 6-7.5, 35-40% falloff/jump); a full-auto stream that sweeps a spread group.
- **Piercing Shot** (key 2, 4.5s cd, aimed projectile, speed 55): a heavy arrow that punches through multiple enemies in a line. 55 → 80 → 115 → 155 dmg, pierces 1 → 2 → 2 → 3 enemies (40/80/140g). The ranged-DPS answer to Fireball that stays true to "aim, don't area-deny." **Rank V — Lancing Shot** (220g): 190 dmg, pierce effectively uncapped (99) — clears an entire lane instead of stopping after a handful of enemies.
  **Mastery** (600g/1600g, pick one): *Explosive Tip → Detonating Lance* — the arrow detonates at the end of its line (90 → 140 dmg AoE, radius 3.5-4.5); everyone around the last enemy in the lane gets hit too, not just the line itself. *Hunter's Mark → Predator's Mark* — marks everything pierced: +25% → 40% damage taken from your other attacks for 4-5s; turns a line-clear into a setup for the rest of your kit.
- **Pinning Shot** (key 3, 8s cd, aimed hitscan, 45-unit range): snares the single enemy on your crosshair. 8 → 12 → 16 → 20 dmg, 55% → 65% → 75% → 85% slow for 3 → 4.5s (40/80/140g). A precision single-target control tool — the opposite of Frost Field's area slow.
  **Mastery** (600g/1600g, pick one): *Crippling Shot → Sundering Shot* — each hit on the same target stacks a 12% → 18% armor shred (up to 4-5 stacks); a dedicated execute tool against one priority target. *Web of Arrows → Tangling Web* — a weaker 35% → 45% slow spreads to anyone within 4-5.5 units of the mark; single-target control that leaks into a mini zone.
- **Grapple Hook** (key 4, 10s cd, ground-target mobility, range 26 → 38): aim the reticle at a wall top or the ground and confirm — needs a real walkable anchor in range or it whiffs (toast, no cooldown spent) — then reels the Archer toward it at 30 units/s over time (not a teleport), arriving on top of the anchor; a safety timeout guarantees the pull always resolves. Longer range, shorter cooldown than Blink (40/80/140g). No damage.
  **Mastery** (600g/1600g, pick one): *Quickdraw Rig → Grapnel Array* — reels 40% → 80% faster and cooldown drops to 70% → 50% of normal; built for constant repositioning rather than one big traversal. *Piton Shot → Harpoon Shot* — if the hook lands near an enemy (radius 4-5) instead of terrain, it strikes for 35 → 60 dmg and yanks them 6-9 units toward you instead of pulling you toward it; a mobility tool that doubles as crowd control.

### Tank

- 220 HP (highest in the game), speed 4.8 (slowest). Shield + flanged mace viewmodel. The crowd-control specialist: where the Warrior kills and the Mage deletes groups with damage, the Tank stops things. Only one ability (Shield Slam) is a real stun, and the mobility charge adds a second, weaker one — both on long cooldowns relative to their own duration, and both funneled through a shared diminishing-returns helper (`stunWithFatigue` in `src/data/tank.ts`) so repeat stuns on the *same* enemy from *either* source get progressively shorter within a rolling 6s window (halved each time, floored at 0.35s) — permanent lockdown on one target isn't possible even if a player deliberately chains both cooldowns at it. The primary and Bulwark deal zero CC on purpose.
- **Primary — Shield Bash** (LMB, 0.6s cd, aimed melee cone, range 3 → 3.9, 70° arc): 10 → 15 → 21 → 28 dmg (40/80/140g). Pure chip damage, no CC — kept honest so the Tank isn't also the best damage class.
  **Mastery** (600g/1600g, pick one — both stay zero-CC, per the class's own rule): *Riposte → Perfect Riposte* — each enemy hit grants 6% → 9% damage reduction for 2.5-3s (stacking per hit); the more you're surrounded, the safer you are. *Vanguard's Resolve → Vanguard's Fortitude* — heals 4 → 7 HP per enemy hit; sustain via attrition instead of mitigation.
- **Shield Slam** (key 2, 9s cd, ground-target AoE, 6-unit cast range): 25 → 38 → 52 → 70 dmg, radius 3.5 → 4.2, stuns for 1.0s → 1.3s → 1.6s → 2.0s (40/80/140g). The CC centerpiece — at max rank, ~22% stun uptime on a single target if spammed on cooldown.
  **Mastery** (600g/1600g, pick one): *Concussive Slam → Shattering Slam* — stun grows 0.25s → 0.35s per enemy caught, capped at 2.6-3.2s; the bigger the cluster, the longer everyone in it is locked down. *Focused Slam → Executioner's Slam* — half the radius, but the single closest target eats +60→100 bonus dmg and +1.2-1.8s bonus stun; trades area coverage for locking down one priority threat.
- **Bulwark** (key 3, 18s cd, instant self-buff, no targeting reticle): reduces incoming damage by 40% → 50% → 60% → 70% for 4 → 6s (40/80/140g). Pure mitigation, no heal — via a new generic `applyDamageReduction()` helper in `sim/classes.ts` any class could use. Differentiates from the Warrior's Second Wind (restores lost HP) by preventing damage instead.
  **Mastery** (600g/1600g, pick one): *Aegis Overflow → Bastion Overflow* — adds an 80 → 150 HP absorb shield on top of the % reduction; soaks a burst hit that would punch straight through percentage mitigation alone. *Retaliation → Vengeful Retaliation* — every hit you take while Bulwarked pulses 20 → 35 dmg to enemies within 5-6 units; turtle and punish at the same time.
- **Shield Charge** (key 4, 11s cd, instant directional mobility — no reticle, no confirm): barges forward along your facing the instant you press the key, same `launchPlayer()` shape as the Warrior's Leap but flatter (vertical speed 16 vs Leap's 18 — apex ≈ 9.1, still clears the 6-unit wall). Horizontal speed 5.5 → 8.5. Slams down for 20 → 58 dmg (radius 3 → 3.6) and a 0.8s → 1.2s stun the instant it lands (40/80/140g). The Tank's second, smaller CC source — same fatigue tracking as Shield Slam.
  **Mastery** (600g/1600g, pick one): *Juggernaut → Rampage* — damages everything along the charge's path (30 → 50 dmg, 2.2-2.6 unit sweep), not just the landing; plow through a line instead of just the enemy at the end of it. *Bulwark Charge → Aegis Charge* — grants 45% → 60% damage reduction for the whole charge and landing; barge into danger safely instead of dealing more of it.

### Warlock

- 100 HP, speed 6. Dark iron rod + void-crystal viewmodel (magenta emissive, distinct from the Mage's violet). A second caster, but sustained and committed where the Mage is burst artillery: the whole kit rewards standing your ground on one target and punishes constantly repositioning — the opposite tension from the Mage's poke-and-move bolt.
- **Primary — Soul Siphon** (LMB hold-to-channel, medium range 25 — meaningfully shorter than the Archer's 45-60-unit reach, longer than the Warrior's 4-5.5-unit melee, so cover and enemy melee range both genuinely matter): a hitscan beam, damage expressed as dps in the data and converted using the real tick interval (0.15s) in code, so retuning the tick rate can never silently rebalance the class. It's a beam, not a projectile, but still respects cover: every tick checks `castle.blocksProjectile()` (the same check `sim/projectiles.ts` uses) before the enemy hit-test, so a wall or merlon stops it exactly like it stops an arrow. Holding it on the SAME target ramps its damage up to +80% over 3s of continuous, uninterrupted contact (moving off target, the target dying, cover blocking the shot, or releasing all reset the ramp to zero); slows you to 60% move speed while held, a real cost for the commitment. The beam has an acquisition radius of 1.3 (plus the target's own radius) — how far off-centre an enemy can be and still be caught. It always locks the single NEAREST enemy in that cylinder; a wider beam never means more targets at once, only a more forgiving lock. 30 → 46 → 66 → 92 dps (40/80/140g). **Rank V — Soul Drain** (220g): 118 dps; once a target is fully ramped, 35% of the damage dealt heals you back; and the beam both widens (radius 1.3 → **2.2**) and reaches further (25 → **30**). All three serve the ramp rather than raw output: the ramp is the whole ability, and the things that reset it to zero are a target sidestepping out of a narrow beam or stepping just past the edge of your reach. A maxed beam's damage comes from the lock it manages to keep. The drawn beam thickens in proportion, so the widening is visible rather than a hidden stat.
  **Mastery** (600g/1600g, pick one): *Withering Beam → Blighted Beam* — a fully-ramped hit leaves a lingering residue (30 → 50 dmg/s for 3-4s) that outlives the channel, growing into a spreading blight (radius 4.5) that catches nearby enemies too. *Soul Anchor → Soul Bond* — lifesteal (30% → 48%) applies from the very first tick instead of only once fully ramped; a beam that sustains you through the whole fight, not just the payoff moment.
- **Curse of Agony** (key 2, 9s cd, ground-target AoE): a damage-over-time curse that also marks everything it touches with bonus damage taken from your whole kit (not just this ability). 14 → 20 → 28 → 38 dmg/s, radius 5 → 6, duration 5 → 6s, +20% → 30% dmg taken (40/80/140g). **Skill combo — Focused Curse**: cast while Soul Siphon is actively channelling and it borrows the beam's live ramp for up to +50% to both the curse's damage and its mark, at any ramp in between — purely additive, changes nothing for a Curse cast on its own.
  **Mastery** (600g/1600g, pick one): *Festering Curse → Plague Curse* — a much bigger, harder-hitting curse (radius 6.5 → 8, 55 → 80 dmg/s); leans all the way into raw damage over the mark. *Agonizing Mark → Excruciating Mark* — trades damage for a much deeper mark (+40% → 55% dmg taken) plus a genuine 30% → 40% slow.
- **Abyssal Grasp** (key 3, 12s cd, ground-target AoE, utility/control): rips open a rift that yanks every enemy in radius 5 → 6 up to 3 → 5 units toward its center and roots them with a 60% → 85% slow for 2 → 3s (40/80/140g) — the stillness a channel wants, bought at range instead of hoped for; deliberately not a Frost-Field reskin (the payoff is clustering, not just an area slow). No damage on its own.
  **Mastery** (600g/1600g, pick one): *Crushing Void → Collapsing Void* — the rift now also hits for 40 → 75 dmg on top of the pull; a hybrid control/damage tool. *Binding Chains → Unbreakable Chains* — trades some pull for a genuine 1.0s → 1.5s stun on everything caught, the guaranteed stillness a channel wants instead of just a heavy slow.
- **Umbral Flight** (key 4, 16s cd, instant self mobility): actual flight. Gravity switches off for 3.2 → 5.4s (40/80/140g); you keep full movement control, hold **Space** to climb to an absolute ceiling of 11 → 12, and drift wherever you like until it ends — then you fall. No damage. The only mobility ability in the game that isn't a fixed trajectory, and the kit is why: every other class repositions *to* somewhere and resumes fighting, while the Warlock's whole identity is standing still and channelling. Flight buys the one position a melee horde cannot answer — directly above it — for exactly as long as Soul Siphon needs to ramp. Deliberately a committed window rather than an escape: the ceiling is absolute (taking off from a wall top can't stack on the wall's own height), there is no descend control, and it can pass *over* a wall but never through one — horizontal collision applies exactly as it does on foot, so flying into a wall below its parapet still stops you dead.
  **Mastery** (600g/1600g, pick one): *Endless Wings → Wings of the Abyss* — 7.4s → 9.6s aloft and a higher ceiling (13 → 15); long enough to cross the field above the horde, draining the whole way. *Dread Takeoff → Maelstrom Ascent* — the downdraft as you launch deals 60 → 110 dmg and drags everything within 4.5 → 6 units inward, so the horde is bunched directly beneath the spot you are about to hover over. The damage is the smaller half of that; the clustering is the point, since it hands Soul Siphon and Curse of Agony the shape they both want.

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
own attack range, including against flyers; the Medic no longer holds a static post at all — it
stages on the FRONT side of the front wall (4 units out) and actively walks out to the
most-wounded defender within 16 units, closing to 2.5 units to treat them (heal range 9, since it
travels to the patient instead of relying on a wide stationary aura) before returning to its
rally point. The Engineer is the one exception: it stays posted at its OWN home wall instead of
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

**High tier (600g/1600g, independent of Veterans — not gated behind maxing it, same as ability
Mastery below).** A second, later branch point, purely behavioral — neither root touches hp or
damage. Mutually exclusive:
- **Bleeding Strikes → Hemorrhaging Strikes**: every swing opens a stacking wound (10 → 18 dmg/s
  per stack, up to 3 → 4 stacks, refreshed on each hit) via the same generic DoT helper the
  Warrior's own Bloodletting Mastery uses — attrition against one tough target.
- **Sundering Blows → Rending Blows**: every hit marks the target for +15% → 25% damage taken
  from everything — you, allies, towers — for 3-4s. Every swordsman becomes a spotter amplifying
  the whole wall's firepower instead of just its own.

### Archer Barracks (spawner, chamber socket) — 100g
Maintains up to 2 archers (38 HP, 9 dmg, 20 range, speed-4.2 but never chases) who hold a short
line just behind the melee rank at the CURRENT forwardmost wall (not necessarily their own — see
above), and shoot anything in range and line of sight — including flying enemies, giving the
player a buildable anti-air answer beyond their own aimed attacks and the crossbow towers.
Branching upgrade — pick one path at first upgrade:
- **Marksmen path**: I (70g) +30% dmg → II (120g) +70% dmg (total), +4 range
- **Volley path**: I (70g) +1 max archer, +30% fire rate → II (120g) +2 max archers (total), +60% fire rate (total)

**High tier (600g/1600g, independent of Marksmen/Volley).** A second branch point: pierce a line
vs splash a cluster, the same shape of decision as the crossbow's own Ballista-vs-Cannon split.
Mutually exclusive:
- **Broadhead Arrows → Piercing Volley**: arrows pierce 1 → 2 extra enemies, full damage to each
  (reuses the projectile system's own pierce field) — clears a whole lane standing in a line.
- **Explosive Fletching → Detonating Volley**: arrows detonate on impact instead of hitting a
  single target, splash radius 2.0 → 3.0 — clears whatever's clustered at the wall.

### Mage Tower (spawner, chamber socket) — 140g
The priciest, smallest-roster spawner by design: a single battle-mage (32 HP) who holds a post
just behind the melee rank at the current forwardmost wall (not necessarily its own — see above)
and lobs a slow (2.6s cooldown), heavy 20-dmg bolt that explodes for AoE and slows survivors 35%
for 2.5s — including flying enemies. Branching upgrade, plus an independent capacity root:
- **Arcane Overload path**: I (90g) +50% dmg, +20% blast radius → II (150g) +110% dmg (total), +40% radius (total)
- **Chilling Presence path**: I (90g) +15% slow, +1s duration → II (150g) +30% slow (total), +2s duration (total)
- **Reinforced Spire** (130g, independent of the branch above): +1 max mage — a second caster whichever combat style you picked

**High tier (600g/1600g, independent of Overload/Chilling/Spire).** Mutually exclusive:
- **Arcane Residue → Arcane Blight**: each blast now leaves a lingering scorched patch (16 → 28
  dmg/s for 3-4.5s, via the same generic ground-effect helper the player Mage's own Volcanic
  Rupture/Killing Frost Mastery branches use) — sustained area denial instead of a single burst.
- **Twin Casting → Triple Casting**: the same cast also fires 1 → 2 extra, weaker bolts (50% →
  65% damage) at other nearby enemies — named after, and the ally-tower mirror of, the player
  Mage's own Fork Bolt → Arcane Fusillade Mastery: one spell answering a spread group instead of
  committing everything to a single target.

### Tank Barracks (spawner, chamber socket) — 120g
Bulky, slow melee (220 HP, 8 dmg, speed 2.6) that form up slightly ahead of any swordsmen on the
forwardmost wall's line and soak hits; the roster cap never grows past 2 — a tank squad stays
small and expensive by design, not something you field an army of. Branching upgrade:
- **Plated Armor path**: I (90g) +30% HP, +10% flat damage reduction → II (140g) +60% HP (total), +20% reduction (total)
- **Aggressive Stance path**: I (90g) +50% dmg, +20% speed → II (140g) +100% dmg (total), +40% speed (total)

**High tier (600g/1600g, independent of Plated Armor/Aggressive Stance).** Mutually exclusive:
- **Retaliation Plating → Vengeful Plating**: every hit the tank takes pulses 12 → 22 dmg to
  enemies within 4 → 5 units — punishes being swarmed. A self-contained equivalent of the player
  Tank's own Retaliation Mastery (not a reuse of it — that machinery is keyed to the player and
  driven by a loop allies never pass through).
- **Hardened Resolve → Undying Resolve**: every landed hit heals the tank 5 → 10 HP — sustain
  through successfully trading blows with one tough target, the opposite scenario from
  Retaliation (which does nothing without a mob nearby to punish).

### Field Hospital (spawner, chamber socket) — 160g
Trains a medic (heals the player and nearby allies) and an engineer (passively repairs this
wall's HP, for free). The medic no longer holds a static post — it stages on the front side of
the CURRENT forwardmost wall and actively walks out to the most-wounded defender within range to
treat them (see the Structures intro above), following the fight forward like every other ally
except the engineer. The engineer instead holds its post behind its OWN home wall regardless of
where the front currently is, since it repairs that specific wall and nothing is gained by
wandering from it. Both only act once combat starts. Engineer repair never spends
gold and is capped at 40 wall-hp/sec combined per
wall tier regardless of upgrades or how many engineers are stationed there, so it meaningfully
extends a wall's life under light pressure without making it invincible under a real assault
(a single Orc Bruiser alone already out-damages the cap). Unlike the other four spawners, both
upgrade paths — cheap AND high tier — are independently purchasable rather than exclusive — a
purely-support building is meant to eventually do both jobs well, so the choice is which to fund
first, not either/or:
- **Combat Medics**: I (100g) +50% heal amount, +30% heal range → II (160g) +100% heal amount (total), +1 medic
- **Corps of Sappers**: I (100g) +50% repair rate → II (160g) +120% repair rate (total), +1 engineer

**High tier (600g/1600g).** TWO independent capstones — one per roster, neither excludes the
other or the cheap tier above, following this building's own non-exclusive philosophy rather than
the other four spawners' either/or shape:
- **Guardian's Grace → Miraculous Grace** (medic): a medic within 10 → 12 units can now save a
  defender from what would otherwise be a killing blow — once every 20s → 14s per medic — leaving
  them standing at 25% → 45% HP instead of dead. Deliberately does NOT resurrect an already-dead
  unit (see `tryMedicSave` in `sim/allyTierEffects.ts`): it intercepts the killing blow before hp
  ever reaches 0, so it never races the spawner's own slot/roster-cap bookkeeping. Scoped to
  allies only — the player keeps its own separate 5s respawn-at-the-keep system.
- **Emergency Patching → Triage Protocols** (engineer): once per WAVE, if this wall drops to 20%
  → 30% HP or lower, an engineer instantly patches 15% → 25% of its max HP back — a discrete,
  rare, bounded event, deliberately NOT routed through the steady per-tick repair budget/cap
  above, so it can never raise the sustained hp/sec ceiling that guarantee depends on.

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
| 11+ | Endless scaling: counts ×(1 + 0.15·(n−10)), HP ×(1 + 0.12·(n−10)), speed +1%/wave (cap +30%), gold ×(1 + 0.09·(n−10)); composition rotates through waves 8/9/10's templates, so flyers (and the Orc Warlord) keep recurring and scaling up forever, not just once |

**Economy retune (late-game ability Mastery task, 2026-08-27).** `goldGrowth` moved from 0.05 to
0.09. The threat pool a player has to burn through each wave is count×hp; at the old 0.05, kill-
gold income (count×gold) badly lagged it: at waves 20/30/40 the threat pool sits at 5.5x/13.6x/25x
its wave-10 baseline while income only tracked 2.5x/4.0x/5.5x — gold was effectively capped
against an unbounded threat curve, the root cause of Mastery trees' 600-1600g nodes otherwise
being unreachable. At 0.09, income tracks ~4.75x/11.2x/20.35x at those same waves — close enough
to the threat curve that a dedicated player can afford real Mastery investment by the time the
game demands it, while staying meaningfully below 1:1 so the escalating difficulty curve the whole
endless mode is built on stays real. See `src/data/waves.ts`'s `ENDLESS` doc comment for the exact
per-wave numbers this task's report worked from.

## Controls

| Input | Action |
|---|---|
| Mouse look (pointer lock) | Aim |
| WASD or Arrow keys / Space | Move / jump |
| W / S at a ladder | Climb up / down — walking into a usable ladder grabs it automatically instead of bonking into the wall; strafe (A/D) to let go, or just reach the top/bottom |
| LMB | Primary attack / confirm ground-target cast (Archer: hold to draw the bow, release to loose — see Archer primary) |
| 2, 3, 4 | Use class abilities — ground-targeted ones (including Grapple Hook) arm a decal reticle first and confirm with LMB, aimed ones cast instantly (varies by class, see Player & classes). Grapple Hook's confirm additionally needs a real walkable anchor in range, or it whiffs. Warrior's Leap is the one exception: it's directional, not targeted — pressing its key launches you along your current facing immediately, no reticle at all |
| RMB | Cancel ability targeting |
| Esc | Pause (also cancels ability targeting). Losing pointer lock at all — alt-tab, clicking away — pauses too |
| E | Socket menu (build/upgrade structure in the socket you're near) |
| B | Castle menu (build/repair wall tiers) |
| Tab | Class upgrade menu |
| G | Start next wave (intermission) |
| P | Playground tools (only in playground mode) |

## Pausing and saving

**Esc pauses.** More precisely, *losing pointer lock* pauses: the browser eats the Esc keypress
itself to release the mouse and never delivers it to the page, so a key handler alone would need
Esc pressed twice. Treating "the pointer got away" as "pause" is the right rule regardless —
without the lock you can't look or aim, so alt-tabbing or clicking away shouldn't let a wave eat
the keep while you're gone. The pause overlay is translucent so the frozen battlefield stays
visible behind it, and offers **Resume**, **Quit to main menu**, and **Restart run**. Opening the
castle/socket/class menus does *not* pause; those are a normal part of the build phase.

Pausing freezes `game.time` itself, not just the tick loop — every deadline in the game (ability
cooldowns, respawn timers, wave spawn schedule, damage-over-time flushes) is an absolute
comparison against it, so a pause that let time run would quietly burn all of them at once.

**Your run saves itself, and only during the build phase.** Progress lives in browser storage
(not a cookie — see saveStorage.ts), so closing the tab and coming back later offers a **Continue
run** card on the title screen showing the wave, class, gold and structures you left behind, next
to **Discard run**. Starting a new run replaces the saved one, and dying clears it.

A snapshot holds **progression only**: gold, wave reached, walls and their upgrades, structures
and theirs, and your class, ranks and mastery nodes. It holds no live combat state, so resuming
always puts you at the **start of the build phase for the wave you were on** — quit mid-wave and
you re-fight that wave rather than resuming frozen mid-swing. Two deliberate consequences:

- Saving *only* in the build phase is what keeps this honest. If combat wrote saves too, gold
  earned partway through a wave you'd then replay would bank permanently, turning quit-and-resume
  into a gold farm.
- Restoring **replays your purchases** through the same APIs the menus call rather than writing
  state back directly, so everything derived — expansion sockets, structure internals, rebuilt
  meshes, battlement collision — comes back exactly as if you'd bought it by hand.

Playground runs never save; they're explicitly not scored.

## Future (out of scope for v1, design toward it)

- More classes (Cleric...), more structures/enemies, boss variety
- **Multiplayer**: co-op party defense. The simulation is built for it now — see ARCHITECTURE.md (deterministic fixed tick, command-based input, seeded RNG, multi-player state list).
- Desktop packaging (Tauri/Electron), audio, cross-device meta-progression (per-run saving now exists — see Pausing and saving)
