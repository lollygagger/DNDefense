import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { AbilityDef, PlayerState } from '../sim/types';
import { getAbilityDef, getAbilityStats, tryCast } from '../sim/classes';
import { R } from '../render/scene';
import { isMenuOpen, setMoveSpeedMultiplier } from './controller';
import { actionState } from './actionState';

/** Owned by [player-classes]. Input → cast commands: LMB fires the primary along the camera
 *  ray; ability keys (2..9, generically classDef.abilities[key-2]) arm ground-targeted
 *  abilities and show a ring reticle where the crosshair meets the ground, or cast
 *  'aimed'-targeting hotkey abilities immediately. LMB confirms / RMB or Esc cancels.
 *  Sim-boundary rule: this file only ever talks to the sim through tryCast(); it never
 *  mutates enemies/walls/units directly.
 *
 *  Two extra input shapes live here on top of that base flow:
 *   - Ground-targeted `role: 'mobility'` abilities (the grapple hook) still use the normal
 *     arm/preview/confirm reticle flow — same as an AoE spell — but the confirm click requires
 *     the raymarch to have actually found walkable ground/wall-top within range (not the
 *     "aiming at the sky" flattened fallback every other ground ability tolerates); missing
 *     that is a miss (toast + red flash, no cooldown burned, tryCast never called).
 *   - A primary with a `charge` descriptor (the archer's bow) turns LMB into hold-to-draw:
 *     mousedown starts a draw, `actionState.charge01`/`chargingId` are driven live every
 *     render frame while held, and mouseup looses it — tryCast (and thus the cooldown) only
 *     fires on release, with the drawn fraction passed through as a charge amount. The draw
 *     cancels cleanly (no shot, actionState reset) the instant `canAct()` goes false for any
 *     reason — menu opened, death, phase change, lost pointer lock.
 *   - A charge ability whose *current rank* stats include a generic `autoFire` flag (only the
 *     archer's Quickshot at rank V today, but the flag isn't archer-specific) goes full auto:
 *     holding through a complete draw instead of releasing locks the bow at full power and
 *     fires again every tick the cooldown allows, for as long as LMB stays down — see the
 *     `autoFiringId` state and the `tick()` handler below. Releasing at any point before a full
 *     draw still behaves exactly like the non-autoFire ranks (a partial-charge shot on release). */

const RETICLE_COLORS: Record<string, number> = {
  fireball: 0xff6a2a,
  frostField: 0x7fd8ff,
  blink: 0xc86bff,
  groundSlam: 0xe08a3c, // warrior: bronze/steel
  leap: 0xe08a3c,
  grapple: 0x3ea373, // archer: bow-gem teal
  shieldSlam: 0xffd23f, // tank: shield-boss amber
  curseOfAgony: 0xd63fe0, // warlock: sickly curse violet
  abyssalGrasp: 0x7a3fe0, // warlock: void-rift indigo
  voidstep: 0x9a2fb0, // warlock: void-step magenta
};
const RETICLE_DEFAULT_COLOR = 0xd6c9ff;
const FLASH_COLOR = 0xff3344;
const DEFAULT_CAST_RANGE = 45;
const GROUND_STEP = 0.5;
const REFINE_ITERS = 8;
const FLASH_DURATION = 0.35;

// Scratch vectors reused every frame/click to avoid per-call allocation churn.
const tmpEye = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpPoint = new THREE.Vector3();

/** March the camera ray forward in fixed steps until it dips below the walkable ground
 *  height, then binary-refine the crossing. If the ray never meets the ground within
 *  maxRange (e.g. aiming at the sky), fall back to a flattened point at maxRange.
 *  `hitFlag`, if given, is set true when a real crossing was found and false on the
 *  fallback — most callers (AoE placement) don't care and omit it; a caller that needs a
 *  *real* anchor (the grapple hook) reads it to reject the fallback as "nothing in range". */
function raymarchGround(
  game: GameState,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxRange: number,
  out: THREE.Vector3,
  hitFlag?: { hit: boolean }
): THREE.Vector3 {
  const steps = Math.max(1, Math.ceil(maxRange / GROUND_STEP));
  let prevT = 0;
  let t = 0;
  for (let i = 1; i <= steps; i++) {
    t = Math.min(i * GROUND_STEP, maxRange);
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    const ground = game.castle.worldHeight(px, pz);
    if (py <= ground) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < REFINE_ITERS; k++) {
        const mid = (lo + hi) / 2;
        const mx = origin.x + dir.x * mid;
        const my = origin.y + dir.y * mid;
        const mz = origin.z + dir.z * mid;
        const g = game.castle.worldHeight(mx, mz);
        if (my <= g) hi = mid;
        else lo = mid;
      }
      const fx = origin.x + dir.x * hi;
      const fz = origin.z + dir.z * hi;
      out.set(fx, game.castle.worldHeight(fx, fz), fz);
      if (hitFlag) hitFlag.hit = true;
      return out;
    }
    prevT = t;
  }
  // No ground hit within range (aiming above the horizon) — flatten at max range.
  const fx = origin.x + dir.x * maxRange;
  const fz = origin.z + dir.z * maxRange;
  out.set(fx, game.castle.worldHeight(fx, fz), fz);
  if (hitFlag) hitFlag.hit = false;
  return out;
}

function clampToPlayerRange(
  game: GameState,
  point: THREE.Vector3,
  playerPos: THREE.Vector3,
  range: number
): void {
  const dx = point.x - playerPos.x;
  const dz = point.z - playerPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > range && dist > 0) {
    const s = range / dist;
    point.x = playerPos.x + dx * s;
    point.z = playerPos.z + dz * s;
    point.y = game.castle.worldHeight(point.x, point.z);
  }
}

/** Ground-target range for the caster's *current rank* of an ability: a rank's stats may
 *  override the ability's base castRange (e.g. Blink's teleport distance grows with rank) —
 *  fall back to the static castRange, then the global default, when a rank has no override.
 *  Generic: any ground-target ability can opt into per-rank range simply by putting a
 *  `range` stat in its rank data; nothing here is ability-specific. */
function groundRangeFor(player: PlayerState, def: AbilityDef): number {
  const stats = getAbilityStats(player, def.id);
  return stats.range ?? def.castRange ?? DEFAULT_CAST_RANGE;
}

/** Where the crosshair currently meets the ground, clamped to the ability's cast range.
 *  `hitFlag` is forwarded to raymarchGround verbatim — see its doc comment. */
function computeGroundPoint(
  game: GameState,
  player: PlayerState,
  range: number,
  out: THREE.Vector3,
  hitFlag?: { hit: boolean }
): THREE.Vector3 {
  const eye = R.camera.getWorldPosition(tmpEye);
  const dir = R.camera.getWorldDirection(tmpDir);
  raymarchGround(game, eye, dir, range, out, hitFlag);
  clampToPlayerRange(game, out, player.pos, range);
  return out;
}

function buildReticle(): {
  ring: THREE.Mesh;
  dot: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  dotMat: THREE.MeshBasicMaterial;
} {
  const ringMat = new THREE.MeshBasicMaterial({
    color: RETICLE_DEFAULT_COLOR,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  ring.renderOrder = 5;

  const dotMat = new THREE.MeshBasicMaterial({
    color: RETICLE_DEFAULT_COLOR,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16), dotMat);
  dot.rotation.x = -Math.PI / 2;
  dot.visible = false;
  dot.renderOrder = 5;

  R.scene.add(ring, dot);
  return { ring, dot, ringMat, dotMat };
}

export function initCasting(game: GameState): void {
  const { ring, dot, ringMat, dotMat } = buildReticle();

  let armed: string | null = null;
  let flashId: string | null = null;
  let flashUntil = 0;

  // Hold-to-draw state for a primary with a `charge` descriptor (see types.ts). Only ever the
  // local player's primary ability id, but kept generic (id, not a boolean) so nothing here
  // hardcodes "archer"/"quickshot" — any future charge-primary class gets this for free.
  let drawingId: string | null = null;
  let drawStart = 0;
  // Full-auto state (see types.ts's `charge` doc + the archer's Quickshot rank V): once a draw
  // that started on an `autoFire`-ranked ability reaches a full 100% draw while still held, it
  // transitions here instead of waiting for mouseup — tick() below then keeps re-casting at
  // full power every tick, throttled purely by tryCast's own cooldown gate, for as long as
  // `mouseDown` stays true. Generic on the same terms as `drawingId`: driven by a stat
  // (`autoFire`) any charge-capable ability could opt into, not an archer-specific branch.
  let autoFiringId: string | null = null;
  let mouseDown = false; // raw LMB physical state, needed because auto-fire has no per-shot event

  // Hold-to-channel state for a primary whose current-rank stats carry a truthy `channel` flag
  // (see actionState.ts's channelId doc comment). Generic mechanism, same shape as `autoFire`:
  // mousedown fires the first tick immediately (no draw to complete first) and starts refiring
  // every tick tryCast's own cooldown allows, for as long as LMB stays down. Everything about
  // WHAT the channel actually does (ramp, target lock, cover) is entirely the owning ability's
  // own cast() (see data/warlock.ts) — nothing here is Warlock-specific.
  let channelingId: string | null = null;

  const disarm = (): void => {
    armed = null;
  };

  /** Ground-ability arm/cast attempts get explicit feedback (toast + red reticle flash) since
   *  nothing else would otherwise indicate why the hotkey did nothing. The rapid-fire primary
   *  (LMB) deliberately does NOT nag on every over-click — its cooldown ring on the HUD ability
   *  bar is feedback enough. */
  const castFail = (def: AbilityDef, text: string): void => {
    game.events.emit('ui:toast', { text });
    flashId = def.id;
    flashUntil = game.time + FLASH_DURATION;
  };
  const notReady = (def: AbilityDef): void => castFail(def, `${def.name} not ready`);

  /** End a hold-to-draw (and/or an in-progress auto-fire loop), for any reason (release,
   *  cancel, interruption) — resets every bit of presentation state either touches so nothing
   *  lingers: the viewmodel's bow pose (chargingId/charge01) and the move-speed penalty.
   *  Unconditional and idempotent: safe to call whether or not anything is actually in
   *  progress. Does NOT fire a shot — callers that mean to fire do that separately, using the
   *  drawingId/drawStart snapshot *before* calling this. */
  const endDraw = (): void => {
    drawingId = null;
    autoFiringId = null;
    actionState.chargingId = null;
    actionState.charge01 = 0;
    setMoveSpeedMultiplier(1);
  };

  /** End a hold-to-channel primary (see channelingId above), for any reason — release, cancel,
   *  or interruption. Mirrors endDraw()'s shape exactly: resets every bit of presentation state
   *  the channel touches (actionState.channelId/channelRamp01/channelEndPoint, the move-speed
   *  penalty) and is unconditional/idempotent. Does not fire a final tick. */
  const endChannel = (): void => {
    channelingId = null;
    actionState.channelId = null;
    actionState.channelRamp01 = 0;
    actionState.channelEndPoint = null;
    setMoveSpeedMultiplier(1);
  };

  /** Fire one auto shot at full power (reuses the same eye/dir/range math as a normal aimed
   *  cast — auto-fire is just castAimed() called repeatedly). tryCast's own cooldown gate is
   *  what actually throttles the rate; calling this every tick while off cooldown is a no-op. */
  function fireAuto(player: PlayerState, def: AbilityDef): void {
    if (castAimed(player, def)) actionState.releasedAt = game.time; // per-shot recoil kick
  }

  const canAct = (): boolean => {
    const p = game.localPlayer;
    return (
      !!p &&
      p.alive &&
      !isMenuOpen() &&
      (game.phase === 'build' || game.phase === 'combat') &&
      document.pointerLockElement === R.renderer.domElement
    );
  };

  function castAimed(player: PlayerState, def: AbilityDef): boolean {
    const eye = R.camera.getWorldPosition(tmpEye).clone();
    const dir = R.camera.getWorldDirection(tmpDir);
    const range = def.castRange ?? 60;
    const aim = eye.clone().addScaledVector(dir, range);
    return tryCast(game, player, def.id, eye, aim);
  }

  // ---------- mouse: LMB confirms/casts, RMB cancels ----------
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
      if (armed !== null) disarm();
      return;
    }
    if (e.button !== 0) return;
    if (!canAct()) return;
    const player = game.localPlayer!;

    if (armed !== null) {
      const def = getAbilityDef(player.classDef, armed);
      disarm();
      if (!def) return;
      const range = groundRangeFor(player, def);
      const hit = { hit: false };
      const point = computeGroundPoint(game, player, range, tmpPoint, hit).clone();
      // role:'mobility' ground abilities (the grapple hook) need a *real* walkable anchor —
      // the "aiming at the sky" flattened fallback every other ground ability tolerates isn't
      // a valid hookshot target. Reject it as a miss: no cooldown burned (tryCast never runs).
      if (def.role === 'mobility' && !hit.hit) {
        castFail(def, `No anchor in range for ${def.name}`);
        return;
      }
      const eye = R.camera.getWorldPosition(tmpEye).clone();
      const ok = tryCast(game, player, def.id, eye, point);
      if (!ok) notReady(def);
      return;
    }

    const def = player.classDef.primary;
    if ((player.cooldowns[def.id] ?? 0) > game.time) return; // silent: HUD cooldown ring already shows this

    const primaryStats = getAbilityStats(player, def.id);
    if (primaryStats.channel) {
      // Hold-to-channel (see the channelingId doc comment above): unlike a draw, there's nothing
      // to wind up — fire the first tick right now, then let tick() below keep refiring every
      // tick the ability's own cooldown allows for as long as LMB stays down.
      channelingId = def.id;
      mouseDown = true;
      actionState.channelId = def.id;
      actionState.channelRamp01 = 0;
      setMoveSpeedMultiplier(primaryStats.moveSpeedMult ?? 1);
      castAimed(player, def);
      return;
    }

    if (def.charge) {
      // Hold-to-draw: mousedown only starts the draw. tryCast (and its cooldown) fires on
      // release — see the mouseup listener below — unless the ability's current rank has
      // `autoFire` and the draw is held all the way through, in which case tick() below takes
      // over before mouseup ever happens (see the module doc comment on autoFiringId).
      drawingId = def.id;
      drawStart = game.time;
      mouseDown = true;
      actionState.chargingId = def.id;
      actionState.charge01 = 0;
      setMoveSpeedMultiplier(def.charge.moveSpeedMult ?? 1);
      return;
    }

    castAimed(player, def);
  });

  // ---------- mouse: release a hold-to-draw primary (or stop a channel/auto-fire loop) ----------
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    mouseDown = false;
    if (channelingId !== null) {
      // The last tick already fired from tick()/the mousedown above — releasing just stops it.
      endChannel();
      return;
    }
    if (autoFiringId !== null) {
      // Already firing every tick at full power — releasing just stops it. The most recent
      // shot already fired from tick(), so there's nothing left to loose here.
      endDraw();
      return;
    }
    if (drawingId === null) return;
    const player = game.localPlayer;
    const def = player ? getAbilityDef(player.classDef, drawingId) : null;
    const charge = def?.charge;
    const heldFor = game.time - drawStart;
    endDraw(); // reset presentation state regardless of what happens next
    if (!player || !def || !charge) return;
    if (!canAct()) return; // menu opened / died / phase changed / lost pointer lock mid-draw: cancel, no shot

    const raw01 = Math.min(1, Math.max(0, heldFor / charge.drawTime));
    // Floored at minRelease so a snap-release still looses a real (if weak) shot, never a
    // literal zero — see types.ts's charge doc comment.
    const chargeFraction = charge.minRelease + (1 - charge.minRelease) * raw01;
    const eye = R.camera.getWorldPosition(tmpEye).clone();
    const dir = R.camera.getWorldDirection(tmpDir);
    const range = def.castRange ?? 60;
    const aim = eye.clone().addScaledVector(dir, range);
    const ok = tryCast(game, player, def.id, eye, aim, chargeFraction);
    if (ok) actionState.releasedAt = game.time;
  });

  // Prevent the browser's right-click context menu from popping mid-game.
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- ability hotkeys 2..9 -> classDef.abilities[key-2] ----------
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (armed !== null) disarm();
      return;
    }
    const m = /^Digit([2-9])$/.exec(e.code);
    if (!m) return;
    if (!canAct()) return;
    const player = game.localPlayer!;
    const idx = Number(m[1]) - 2;
    const def = player.classDef.abilities[idx];
    if (!def) return;

    if (armed === def.id) {
      disarm(); // pressing the armed ability's own key again cancels it
      return;
    }
    if ((player.cooldowns[def.id] ?? 0) > game.time) {
      notReady(def);
      return;
    }
    if (def.targeting === 'ground') {
      armed = def.id;
    } else {
      castAimed(player, def); // aimed ability on a hotkey slot: cast immediately, no arming
    }
  });

  // ---------- disarm / cancel-draw/channel triggers ----------
  game.events.on('player:died', () => {
    disarm();
    endDraw();
    endChannel();
  });
  game.events.on('phase:changed', ({ phase }) => {
    if (phase === 'gameover') disarm();
    endDraw(); // any phase change (build<->combat too) cancels an in-progress draw
    endChannel(); // ...and an in-progress channel, same reasoning
  });

  // ---------- reticle render + live draw state ----------
  game.addSystem({
    // Auto-fire/channel's actual sim mutation (tryCast, via fireAuto/castAimed) belongs in
    // tick(), not render() — render() only ever reads sim state (see ARCHITECTURE.md's
    // sim/render rule). Self-contained: re-checks canAct() itself rather than trusting the
    // render loop below to catch a menu-open/death/phase-change in time, since tick() and
    // render() run on different cadences (fixed-step sim vs rAF) and a mid-hold menu open must
    // stop casting immediately.
    tick() {
      if (channelingId !== null) {
        if (!mouseDown || !canAct()) {
          endChannel();
          return;
        }
        const player = game.localPlayer!;
        const def = getAbilityDef(player.classDef, channelingId);
        if (def) castAimed(player, def); // tryCast's own cooldown gates the actual tick rate
        return;
      }
      if (!mouseDown || (drawingId === null && autoFiringId === null)) return;
      if (!canAct()) {
        endDraw();
        return;
      }
      const player = game.localPlayer!;
      if (drawingId !== null) {
        const def = getAbilityDef(player.classDef, drawingId);
        if (!def?.charge) return;
        const stats = getAbilityStats(player, def.id);
        if (!stats.autoFire) return; // not an auto-capable rank: mouseup handles the release
        if (game.time - drawStart < def.charge.drawTime) return; // still ramping to full draw
        // Full draw reached while still held: lock in at full power instead of waiting for
        // mouseup — the reward moment for reaching an autoFire rank (see archer.ts rank V).
        drawingId = null;
        autoFiringId = def.id;
        fireAuto(player, def);
      } else if (autoFiringId !== null) {
        const def = getAbilityDef(player.classDef, autoFiringId);
        if (def) fireAuto(player, def); // tryCast's own cooldown gates the actual rate
      }
    },
    render() {
      // A UI menu/screen opening (E/B/Tab/start) always wins: drop any armed targeting.
      if (isMenuOpen() && armed !== null) disarm();

      // Drive charge01 live every frame so the viewmodel's draw pose is accurate every frame
      // (per the task note), and cancel the draw the instant canAct() goes false for any
      // reason not already covered by an explicit event above (menu open, lost pointer lock).
      // While autoFiringId is set (rather than drawingId), charge01/chargingId are already
      // pinned at {id, 1} from the moment of transition and need no further per-frame update —
      // tick() above is what actually fires the shots.
      // Same backstop for an in-progress channel — its actual ramp/end-point come from the
      // ability's own sim-side cast() (tick() above), not from here; this only guards against a
      // menu/lost-pointer-lock interruption render() notices before tick() gets a chance to.
      if (channelingId !== null && !canAct()) endChannel();

      if (drawingId !== null || autoFiringId !== null) {
        if (!canAct()) {
          endDraw();
        } else if (drawingId !== null) {
          const player = game.localPlayer;
          const def = player ? getAbilityDef(player.classDef, drawingId) : null;
          if (def?.charge) {
            actionState.charge01 = Math.min(1, Math.max(0, (game.time - drawStart) / def.charge.drawTime));
          }
        }
      }

      const player = game.localPlayer;
      const flashing = flashId !== null && game.time < flashUntil;
      const activeId = armed ?? (flashing ? flashId : null);
      const def = player && activeId ? getAbilityDef(player.classDef, activeId) : null;

      if (!player || !player.alive || !def) {
        ring.visible = false;
        dot.visible = false;
        return;
      }

      const range = groundRangeFor(player, def);
      const point = computeGroundPoint(game, player, range, tmpPoint);
      ring.visible = true;
      dot.visible = true;
      ring.position.set(point.x, point.y + 0.05, point.z);
      dot.position.copy(ring.position);

      const stats = getAbilityStats(player, def.id);
      // Mobility abilities (Blink) reposition the caster rather than affecting an area —
      // show a small fixed marker instead of an AoE-radius ring so it doesn't imply a blast.
      const radius = def.role === 'mobility' ? 0.6 : Math.max(0.4, stats.radius ?? 4);
      const t = game.time;
      const pulse = 1 + Math.sin(t * 6) * 0.06;
      ring.scale.setScalar(radius * pulse);

      const isFlashingThis = flashing && activeId === flashId;
      const color = isFlashingThis ? FLASH_COLOR : (RETICLE_COLORS[def.id] ?? RETICLE_DEFAULT_COLOR);
      ringMat.color.setHex(color);
      dotMat.color.setHex(color);
      ringMat.opacity = isFlashingThis ? 0.85 : 0.55 + Math.sin(t * 6) * 0.15;
      dotMat.opacity = 0.9;
    },
  });
}
