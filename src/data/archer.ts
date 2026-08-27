import { Vector3 } from 'three';
import type { GameState } from '../sim/GameState';
import type { AbilityDef, Enemy, PlayerClassDef, PlayerState } from '../sim/types';
import { clampToPlayfield, pullPlayer } from '../player/controller';
import { actionState } from '../player/actionState';
import { muzzlePoint } from '../sim/projectiles';

// Grapple pull tuning. Both constant across ranks (only `range` varies by rank, kept as a rank
// stat since it's the one number the Tab upgrade menu should actually show), so neither needs to
// be a rank stat — a bare stat key with no entry in ui/menus.ts's STAT_LABELS would just render
// as raw camelCase there, and these two never change per rank anyway.
const GRAPPLE_PULL_SPEED = 30; // units/s — fast enough to read as a yank, not a saunter
const PULL_TIMEOUT_MARGIN = 1; // seconds added on top of the ideal (distance/speed) travel time

/** Archer class definition. Owned by [player-classes]. Balance per docs/GAME_DESIGN.md.
 *  Identity: sustained single-target ranged DPS that rewards aim rather than area denial —
 *  a fast/flat/cheap primary, a heavy piercing skillshot for lining up multiple targets, a
 *  precision snare that locks down one problem enemy, and a grappling hook for mobility.
 *  Deliberately has zero ground-targeted AoE nukes, so it never reads as a Fireball reskin.
 *  cast() implementations are sim-side only: projectiles + state, no rendering. */

/** Hold-to-draw primary (see types.ts's `charge` doc comment): mousedown in casting.ts starts
 *  the draw, mouseup looses it and passes the drawn fraction through as `stats.charge` (floored
 *  at `minRelease` so a snap-release still fires a real, if weak, shot — never literally 0).
 *  Both damage and arrow speed scale by the same fraction, so a snap shot is a weak, floaty
 *  plink and a full draw is the real shot. `moveSpeedMult` slows the Archer while drawing —
 *  can't sprint while pulling a bowstring — tuned gentle enough to still reposition, not so
 *  gentle it's free to draw-and-kite at full speed. */
const quickshot: AbilityDef = {
  id: 'quickshot',
  name: 'Quickshot',
  desc: 'Hold to draw, release to loose. A snap-release is a weak plink; a full draw is the real shot.',
  icon: '🏹',
  targeting: 'aimed',
  cooldown: 0.3, // starts on release, not on press — draw time (0.7s) is the real pacing limiter
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
  ],
  cast(game: GameState, _caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const charge = stats.charge ?? 1; // absent only if something calls this without a draw; default full power
    const dir = aimPoint.clone().sub(origin).normalize();
    game.projectiles.spawn({
      pos: muzzlePoint(game, origin, dir, 0.8),
      vel: dir.multiplyScalar(stats.speed * charge),
      team: 'defender',
      damage: stats.damage * charge,
      radius: 0.25,
      kind: 'arrow',
    });
  },
};

/** A heavy skillshot: single heavy arrow that pierces through multiple enemies in a line.
 *  Rewards lining up a shot down a lane of enemies instead of dropping an AoE on a point —
 *  the ranged-DPS answer to Fireball that stays true to "aim, don't area-deny". Reuses the
 *  'ballista' render kind for a bigger, glowing look distinct from Quickshot's plain arrow. */
const piercingShot: AbilityDef = {
  id: 'piercingShot',
  name: 'Piercing Shot',
  desc: 'A heavy arrow that punches through everything in its path.',
  icon: '🎯',
  targeting: 'aimed',
  cooldown: 4.5,
  ranks: [
    { cost: 0, stats: { damage: 55, pierce: 1, speed: 55 } },
    { cost: 40, stats: { damage: 80, pierce: 2 } },
    { cost: 80, stats: { damage: 115 } },
    { cost: 140, stats: { damage: 155, pierce: 3 } },
  ],
  cast(game: GameState, _caster: PlayerState, origin: Vector3, aimPoint: Vector3, stats: Record<string, number>) {
    const dir = aimPoint.clone().sub(origin).normalize();
    game.projectiles.spawn({
      pos: muzzlePoint(game, origin, dir, 0.8),
      vel: dir.multiplyScalar(stats.speed),
      team: 'defender',
      damage: stats.damage,
      radius: 0.3,
      pierce: stats.pierce,
      kind: 'ballista',
    });
  },
};

/** Precision single-target snare. 'aimed', but not a projectile — it's an instant hitscan
 *  math check (closest enemy whose body intersects the aim ray, the classic raycast-vs-line
 *  formula: perpendicular-distance-from-a-point-to-a-line), so it always hits exactly the one
 *  enemy you're actually looking at rather than whatever happens to be near a fixed far point.
 *  A single-target control tool — the opposite of Frost Field's ground-area slow — keeping
 *  the "aim, don't area-deny" identity all the way through the kit. */
const pinningShot: AbilityDef = {
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
  ],
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
const grapple: AbilityDef = {
  id: 'grapple',
  name: 'Grapple Hook',
  desc: 'Fire at whatever you’re aiming at and get reeled toward it at high speed.',
  icon: '🪝',
  targeting: 'ground',
  cooldown: 10,
  castRange: 38,
  role: 'mobility',
  ranks: [
    { cost: 0, stats: { range: 26 } },
    { cost: 40, stats: { range: 30 } },
    { cost: 80, stats: { range: 34 } },
    { cost: 140, stats: { range: 38 } },
  ],
  cast(game: GameState, caster: PlayerState, _origin: Vector3, aimPoint: Vector3, _stats: Record<string, number>) {
    const { x, z } = clampToPlayfield(game, aimPoint.x, aimPoint.z);
    const y = game.castle.worldHeight(x, z);
    const dist = caster.pos.distanceTo(new Vector3(x, y, z));
    const timeout = dist / GRAPPLE_PULL_SPEED + PULL_TIMEOUT_MARGIN;

    // The viewmodel draws a rope from the bow to this anchor for the duration of the pull.
    actionState.grappleAnchor = new Vector3(x, y, z);
    game.projectiles.impacts.push({ pos: caster.pos.clone(), kind: 'grapple', aoe: false });

    pullPlayer(x, y, z, GRAPPLE_PULL_SPEED, timeout, () => {
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
