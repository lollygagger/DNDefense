import type { GameState } from '../sim/GameState';
import type { PlayerState } from '../sim/types';
import type { LadderInfo } from '../sim/ladders';
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
 *     and bounded by a deadline so it can never strand the player mid-pull.
 *
 *  A third override, climbing, lives here too — not a mobility ABILITY (no cooldown, no class
 *  gating), but a movement MODE the plain WASD path itself falls into. Walking into a wall face
 *  the STEP_UP rule would otherwise bounce you off of, right where sim/castle.ts's ladderAt()
 *  says there's a usable ladder, grabs it instead of just stopping: gravity suspends, W/S (the
 *  same `forward` axis as walking) climbs up/down, and reaching the top deposits you cleanly on
 *  the wall walk (see tickClimb). Strafing (A/D) or the ladder becoming unusable mid-climb (a
 *  front ladder when combat starts, or the wall under it getting destroyed) both just let go —
 *  the player drops and falls under ordinary gravity from wherever they were, never teleported.
 *  Every other mobility override cancels an in-flight climb the same way it cancels a rival
 *  override, and a direct pos.set() (Blink, via resetFall()) does too, so nothing can leave a
 *  stale climb pinned to a ladder the player is no longer anywhere near. */

export const EYE_HEIGHT = 1.6;

const MOUSE_SENS = 0.0022; // rad per px
const PITCH_LIMIT = (85 * Math.PI) / 180;
const JUMP_SPEED = 4.5;
const GRAVITY = 14;
const FLY_ASCEND_SPEED = 6.5; // units/s while Space is held during flight
// Descend is Shift, deliberately NOT Ctrl: Ctrl held together with the movement keys fires
// browser shortcuts (Ctrl+W closes the tab, Ctrl+S saves, Ctrl+A selects all), and flying while
// steering with WASD is exactly when that combination would happen. Shift has no such bindings.
const FLY_DESCEND_KEYS = ['ShiftLeft', 'ShiftRight'];
const FLY_DESCEND_SPEED = 7; // units/s while Shift is held — a touch faster than the climb, so
// dropping back into the fight feels decisive without being a free fall (gravity is 14).
const FLY_TAKEOFF_S = 0.4; // auto-ascend window at the start of a flight, so activating it lifts off
const STEP_UP = 0.6; // max walkable rise; taller = obstacle (wall sides)
const SNAP_DOWN = 0.5; // stick to ground walking down ramps
const SKIN = 0.35; // horizontal probe padding so the camera doesn't clip into wall faces
// Vertical speed while climbing a ladder — deliberately slower than every class's moveSpeed
// (6-6.5) so it reads as climbing, not walking turned sideways.
const CLIMB_SPEED = 3.6;
// How hard a strafe key has to be pressed to let go of a ladder mid-climb (see tickClimb). The
// raw strafe axis is always exactly -1/0/1 (see applyMove), so this just needs to be > 0.
const CLIMB_RELEASE_STRAFE = 0.4;
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

/** Movement keys. Arrow keys are full equivalents of WASD, not a lesser fallback — they drive
 *  the same `forward`/`strafe` axes, so they also steer ladder climbing and everything else
 *  built on those axes. */
const MOVE_FORWARD = ['KeyW', 'ArrowUp'];
const MOVE_BACK = ['KeyS', 'ArrowDown'];
const MOVE_LEFT = ['KeyA', 'ArrowLeft'];
const MOVE_RIGHT = ['KeyD', 'ArrowRight'];
const MOVE_KEYS = new Set([...MOVE_FORWARD, ...MOVE_BACK, ...MOVE_LEFT, ...MOVE_RIGHT]);

/** True while any UI menu/screen is open (owned by the UI module via body dataset). */
export const isMenuOpen = (): boolean => document.body.dataset.menuOpen === '1';

/** Read-only motion info for the viewmodel (walk bob etc.). Updated every sim tick. */
export const playerMotion = { velX: 0, velY: 0, velZ: 0, grounded: true };

/** Non-frozen ladder query, read off game.castle via a narrow local interface + cast — the same
 *  pattern render/castleView.ts uses for wallMerlonBonus (see docs/ARCHITECTURE.md). ladderAt
 *  isn't part of the frozen CastleApi (types.ts) since only this controller needs it. */
interface CastleLadders {
  ladderAt(x: number, y: number, z: number): LadderInfo | null;
}

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
/** Drive the player straight down hard (the Warrior's aerial Ground Slam). Expressed in terms of
 *  launchPlayer with no horizontal component and a negative vertical one, so it reuses the exact
 *  same gravity, ground-collision and landing-callback path a leap does — `onLand` fires the tick
 *  the feet actually touch down, which is what lets the slam resolve where the player really
 *  landed instead of on a timer. */
export function slamDown(speed: number, onLand?: () => void): void {
  launchPlayer(0, 0, 0, -Math.abs(speed), onLand);
}

let dashHook:
  | ((dirX: number, dirZ: number, speed: number, duration: number, onEnd?: () => void) => void)
  | null = null;

/** Drive the player in a flat horizontal dash (the Tank's Shield Charge): a fixed horizontal
 *  velocity held for `duration` seconds with NO vertical impulse, so it reads as a shoulder-barge
 *  along the ground rather than a jump.
 *
 *  This can't be expressed with launchPlayer(vSpeed = 0): that marks the player airborne, and the
 *  very next tick's gravity puts them straight back on the ground, which ends the launch (and
 *  fires its onLand) after a single frame. A dash therefore needs its own duration-driven state.
 *  Gravity and the ground clamp still run normally underneath, so a dash follows terrain, rides
 *  up stair ramps, and falls off ledges instead of flying. Horizontal collision, the step-up rule
 *  and the playfield clamp all apply exactly as they do to walking, so a dash can neither phase
 *  through a wall nor leave the map. `onEnd` fires exactly once when the dash finishes (or is
 *  cut short by another override taking over). */
export function dashPlayer(
  dirX: number,
  dirZ: number,
  speed: number,
  duration: number,
  onEnd?: () => void
): void {
  dashHook?.(dirX, dirZ, speed, duration, onEnd);
}

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

let flyHook: ((duration: number, ceiling: number, onEnd?: () => void) => void) | null = null;

/** Suspend gravity for `duration` seconds: the player hovers, keeps full WASD control at normal
 *  move speed, and rises while Space is held, up to an absolute world-Y `ceiling`.
 *
 *  The fourth movement shape, alongside launch/pull/dash — and the only one that hands control
 *  back to the player for its whole duration instead of playing out a fixed trajectory. That is
 *  the point of it: it exists so the Warlock can pick a spot above a horde and stay there,
 *  channelling, rather than being flung to a destination.
 *
 *  Bounded on purpose. The ceiling is absolute (not relative to the ground underfoot), so taking
 *  off from a wall top can't stack altitude on top of the wall's own height; the ground clamp
 *  still applies underneath, so flight can't sink through terrain; and the playfield clamp and
 *  horizontal wall collision run exactly as they do while walking, so flying can't leave the map
 *  or phase through a wall — only over one. Shift descends (see FLY_DESCEND_KEYS); the flight
 *  window itself is still fixed, so coming down early costs you the remaining time rather than
 *  banking it. `onEnd` fires exactly once, for any reason including death or another movement
 *  override taking over. */
export function flyPlayer(duration: number, ceiling: number, onEnd?: () => void): void {
  flyHook?.(duration, ceiling, onEnd);
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
    // A direct pos.set() (Blink) must not leave a stale climb pinned to the ladder the player
    // was on before teleporting — see the module doc comment.
    climbing = false;
    if (dashing) endDash();
    if (flying) endFly();
  };
  moveSpeedMultHook = (mult) => {
    moveSpeedMult = mult;
  };

  // --- Leap (launch) state: a persistent horizontal velocity WASD cannot overwrite mid-flight,
  // plus the vertical speed handed to the shared vy/gravity integration below. ---
  let launching = false;
  let dashing = false;
  let dashVX = 0;
  let dashVZ = 0;
  let dashLeft = 0;
  let dashOnEnd: (() => void) | null = null;
  let launchVX = 0;
  let launchVZ = 0;
  let launchOnLand: (() => void) | null = null;

  // --- Flight state: gravity suspended for a fixed window, horizontal input untouched. The
  // takeoff timer auto-ascends for the first moment so activating it visibly lifts you off the
  // ground instead of leaving you standing there until you happen to press Space. ---
  let flying = false;
  let flyLeft = 0;
  let flyCeiling = 0;
  let flyTakeoffLeft = 0;
  let flyOnEnd: (() => void) | null = null;

  // --- Grapple (pull) state: overrides movement + gravity entirely until arrival/timeout. ---
  let pulling = false;
  let pullTX = 0;
  let pullTY = 0;
  let pullTZ = 0;
  let pullSpeed = 0;
  let pullDeadline = 0;
  let pullOnArrive: (() => void) | null = null;

  // --- Climb (ladder) state: gravity suspended, x/z locked to the ladder, y under direct
  // control. Not driven by a hook like launch/pull (nothing casts it) — plain WASD falls into
  // it by itself when it walks into a usable ladder; see applyMove's horizontal-collision block
  // and the module doc comment. ---
  let climbing = false;
  let climbX = 0;
  let climbZ = 0;
  let climbTopY = 0;
  let climbDismountZ = 0;

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

  function endFly(): void {
    if (!flying) return;
    flying = false;
    // Left airborne with zero vertical speed: the normal gravity path below takes over from here
    // and the player falls from wherever they were, landing through the usual ground clamp.
    vy = 0;
    grounded = false;
    const cb = flyOnEnd;
    flyOnEnd = null;
    cb?.();
  }

  function endLaunch(): void {
    launching = false;
    const cb = launchOnLand;
    launchOnLand = null;
    cb?.();
  }

  /** Let go of the ladder wherever the player currently is — used both by a deliberate exit
   *  (reaching the top/bottom, strafing off) and an involuntary one (the ladder stops being
   *  usable mid-climb). Never repositions the player: gravity resuming from the exact height
   *  they let go at is the "drop, don't teleport" rule from the module doc, applied uniformly. */
  function endClimb(grounded_: boolean): void {
    climbing = false;
    grounded = grounded_;
    if (grounded) vy = 0;
  }

  function endDash(): void {
    dashing = false;
    const cb = dashOnEnd;
    dashOnEnd = null;
    cb?.();
  }

  dashHook = (dirX, dirZ, speed, duration, onEnd) => {
    if (flying) endFly();
    if (pulling) endPull();
    if (climbing) endClimb(false);
    if (launching) endLaunch();
    if (dashing) endDash(); // finalize a dash already running before starting another
    const len = Math.hypot(dirX, dirZ) || 1;
    dashVX = (dirX / len) * speed;
    dashVZ = (dirZ / len) * speed;
    dashLeft = duration;
    dashing = true;
    dashOnEnd = onEnd ?? null;
  };

  flyHook = (duration, ceiling, onEnd) => {
    if (dashing) endDash();
    if (pulling) endPull();
    if (launching) endLaunch();
    if (climbing) endClimb(false); // let go of the ladder; flight takes over from here
    if (flying) endFly(); // finalize a flight already running before starting another
    flying = true;
    flyLeft = duration;
    flyCeiling = ceiling;
    flyTakeoffLeft = FLY_TAKEOFF_S;
    flyOnEnd = onEnd ?? null;
    vy = 0;
    grounded = false;
  };

  launchHook = (dirX, dirZ, hSpeed, vSpeed, onLand) => {
    if (flying) endFly(); // a launch supersedes flight
    if (dashing) endDash(); // a launch supersedes a dash
    if (pulling) endPull(); // the two overrides can't coexist — finalize whichever was running
    if (climbing) endClimb(false); // let go and fall from here; the leap's own vy takes over below
    const len = Math.hypot(dirX, dirZ) || 1;
    launchVX = (dirX / len) * hSpeed;
    launchVZ = (dirZ / len) * hSpeed;
    vy = vSpeed;
    grounded = false;
    launching = true;
    launchOnLand = onLand ?? null;
  };

  pullHook = (tx, ty, tz, speed, timeout, onArrive) => {
    if (flying) endFly();
    if (launching) endLaunch();
    if (climbing) endClimb(false); // let go; the pull's own straight-line lerp takes over below
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

  /** One tick of climbing a ladder: gravity is suspended, x/z stay locked to the ladder's own
   *  line so there's no drift, and the `forward` axis (same W/S as walking) drives y directly at
   *  a constant CLIMB_SPEED — up on W, down on S, holding position when neither is pressed.
   *
   *  Three ways off, all handled here every tick:
   *   - Reach the top (y clamps at the ladder's topY): step off onto the wall walk at
   *     climbDismountZ — well inside the walkway past the parapet/merlon band, never at the lip
   *     — grounded, no launch, no lingering vy. This is the "smooth dismount" the feature lives
   *     or dies on; landing anywhere else would read as broken.
   *   - Reach the bottom (y clamps at 0) while still pressing S: there's solid ground right
   *     there, so just stand on it — grounded, ordinary walking resumes next tick.
   *   - Strafe hard enough (CLIMB_RELEASE_STRAFE) or the ladder stops being usable out from
   *     under the player (front ladder + combat starts, or its wall gets destroyed — checked
   *     fresh against castle.ladderAt every tick, never trusted from grab-time): let go from
   *     wherever they currently are and fall under ordinary gravity. Per the design decision
   *     (see module doc), that drop is deliberate — never a teleport to the top or bottom. */
  function tickClimb(p: PlayerState, forward: number, strafe: number, dt: number): void {
    const stillUsable = (game.castle as unknown as CastleLadders).ladderAt(climbX, p.pos.y, climbZ) !== null;
    if (!stillUsable || Math.abs(strafe) >= CLIMB_RELEASE_STRAFE) {
      if (!stillUsable) game.events.emit('ui:toast', { text: 'The ladder gives way — you drop!' });
      endClimb(false); // let go from exactly here; gravity (next tick, now that climbing=false) takes it from there — never a teleport
      playerMotion.velX = playerMotion.velZ = playerMotion.velY = 0;
      playerMotion.grounded = false;
      return;
    }

    const oldY = p.pos.y;
    const ny = clamp(oldY + forward * CLIMB_SPEED * dt, 0, climbTopY);
    p.pos.set(climbX, ny, climbZ);

    if (ny >= climbTopY) {
      p.pos.set(climbX, climbTopY, climbDismountZ); // step off onto the wall walk, not the lip
      endClimb(true);
      playerMotion.velX = playerMotion.velZ = playerMotion.velY = 0;
      playerMotion.grounded = true;
      return;
    }
    if (ny <= 0 && forward < 0) {
      endClimb(true); // solid ground is right here; stay put, walk away normally next tick
      playerMotion.velX = playerMotion.velZ = playerMotion.velY = 0;
      playerMotion.grounded = true;
      return;
    }

    playerMotion.velX = 0;
    playerMotion.velZ = 0;
    playerMotion.velY = (ny - oldY) / dt;
    playerMotion.grounded = false;
  }

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
      // Also tracked as a held key: a jump is an edge (jumpQueued, consumed once per tick), but
      // flight needs to know Space is *still down* to keep climbing. keyup's held.delete covers
      // the release for any code, so nothing further is needed to clear it.
      held.add(e.code);
    }
    if (MOVE_KEYS.has(e.code)) {
      // Arrows scroll the page / move focus by default; the game owns them while playing.
      e.preventDefault();
      held.add(e.code);
    }
    // Descend while flying. Not preventDefault'd — Shift alone does nothing in a browser, and
    // swallowing it would break the modifier for anything else that wants it.
    if (FLY_DESCEND_KEYS.includes(e.code)) held.add(e.code);
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
  function applyMove(
    p: PlayerState,
    forward: number,
    strafe: number,
    jump: boolean,
    ascend: boolean,
    descend: boolean,
    dt: number
  ): void {
    if (!p.alive) {
      // Dead: frozen where they died until classes.ts respawns them at the keep. A leap in
      // flight when death happens (e.g. an arrow mid-air) is cancelled outright, not resolved —
      // there's no sensible landing spot to slam down at once you're already dead. A climb is
      // likewise abandoned outright rather than resolved to top/bottom — same "no sensible
      // resolution once dead" reasoning.
      if (launching) endLaunch();
      if (flying) endFly(); // dead men don't hover — fall from here like any other airborne death
      climbing = false;
      vy = 0;
      grounded = true;
      playerMotion.velX = playerMotion.velZ = playerMotion.velY = 0;
      return;
    }

    // A climb in progress takes over movement entirely, exactly like an in-flight pull does at
    // the call site in the tick() system below — except a climb starts from plain WASD instead
    // of an ability, so it's intercepted here rather than short-circuiting the whole system.
    if (climbing) {
      tickClimb(p, forward, strafe, dt);
      return;
    }

    let mx: number;
    let mz: number;
    if (dashing) {
      // Flat charge: fixed horizontal velocity, input ignored, vertical left entirely to the
      // normal gravity/ground-clamp path below so the dash hugs the ground instead of arcing.
      mx = dashVX;
      mz = dashVZ;
      dashLeft -= dt;
      if (dashLeft <= 0) endDash();
    } else if (launching) {
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
      if (probe - p.pos.y <= STEP_UP) {
        p.pos.z = nz;
      } else if (!launching && forward !== 0) {
        // Blocked by a wall face taller than a normal step — exactly the situation a ladder
        // exists to solve. Grab it instead of just bonking into the stone if sim/castle.ts says
        // there's a usable one right where we're trying to walk into. Gated on `forward !== 0`
        // (not just "mz got blocked") so a pure strafe past a wall's base can never snag on a
        // ladder the player wasn't trying to climb — W/S is the deliberate "climb" input, exactly
        // like walking; never mid-leap either, since a launch has its own vy/gravity arc and
        // shouldn't be hijacked by a ladder it grazes in flight. Snaps x/z onto the ladder's own
        // line (climbX/climbZ) so the climb starts centered even if the player approached a
        // little off-axis, within LADDER_REACH_X/Z's tolerance.
        const ladder = (castle as unknown as CastleLadders).ladderAt(p.pos.x, p.pos.y, nz);
        if (ladder) {
          climbing = true;
          climbX = ladder.x;
          climbZ = ladder.climbZ;
          climbTopY = ladder.topY;
          climbDismountZ = ladder.dismountZ;
          vy = 0;
          grounded = false;
        }
      }
    }
    if (climbing) {
      // Grabbed a ladder this same tick, above — hand off to tickClimb immediately rather than
      // falling through to this tick's (now stale) gravity/ground integration below.
      tickClimb(p, forward, strafe, dt);
      return;
    }

    // Flight: gravity is skipped entirely for the duration. Space (or the opening takeoff window)
    // climbs toward the ceiling; otherwise altitude simply holds, which is what makes hovering
    // over a horde to channel practical. The ground clamp still applies underneath, so flying
    // into rising terrain pushes you up rather than through it.
    if (flying) {
      flyLeft -= dt;
      flyTakeoffLeft -= dt;
      // Space climbs, Shift drops, neither holds altitude. Holding descend also cancels the
      // opening takeoff lift, so a player who wants to stay low from the moment they cast isn't
      // fighting their own launch for the first fraction of a second.
      if (ascend || (flyTakeoffLeft > 0 && !descend)) {
        p.pos.y = Math.min(p.pos.y + FLY_ASCEND_SPEED * dt, flyCeiling);
      } else if (descend) {
        p.pos.y -= FLY_DESCEND_SPEED * dt;
      }
      const groundY = castle.worldHeight(p.pos.x, p.pos.z);
      // Descending never drops you through the world; the same walkable-height clamp that stops
      // a walking player applies here, so you settle onto ground/wall tops and can climb again.
      if (p.pos.y < groundY) p.pos.y = groundY;
      vy = 0;
      grounded = false;
      playerMotion.velX = mx;
      playerMotion.velZ = mz;
      playerMotion.velY = 0;
      playerMotion.grounded = false;
      if (flyLeft <= 0) endFly();
      return;
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
      let ascend = false;
      let descend = false;
      if (canMove) {
        const anyHeld = (codes: string[]): number => (codes.some((c) => held.has(c)) ? 1 : 0);
        forward = anyHeld(MOVE_FORWARD) - anyHeld(MOVE_BACK);
        strafe = anyHeld(MOVE_RIGHT) - anyHeld(MOVE_LEFT);
        jump = jumpQueued;
        ascend = held.has('Space'); // sustained, unlike jump — see the keydown handler
        descend = FLY_DESCEND_KEYS.some((c) => held.has(c));
      }
      jumpQueued = false;
      applyMove(p, forward, strafe, jump, ascend, descend, dt);
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
