import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { Enemy, PlayerClassDef, PlayerState } from '../sim/types';
import type { AbilityWithTree } from '../sim/abilityTree';
import { clampToPlayfield, pullPlayer } from '../player/controller';
import { actionState } from '../player/actionState';
import { muzzlePoint } from '../sim/projectiles';
import { applyVulnerability } from '../sim/abilityEffects';
import { grappleTree, pinningShotTree, piercingShotTree, quickshotTree } from './archerTree';

// Grapple pull tuning. Both constant across ranks (only `range` varies by rank, kept as a rank
// stat since it's the one number the Tab upgrade menu should actually show), so neither needs to
// be a rank stat — a bare stat key with no entry in ui/menus.ts's STAT_LABELS would just render
// as raw camelCase there, and these two never change per rank anyway.
const GRAPPLE_PULL_SPEED = 30; // units/s — fast enough to read as a yank, not a saunter
const GRAPPLE_COOLDOWN = 10;
const PULL_TIMEOUT_MARGIN = 1; // seconds added on top of the ideal (distance/speed) travel time

/** Archer class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  Identity: sustained single-target ranged DPS that rewards aim rather than area denial —
 *  a fast/flat/cheap primary, a heavy piercing skillshot for lining up multiple targets, a
 *  precision snare that locks down one problem enemy, and a grappling hook for mobility.
 *  Deliberately has zero ground-targeted AoE nukes, so it never reads as a Fireball reskin.
 *  cast() implementations are sim-side only: projectiles + state, no rendering. Every ability
 *  also carries a late-game "Mastery" tree (data/archerTree.ts) hanging off its linear ranks. */

/** Hold-to-draw primary (see types.ts's `charge` doc comment): mousedown in casting.ts starts
 *  the draw, mouseup looses it and passes the drawn fraction through as `stats.charge` (floored
 *  at `minRelease` so a snap-release still fires a real, if weak, shot — never literally 0).
 *  Both damage and arrow speed scale by the same fraction, so a snap shot is a weak, floaty
 *  plink and a full draw is the real shot. `moveSpeedMult` slows the Archer while drawing —
 *  can't sprint while pulling a bowstring — tuned gentle enough to still reposition, not so
 *  gentle it's free to draw-and-kite at full speed. */
const QUICKSHOT_COOLDOWN = 0.3;
const quickshot: AbilityWithTree = {
  id: 'quickshot',
  name: 'Quickshot',
  desc: 'Hold to draw, release to loose. A snap-release is a weak plink; a full draw is the real shot.',
  icon: '🏹',
  targeting: 'aimed',
  cooldown: QUICKSHOT_COOLDOWN, // starts on release, not on press — draw time (0.7s) is the real pacing limiter
  charge: {
    drawTime: 0.7, // seconds held to reach 100% power
    minRelease: 0.35, // snap-release floor: 35% damage/speed even at 0 held time
    moveSpeedMult: 0.55, // 55% move speed while drawing
  },
  ranks: [
    { cost: 0, stats: { damage: 12, speed: 55 } },
    { cost: 40, stats: { damage: 18 } },
    { cost: 80, stats: { damage: 25 } },
    { cost: 140, stats: { damage: 34 } },
    // Rank V (late-game gold sink, unlocks behaviour): "Rapid Volley" — goes fully automatic.
    // The draw itself is unchanged (still 0.7s to reach full power, still a weak plink on an
    // early release), but if you hold through a *full* draw instead of releasing, player/
    // casting.ts locks the bow at full power and keeps firing every 0.3s cooldown for as long
    // as you hold — no redraw between shots (~3.3x the sustained attack rate, offset by a
    // slight per-shot damage cut). See casting.ts's `autoFiringId` path — driven entirely by
    // this generic `autoFire` stat, nothing archer-specific there.
    { cost: 220, stats: { damage: 30, autoFire: 1 } },
    // Ranks VI-X: full-auto stays, the per-shot damage climbs hard. Sustained rate is already
    // ~3.3x from autoFire, so these ranks compound with it rather than adding another mechanic.
    { cost: 600, stats: { damage: 44 } },
    { cost: 1500, stats: { damage: 64, aoeRadius: 2 } },
    { cost: 3500, stats: { damage: 92, aoeRadius: 2.6, chainJumps: 1, chainRadius: 5, chainFalloff: 0.6 } },
    { cost: 7500, stats: { damage: 132, aoeRadius: 3.2, chainJumps: 2 } },
    { cost: 16000, stats: { damage: 190, aoeRadius: 4, chainJumps: 3, chainRadius: 7 } },
  ],
  tree: quickshotTree,
  cast(game: GameState, caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const charge = stats.charge ?? 1; // absent only if something calls this without a draw; default full power
    const dir = aimPoint.clone().sub(origin).normalize();
    const speedMult = stats.projSpeedMult ?? 1;
    game.projectiles.spawn({
      pos: muzzlePoint(game, origin, dir, 0.8),
      vel: dir.multiplyScalar(stats.speed * charge * speedMult),
      team: 'defender',
      damage: stats.damage * charge,
      radius: stats.aoeRadius ? 0.4 : 0.25,
      aoeRadius: stats.aoeRadius, // Ballistic Rounds/Siege Rounds
      kind: stats.aoeRadius ? 'cannonball' : 'arrow',
      onImpact: stats.chainJumps
        ? (g: GameState, at: Vector3) => {
            // Storm/Tempest Quiver: find the enemy that was actually hit (onImpact only gets a
            // position), then chain outward exactly like the Arc Lightning tower does.
            let current: Enemy | null = null;
            let bestD = 1.5;
            for (const e of g.enemies) {
              if (!e.alive) continue;
              const d = e.pos.distanceTo(at);
              if (d < bestD) {
                bestD = d;
                current = e;
              }
            }
            if (!current) return;
            const hit = new Set<number>([current.id]);
            let dmg = stats.damage * charge * stats.chainFalloff;
            for (let jump = 0; jump < stats.chainJumps; jump++) {
              let next: Enemy | null = null;
              let bestJump = stats.chainRadius;
              for (const e of g.enemies) {
                if (!e.alive || hit.has(e.id)) continue;
                const d = e.pos.distanceTo(current!.pos);
                if (d < bestJump) {
                  bestJump = d;
                  next = e;
                }
              }
              if (!next) break;
              next.takeDamage(dmg, g);
              g.projectiles.impacts.push({ pos: next.pos.clone(), kind: 'lightning', aoe: false });
              hit.add(next.id);
              current = next;
              dmg *= stats.chainFalloff;
            }
          }
        : undefined,
    });
    if (stats.fireRateMult) {
      // Ballistic/Siege Rounds: full-auto fires slower to pay for the guaranteed splash.
      // tryCast() already set the normal 0.3s cooldown before this cast() ran — stretch it.
      caster.cooldowns['quickshot'] = game.time + QUICKSHOT_COOLDOWN / stats.fireRateMult;
    }
  },
};

/** A heavy skillshot: single heavy arrow that pierces through multiple enemies in a line.
 *  Rewards lining up a shot down a lane of enemies instead of dropping an AoE on a point —
 *  the ranged-DPS answer to Fireball that stays true to "aim, don't area-deny". Reuses the
 *  'ballista' render kind for a bigger, glowing look distinct from Quickshot's plain arrow. */
const PIERCING_SHOT_RANGE = 60; // matches casting.ts's own aimed-ability fallback (def.castRange ?? 60)
// ---- Steady Aim (skill combo: loose Piercing Shot without releasing your draw) ----
// Hotkey abilities already don't cancel an in-progress bow draw, so a player who knows the kit can
// hold a charge and weave Piercing Shot mid-draw. That was mechanically possible but unrewarded;
// now the shot borrows the steadiness of the draw being held. Costs nothing but knowing to do it,
// and takes nothing from a player who doesn't — an un-drawn shot is exactly what it always was.
const STEADY_AIM_MAX_BONUS = 0.5; // +50% damage at a full draw

const piercingShot: AbilityWithTree = {
  id: 'piercingShot',
  name: 'Piercing Shot',
  desc: 'A heavy arrow that punches through everything in its path. Loosed mid-draw, it borrows your bow\u2019s steadiness for extra damage.',
  icon: '🎯',
  targeting: 'aimed',
  cooldown: 4.5,
  ranks: [
    { cost: 0, stats: { damage: 55, pierce: 1, speed: 55 } },
    { cost: 40, stats: { damage: 80, pierce: 2 } },
    { cost: 80, stats: { damage: 115 } },
    { cost: 140, stats: { damage: 155, pierce: 3 } },
    // Rank V (late-game gold sink, unlocks behaviour): "Lancing Shot" — pierce count stops
    // being a real limit (99 is far past any lane's population), so the arrow now punches
    // through the entire line instead of stopping after a handful of enemies. No cast() change
    // needed: pierce was already forwarded straight to the projectile spec.
    { cost: 220, stats: { damage: 190, pierce: 99 } },
    // Deep ranks: the shaft already pierces everything, so these add a detonation on each body
    // it passes through, and a mark that makes the whole kit hit the survivors harder.
    { cost: 400, stats: { damage: 270, explodeDamage: 80, explodeRadius: 3 } },
    { cost: 1000, stats: { damage: 380, explodeDamage: 140, explodeRadius: 4, markPct: 20, markDuration: 4 } },
    { cost: 2500, stats: { damage: 540, explodeDamage: 220, explodeRadius: 5 } },
    { cost: 6000, stats: { damage: 760, explodeDamage: 340, explodeRadius: 6.5, markPct: 35 } },
  ],
  tree: piercingShotTree,
  cast(game: GameState, _caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const dir = aimPoint.clone().sub(origin).normalize();
    if (stats.markPct) {
      // Hunter's/Predator's Mark: the projectile system only calls onImpact once, at the FINAL
      // hit — marking every enemy actually pierced needs a predictive line-trace up front,
      // using the same geometry Pinning Shot's hitscan already relies on.
      const hitRadius = 1.4;
      const candidates: { e: Enemy; t: number }[] = [];
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const toE = e.pos.clone().sub(origin);
        const t = toE.dot(dir);
        if (t < 0 || t > PIERCING_SHOT_RANGE) continue;
        const perpSq = toE.lengthSq() - t * t;
        const rr = hitRadius + e.radius;
        if (perpSq > rr * rr) continue;
        candidates.push({ e, t });
      }
      candidates.sort((a, b) => a.t - b.t);
      const maxHits = 1 + (stats.pierce ?? 0);
      for (let i = 0; i < Math.min(maxHits, candidates.length); i++) {
        applyVulnerability(candidates[i].e, game, 1 + stats.markPct / 100, stats.markDuration);
      }
    }
    // Steady Aim: scale with how far the bow is drawn RIGHT NOW, if a draw is in progress. This
    // reads presentation state, but it is the very value the player is watching on their own bow,
    // which is what makes the combo learnable rather than hidden.
    const drawn = actionState.chargingId !== null ? actionState.charge01 : 0;
    game.projectiles.spawn({
      pos: muzzlePoint(game, origin, dir, 0.8),
      vel: dir.clone().multiplyScalar(stats.speed),
      team: 'defender',
      damage: stats.damage * (1 + STEADY_AIM_MAX_BONUS * drawn),
      radius: 0.3,
      pierce: stats.pierce,
      kind: 'ballista',
      onImpact: stats.explodeRadius
        ? (g: GameState, at: Vector3) => {
            // Explosive Tip/Detonating Lance: the last thing the arrow touches detonates.
            const r2 = stats.explodeRadius * stats.explodeRadius;
            for (const e of g.enemies) {
              if (!e.alive) continue;
              const dx = e.pos.x - at.x;
              const dz = e.pos.z - at.z;
              if (dx * dx + dz * dz <= r2) e.takeDamage(stats.explodeDamage, g);
            }
            g.projectiles.impacts.push({ pos: at.clone(), kind: 'fireball', aoe: true, radius: stats.explodeRadius });
          }
        : undefined,
    });
  },
};

/** Precision single-target snare. 'aimed', but not a projectile — it's an instant hitscan
 *  math check (closest enemy whose body intersects the aim ray, the classic raycast-vs-line
 *  formula: perpendicular-distance-from-a-point-to-a-line), so it always hits exactly the one
 *  enemy you're actually looking at rather than whatever happens to be near a fixed far point.
 *  A single-target control tool — the opposite of Frost Field's ground-area slow — keeping
 *  the "aim, don't area-deny" identity all the way through the kit. */
// Crippling/Sundering Shot's stack tracker: local to this file (not sim/abilityEffects.ts) since
// it stacks a *vulnerability* rather than a fresh debuff type — same shape as Warrior's bleed
// stacking, just applied through applyVulnerability instead of a dps tick.
const crippleStacks = new WeakMap<Enemy, { n: number; until: number }>();

const pinningShot: AbilityWithTree = {
  id: 'pinningShot',
  name: 'Pinning Shot',
  desc: "Snare the single enemy you're aiming at, slowing it badly.",
  icon: '📌',
  targeting: 'aimed',
  cooldown: 8,
  ranks: [
    { cost: 0, stats: { damage: 8, slowPct: 55, duration: 3, range: 45 } },
    { cost: 40, stats: { damage: 12, slowPct: 65 } },
    { cost: 80, stats: { damage: 16, slowPct: 75, duration: 4 } },
    { cost: 140, stats: { damage: 20, slowPct: 85, duration: 4.5 } },
    // Deep ranks: one pinned target becomes a web that holds everything around it — the answer
    // to a column arriving in formation rather than to a single runner.
    { cost: 400, stats: { damage: 45, slowPct: 90, duration: 5.5 } },
    { cost: 1000, stats: { damage: 80, duration: 6.5, webRadius: 4, webSlowPct: 50 } },
    { cost: 2500, stats: { damage: 140, slowPct: 95, duration: 7.5, webRadius: 5.5, webSlowPct: 65 } },
    { cost: 6000, stats: { damage: 230, duration: 9, webRadius: 7, webSlowPct: 80 } },
  ],
  tree: pinningShotTree,
  cast(game: GameState, _caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const dir = aimPoint.clone().sub(origin).normalize();
    const hitRadius = 1.4;
    let best: Enemy | null = null;
    let bestT = Infinity;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const toE = e.pos.clone().sub(origin);
      const t = toE.dot(dir);
      if (t < 0 || t > stats.range) continue;
      const perpSq = toE.lengthSq() - t * t;
      const rr = hitRadius + e.radius;
      if (perpSq > rr * rr) continue;
      if (t < bestT) {
        bestT = t;
        best = e;
      }
    }
    if (best) {
      best.takeDamage(stats.damage, game);
      best.slowFactor = 1 - stats.slowPct / 100;
      best.slowUntil = game.time + stats.duration;
      game.projectiles.impacts.push({ pos: best.pos.clone(), kind: 'frost', aoe: false });

      if (stats.crippleStackPct) {
        const cur = crippleStacks.get(best);
        const stacks = Math.min(stats.crippleMaxStacks, (cur && game.time < cur.until ? cur.n : 0) + 1);
        crippleStacks.set(best, { n: stacks, until: game.time + stats.duration });
        applyVulnerability(best, game, 1 + (stats.crippleStackPct * stacks) / 100, stats.duration);
      }
      if (stats.webRadius) {
        // Web/Tangling of Arrows: a weaker slow spreads to anything near the marked target.
        const r2 = stats.webRadius * stats.webRadius;
        const webSlow = 1 - stats.webSlowPct / 100;
        for (const e of game.enemies) {
          if (!e.alive || e === best) continue;
          const dx = e.pos.x - best.pos.x;
          const dz = e.pos.z - best.pos.z;
          if (dx * dx + dz * dz > r2) continue;
          e.slowFactor = webSlow;
          e.slowUntil = game.time + stats.duration;
        }
      }
    }
  },
};

/** Mobility: a grappling hook that reels the Archer toward wherever the crosshair is pointing
 *  (per docs/GAME_DESIGN.md's mobility note) — a real pull over time, not a teleport. Keeps the
 *  normal ground-target arm/preview/confirm reticle flow (casting.ts) exactly like every other
 *  ground ability, but casting.ts additionally requires the confirm click to have found a *real*
 *  walkable anchor (wall top or ground) within range — role:'mobility' opts into that stricter
 *  check — so aiming at nothing (the sky, out of range) is a miss: toast, red flash, no cooldown
 *  spent, this cast() never runs. By the time we're here, aimPoint is guaranteed valid.
 *
 *  The pull itself is player/controller.ts's pullPlayer(): a controller-owned tick path that
 *  overrides normal movement and gravity, lerping straight toward the anchor at GRAPPLE_PULL_SPEED
 *  while clamping to the playfield and never sinking below the walkable surface (so it rides up
 *  and over a raised ledge instead of clipping into it), arriving on top of the anchor. `timeout`
 *  is the safety valve — sized to the ideal travel time (distance/GRAPPLE_PULL_SPEED) plus a
 *  margin, so a pull can never strand the player even in some future edge case. Longer range and
 *  shorter cooldown than Blink — a Ranger kites and repositions far more often than a Mage
 *  teleports. Pure repositioning, no damage. */
const grapple: AbilityWithTree = {
  id: 'grapple',
  name: 'Grapple Hook',
  desc: 'Fire at whatever you’re aiming at and get reeled toward it at high speed.',
  icon: '🪝',
  targeting: 'ground',
  cooldown: GRAPPLE_COOLDOWN,
  castRange: 38,
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { range: 26 } },
    { cost: 40, stats: { range: 30 } },
    { cost: 80, stats: { range: 34 } },
    { cost: 140, stats: { range: 38 } },
    // Deep ranks: longer reach, a faster reel, and a piton that detonates where it bites.
    { cost: 400, stats: { range: 44, pullSpeedMult: 1.2 } },
    { cost: 1000, stats: { range: 50, cooldownMult: 0.8, pitonDamage: 90, pitonRadius: 4 } },
    { cost: 2500, stats: { range: 58, pullSpeedMult: 1.5, pitonDamage: 160, pitonPull: 3 } },
    { cost: 6000, stats: { range: 68, cooldownMult: 0.6, pitonDamage: 280, pitonRadius: 6, pitonPull: 4 } },
  ],
  tree: grappleTree,
  cast(game: GameState, caster: PlayerState, _origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const { x, z } = clampToPlayfield(game, aimPoint.x, aimPoint.z);
    const y = game.castle.worldHeight(x, z);

    if (stats.pitonRadius) {
      // Piton/Harpoon Shot: an enemy near the anchor gets struck and yanked toward the caster
      // instead of the caster being pulled toward the anchor — offense instead of traversal.
      const r2 = stats.pitonRadius * stats.pitonRadius;
      let hitAny = false;
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - x;
        const dz = e.pos.z - z;
        if (dx * dx + dz * dz > r2) continue;
        hitAny = true;
        e.takeDamage(stats.pitonDamage, game);
        const toCaster = caster.pos.clone().sub(e.pos);
        const dist = toCaster.length();
        if (dist > 0.01) {
          e.pos.addScaledVector(toCaster.normalize(), Math.min(stats.pitonPull, dist));
        }
      }
      game.projectiles.impacts.push({ pos: new Vector3(x, y, z), kind: 'grapple', aoe: false });
      if (hitAny) {
        if (stats.cooldownMult) caster.cooldowns['grapple'] = game.time + GRAPPLE_COOLDOWN * stats.cooldownMult;
        return; // struck an enemy — no self-pull this cast
      }
    }

    const dist = caster.pos.distanceTo(new Vector3(x, y, z));
    const pullSpeed = GRAPPLE_PULL_SPEED * (stats.pullSpeedMult ?? 1);
    const timeout = dist / pullSpeed + PULL_TIMEOUT_MARGIN;

    // The viewmodel draws a rope from the bow to this anchor for the duration of the pull.
    actionState.grappleAnchor = new Vector3(x, y, z);
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'grapple', aoe: false });

    if (stats.cooldownMult) caster.cooldowns['grapple'] = game.time + GRAPPLE_COOLDOWN * stats.cooldownMult;

    pullPlayer(x, y, z, pullSpeed, timeout, () => {
      // Fires on arrival, on timeout, or if the pull gets interrupted (e.g. death) — always —
      // so the rope never gets left hanging.
      actionState.grappleAnchor = null;
      game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'grapple', aoe: false });
    });
  },
};

export const ARCHER: PlayerClassDef = {
  id: 'archer',
  name: 'Archer',
  desc: 'Ranged skirmisher: fast flat shots, a piercing heavy arrow, a precision snare, and a grappling hook.',
  maxHp: 80,
  moveSpeed: 6.5,
  primary: quickshot,
  abilities: [piercingShot, pinningShot, grapple],
};
