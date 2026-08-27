import type { GameState } from '../sim/GameState';
import type { PlayerState } from '../sim/types';
import { createPlayer } from '../sim/classes';
import { MAGE } from '../data/mage';
import { ENEMY_SPAWN_Z, STAIR_LENGTH, WALL_THICKNESS, WALL_Z } from '../data/castle';
import { getSelectedClass } from './classSelect';
import { R } from '../render/scene';

/** Owned by [player-classes]. First-person controller: pointer lock, mouse look (yaw/pitch),
 *  WASD relative to yaw, Space jump, gravity, ground clamp via game.castle.worldHeight.
 *  Step-up rule: ground more than STEP_UP above the feet is an obstacle — that is what makes
 *  wall sides solid while ramps/wall tops stay walkable. Stepping *down* (off a wall's front
 *  edge, or down a stair ramp) is never blocked by this rule — only gravity and the ground
 *  clamp govern it — so walking off a wall into the field or descending a ramp both just work.
 *  Field boundary: MIN_X/MAX_X/MIN_Z/MAX_Z (see clampToPlayfield) form a fixed box that no
 *  longer depends on wall state — a player can walk or blink past every wall and fight in the
 *  open field. Only a far-field Z limit remains, well short of the enemy spawn gate.
 *  Multiplayer readiness: held keys are converted to a per-tick move command that is applied
 *  inside tick() (what a server would replay); mouse look writes yaw/pitch directly.
 *
 *  Two mobility overrides live here alongside plain WASD, both driven purely by game.time/dt
 *  (no wall-clock) so they replay identically for a future server:
 *   - launchPlayer(): a real ballistic jump (Warrior's Leap). Sets a persistent horizontal
 *     "launch velocity" that WASD input cannot touch until landing (a naive one-tick impulse
 *     would otherwise be overwritten next tick, since normal movement is velocity-set-per-tick
 *     with no inertia) and reuses the existing gravity/ground-collision code so landing, the
 *     wall step-up check, and the playfield clamp all apply exactly as they do to walking.
 *   - pullPlayer(): a reel-in (Archer's Grapple). A separate tick path that overrides movement
 *     AND gravity entirely — a straight-line lerp toward the anchor, clamped to never sink below
 *     the walkable surface (so it rides up and over a raised ledge instead of clipping into it)
 *     and bounded by a deadline so it can never strand the player mid-pull. */

export const EYE_HEIGHT = 1.6;

const MOUSE_SENS = 0.0022; // rad per px
const PITCH_LIMIT = (85 * Math.PI) / 180;
const JUMP_SPEED = 4.5;
const GRAVITY = 14;
const STEP_UP = 0.6; // max walkable rise; taller = obstacle (wall sides)
const SNAP_DOWN = 0.5; // stick to ground walking down ramps
const SKIN = 0.35; // horizontal probe padding so the camera doesn't clip into wall faces
// Pull (grapple) tuning: how close counts as "arrived" (avoids asymptotic floating-point creep
// on the final lerp step — the anchor itself is always a walkable point, worldHeight-derived, so
// snapping onto it exactly is safe, this is purely a stop-iterating threshold, not a deliberate
// undershoot).
const PULL_ARRIVE_EPS = 0.15;
const MIN_X = -23;
const MAX_X = 23; // 3 units beyond the walls' x=[-20,20] span at every tier — the flank sally lanes
// Rear limit, derived rather than hardcoded: the keep's back stair ramp lands at
// WALL_Z[3] + WALL_THICKNESS + STAIR_LENGTH, and its barracks sits a little short of that.
// A literal here silently broke once when the walls were thickened and the landing moved out
// past it, clamping the player short of the bottom of their own stairs.
const REAR_MARGIN = 5;
const MAX_Z = WALL_Z[3] + WALL_THICKNESS + STAIR_LENGTH + REAR_MARGIN;
// Field boundary (forward limit): the player may leave the castle entirely — walk around a
// wall's flanks or jump off its front edge — and fight in the open field. FAR_FIELD_MARGIN keeps
// them a comfortable distance short of the enemy spawn gate (ENEMY_SPAWN_Z = -80) so nobody can
// camp the gate and snipe enemies the instant they spawn; 30 puts the limit at z = -50, i.e. 50
// units past the outermost wall (z=0) but still 30 short of the gate.
const FAR_FIELD_MARGIN = 30;
const MIN_Z = ENEMY_SPAWN_Z + FAR_FIELD_MARGIN; // -50

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);

/** True while any UI menu/screen is open (owned by the UI module via body dataset). */
export const isMenuOpen = (): boolean => document.body.dataset.menuOpen === '1';

/** Read-only motion info for the viewmodel (walk bob etc.). Updated every sim tick. */
export const playerMotion = { velX: 0, velY: 0, velZ: 0, grounded: true };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The same field-boundary box applyMove() enforces every tick, exposed so any ability that
 *  repositions its caster directly (a mobility ability's teleport/leap/grapple) can clamp its
 *  destination to it instead of duplicating the rule. The box is a fixed shape independent of
 *  wall state (see MIN_X/MAX_X/MIN_Z/MAX_Z above) — the whole point of the field boundary is
 *  that the field is now legal territory for both walking and mobility abilities, so a mobility
 *  ability like Blink can fling the player deep into the field, same as walking there on foot.
 *  `game` is unused now that the box no longer depends on castle state; it's kept as a parameter
 *  only so this stays source-compatible with data/mage.ts's call site (owned by another agent).
 *  Declared as a function (not a const arrow) so it's safely usable from data/mage.ts even though
 *  that creates an import cycle (mage.ts -> controller.ts -> mage.ts): function declarations are
 *  hoisted and fully bound before either module's body runs, so the cycle resolves fine at both
 *  the type and the runtime level. */
export function clampToPlayfield(_game: GameState, x: number, z: number): { x: number; z: number } {
  return { x: clamp(x, MIN_X, MAX_X), z: clamp(z, MIN_Z, MAX_Z) };
}

let resetFallHook: (() => void) | null = null;

/** Zero the controller's internal vertical velocity and mark the player grounded. Call this
 *  right after an ability sets PlayerState.pos directly (teleport etc.) so leftover fall
 *  velocity from before the cast doesn't yank the player back down through the floor they
 *  just landed on. initPlayer() wires the hook; a no-op before that (shouldn't happen — no
 *  ability can be cast before the player controller exists). */
export function resetFall(): void {
  resetFallHook?.();
}

let launchHook:
  | ((dirX: number, dirZ: number, hSpeed: number, vSpeed: number, onLand?: () => void) => void)
  | null = null;

/** Launch the player on a real ballistic arc (Warrior's Leap): an instant, directional jump —
 *  no reticle, no confirm click. `dirX`/`dirZ` need not be normalized (normalized internally).
 *  Horizontal velocity is held constant for the whole flight in a persistent closure variable
 *  the normal WASD path can't touch (see the module doc comment for why a naive one-tick impulse
 *  would be erased); vertical velocity reuses the same gravity integration as jumping/falling, so
 *  landing, the wall step-up check, and the playfield clamp all apply automatically. `onLand`
 *  fires exactly once, the tick the player's feet actually touch ground again — never on a timer
 *  — so the caller can time landing AoE damage to the real touchdown. Safe to call at any time;
 *  cancels (and finalizes, via its own onLand/onArrive) any in-flight pull first so the two
 *  mobility overrides can never fight over player position in the same tick. */
export function launchPlayer(
  dirX: number,
  dirZ: number,
  horizontalSpeed: number,
  verticalSpeed: number,
  onLand?: () => void
): void {
  launchHook?.(dirX, dirZ, horizontalSpeed, verticalSpeed, onLand);
}

let pullHook:
  | ((tx: number, ty: number, tz: number, speed: number, timeout: number, onArrive?: () => void) => void)
  | null = null;

/** Reel the player toward (tx, ty, tz) at a constant `speed` (units/s), overriding both normal
 *  movement and gravity until they arrive (or `timeout` seconds elapse, whichever first — the
 *  safety valve that guarantees a pull can never strand the player forever; the caller should
 *  size it generously above the ideal travel time, e.g. distance/speed plus a margin). `onArrive`
 *  fires exactly once when the pull ends, for ANY reason (arrival, timeout, or an interruption
 *  like death) — always, so a caller that anchors presentation state (e.g. a rope-from-anchor
 *  visual) to the pull's lifetime can always clean it up. Safe to call at any time; cancels (and
 *  finalizes) any in-flight launch first, same reasoning as launchPlayer(). */
export function pullPlayer(
  targetX: number,
  targetY: number,
  targetZ: number,
  speed: number,
  timeout: number,
  onArrive?: () => void
): void {
  pullHook?.(targetX, targetY, targetZ, speed, timeout, onArrive);
}

let moveSpeedMultHook: ((mult: number) => void) | null = null;

/** Scale the player's normal WASD move speed by `mult` (1 = no change) until changed again.
 *  Generic knob with no opinion about *why* — casting.ts sets it from an ability's own
 *  `charge.moveSpeedMult` while a hold-to-draw attack is being drawn (e.g. the archer can't
 *  sprint while pulling a bowstring) and resets it to 1 the moment the draw ends for any reason.
 *  Has no effect on a launch/pull in progress (those don't use classDef.moveSpeed at all). */
export function setMoveSpeedMultiplier(mult: number): void {
  moveSpeedMultHook?.(mult);
}

export function initPlayer(game: GameState): void {
  // Class chosen on the start screen; MAGE is the fallback when that screen was skipped.
  const player = createPlayer(getSelectedClass() ?? MAGE);
  game.players.push(player);

  const canvas = R.renderer.domElement;
  const held = new Set<string>();
  let jumpQueued = false;
  let vy = 0;
  let grounded = true;
  let moveSpeedMult = 1;
  resetFallHook = () => {
    vy = 0;
    grounded = true;
  };
  moveSpeedMultHook = (mult) => {
    moveSpeedMult = mult;
  };

  // --- Leap (launch) state: a persistent horizontal velocity WASD cannot overwrite mid-flight,
  // plus the vertical speed handed to the shared vy/gravity integration below. ---
  let launching = false;
  let launchVX = 0;
  let launchVZ = 0;
  let launchOnLand: (() => void) | null = null;

  // --- Grapple (pull) state: overrides movement + gravity entirely until arrival/timeout. ---
  let pulling = false;
  let pullTX = 0;
  let pullTY = 0;
  let pullTZ = 0;
  let pullSpeed = 0;
  let pullDeadline = 0;
  let pullOnArrive: (() => void) | null = null;

  function endPull(): void {
    pulling = false;
    vy = 0;
    grounded = true;
    playerMotion.velX = playerMotion.velZ = playerMotion.velY = 0;
    playerMotion.grounded = true;
    const cb = pullOnArrive;
    pullOnArrive = null;
    cb?.();
  }

  function endLaunch(): void {
    launching = false;
    const cb = launchOnLand;
    launchOnLand = null;
    cb?.();
  }

  launchHook = (dirX, dirZ, hSpeed, vSpeed, onLand) => {
    if (pulling) endPull(); // the two overrides can't coexist — finalize whichever was running
    const len = Math.hypot(dirX, dirZ) || 1;
    launchVX = (dirX / len) * hSpeed;
    launchVZ = (dirZ / len) * hSpeed;
    vy = vSpeed;
    grounded = false;
    launching = true;
    launchOnLand = onLand ?? null;
  };

  pullHook = (tx, ty, tz, speed, timeout, onArrive) => {
    if (launching) endLaunch();
    pulling = true;
    pullTX = tx;
    pullTY = ty;
    pullTZ = tz;
    pullSpeed = speed;
    pullDeadline = game.time + timeout;
    pullOnArrive = onArrive ?? null;
    vy = 0;
    grounded = false;
  };

  /** One tick of the grapple reel-in: a straight-line lerp toward the anchor at a constant
   *  speed, clamped to the playfield box and never allowed to sink below the walkable surface —
   *  which is what makes it ride up and over a raised ledge (a wall top) instead of clipping
   *  into it, using the same height field the rest of movement uses. Ends on arrival or when
   *  the deadline passes, whichever comes first; either way endPull() always fires onArrive. */
  function tickPull(p: PlayerState, dt: number): void {
    if (!p.alive || game.time >= pullDeadline) {
      endPull();
      return;
    }
    const oldX = p.pos.x;
    const oldY = p.pos.y;
    const oldZ = p.pos.z;
    const dx = pullTX - oldX;
    const dy = pullTY - oldY;
    const dz = pullTZ - oldZ;
    const dist = Math.hypot(dx, dy, dz);
    const step = pullSpeed * dt;
    if (dist <= PULL_ARRIVE_EPS || step >= dist) {
      p.pos.set(pullTX, pullTY, pullTZ);
      endPull();
      return;
    }
    const s = step / dist;
    const { x: nx, z: nz } = clampToPlayfield(game, oldX + dx * s, oldZ + dz * s);
    let ny = oldY + dy * s;
    const ground = game.castle.worldHeight(nx, nz);
    if (ny < ground) ny = ground;
    p.pos.set(nx, ny, nz);

    playerMotion.velX = (nx - oldX) / dt;
    playerMotion.velZ = (nz - oldZ) / dt;
    playerMotion.velY = (ny - oldY) / dt;
    playerMotion.grounded = false;
  }

  const locked = () => document.pointerLockElement === canvas;

  // --- Pointer lock ---
  canvas.addEventListener('click', () => {
    if (isMenuOpen() || locked()) return;
    if (game.phase === 'menu' || game.phase === 'gameover') return;
    const ret = canvas.requestPointerLock() as unknown;
    (ret as Promise<void> | undefined)?.catch(() => {});
  });

  // --- Mouse look (writes PlayerState.yaw/pitch directly) ---
  document.addEventListener('mousemove', (e) => {
    const p = game.localPlayer;
    if (!p || !p.alive || !locked() || isMenuOpen()) return;
    p.yaw -= e.movementX * MOUSE_SENS;
    p.pitch = clamp(p.pitch - e.movementY * MOUSE_SENS, -PITCH_LIMIT, PITCH_LIMIT);
  });

  // --- Keys (held-state safe: keyup always clears, even while a menu is open) ---
  document.addEventListener('keydown', (e) => {
    if (isMenuOpen()) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) jumpQueued = true;
    }
    if (MOVE_KEYS.has(e.code)) held.add(e.code);
  });
  document.addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => held.clear());
  document.addEventListener('pointerlockchange', () => {
    if (!locked()) held.clear();
  });

  /** Apply one tick's movement command. Pure sim mutation — a co-op server would run this
   *  same function from a (forward, strafe, jump) command sent by the client. `launching` (a
   *  leap in flight) substitutes the persistent launch velocity for the WASD-derived one but
   *  otherwise reuses every bit of this function — horizontal step-up collision, the playfield
   *  clamp, and the vertical gravity/ground-collision integration — so a leap can never land
   *  outside clampToPlayfield's box or tunnel through a wall it didn't have the height to clear. */
  function applyMove(p: PlayerState, forward: number, strafe: number, jump: boolean, dt: number): void {
    if (!p.alive) {
      // Dead: frozen where they died until classes.ts respawns them at the keep. A leap in
      // flight when death happens (e.g. an arrow mid-air) is cancelled outright, not resolved —
      // there's no sensible landing spot to slam down at once you're already dead.
      if (launching) endLaunch();
      vy = 0;
      grounded = true;
      playerMotion.velX = playerMotion.velZ = playerMotion.velY = 0;
      return;
    }

    let mx: number;
    let mz: number;
    if (launching) {
      mx = launchVX;
      mz = launchVZ;
    } else {
      const speed = p.classDef.moveSpeed * moveSpeedMult;
      const sinY = Math.sin(p.yaw);
      const cosY = Math.cos(p.yaw);
      // camera basis on the ground plane: forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
      let rawX = -sinY * forward + cosY * strafe;
      let rawZ = -cosY * forward - sinY * strafe;
      const len = Math.hypot(rawX, rawZ);
      if (len > 0) {
        rawX = (rawX / len) * speed; // snappy: velocity set directly, no acceleration ramp
        rawZ = (rawZ / len) * speed;
      }
      mx = rawX;
      mz = rawZ;
    }

    // Horizontal, axis-separated so we slide along obstacles instead of sticking. The Z clamp is
    // the fixed field boundary (MIN_Z/MAX_Z) — not tied to wall state — so walking off a wall's
    // front edge or around its flanks into the field is unobstructed here; the step-up probe
    // below is what actually stops a player from climbing a wall face like a ramp (it only
    // rejects moves onto ground that rises more than STEP_UP, so stepping down is never blocked).
    // During a leap this is also what stops the arc short if it doesn't have the height to clear
    // whatever it's flying at — and, symmetrically, lets it sail straight through once its
    // altitude clears the STEP_UP tolerance, exactly like stepping onto a ledge.
    const castle = game.castle;
    if (mx !== 0) {
      const nx = clamp(p.pos.x + mx * dt, MIN_X, MAX_X);
      const probe = castle.worldHeight(nx + Math.sign(mx) * SKIN, p.pos.z);
      if (probe - p.pos.y <= STEP_UP) p.pos.x = nx;
    }
    if (mz !== 0) {
      const nz = clamp(p.pos.z + mz * dt, MIN_Z, MAX_Z);
      const probe = castle.worldHeight(p.pos.x, nz + Math.sign(mz) * SKIN);
      if (probe - p.pos.y <= STEP_UP) p.pos.z = nz;
    }

    // Vertical: jump, gravity, ground clamp (walkable heights come from the castle sim). A leap
    // never double-jumps off Space and always ends with the normal landing path below, so
    // onLand fires the tick the feet actually touch down — never on a timer.
    if (!launching && jump && grounded) {
      vy = JUMP_SPEED;
      grounded = false;
    }
    vy -= GRAVITY * dt;
    p.pos.y += vy * dt;
    const ground = castle.worldHeight(p.pos.x, p.pos.z);
    if (p.pos.y <= ground) {
      p.pos.y = ground;
      vy = 0;
      grounded = true;
      if (launching) endLaunch();
    } else if (!launching && grounded && vy <= 0 && p.pos.y - ground <= SNAP_DOWN) {
      p.pos.y = ground; // walking down a ramp: stay glued instead of micro-falling
      vy = 0;
    } else {
      grounded = false;
    }

    playerMotion.velX = mx;
    playerMotion.velZ = mz;
    playerMotion.velY = vy;
    playerMotion.grounded = grounded;
  }

  game.addSystem({
    tick(dt) {
      const p = game.localPlayer;
      if (!p) return;
      if (pulling) {
        tickPull(p, dt);
        return;
      }
      const canMove =
        p.alive &&
        locked() &&
        !isMenuOpen() &&
        (game.phase === 'build' || game.phase === 'combat');
      let forward = 0;
      let strafe = 0;
      let jump = false;
      if (canMove) {
        forward = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
        strafe = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
        jump = jumpQueued;
      }
      jumpQueued = false;
      applyMove(p, forward, strafe, jump, dt);
    },
    render() {
      const p = game.localPlayer;
      if (!p) return;
      // Camera at the eyes. While dead the position simply stops updating (input frozen),
      // so the camera stays where the player died until classes.ts respawns them.
      R.camera.position.set(p.pos.x, p.pos.y + EYE_HEIGHT, p.pos.z);
      R.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    },
  });
}
