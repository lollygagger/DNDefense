import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import { R } from './scene';
import { playerMotion } from '../player/controller';
import { actionState } from '../player/actionState';

/** Owned by [player-classes]. First-person viewmodels: a low-poly weapon prop per class,
 *  attached to the camera. Render-only cosmetics — `actionState`/`playerMotion` are read-only.
 *  Data-driven two ways: `RIG_BUILDERS` (class id -> model) is the only thing a future 4th
 *  class needs for a model to exist; `ABILITY_ANIM` (ability id -> wind-up/impact/recovery
 *  curve, falling back to a generic jab) makes every ability look distinct, keyed off
 *  `ability:cast`'s id instead of one shared animation. The archer rig also exposes an optional
 *  `continuous()` hook (draw/nock/loose) and `grappleAttach` point, called generically below. */

// Viewmodel scale: kept small enough that even full-extension animations stay clear of the
// crosshair at screen center (see each rig's own base position/scale below).
const MAGE_SCALE = 0.34, WARRIOR_SCALE = 0.42, ARCHER_SCALE = 0.5, MAGE_ORB_EMISSIVE = 1.3;
// Point lights sit ~0.6 units from the camera; anything with real reach floods the scene.
const BASE_LIGHT_INTENSITY = 0.1, LIGHT_DISTANCE = 1.5, FLASH_DECAY = 0.25;
// Archer draw/loose.
const DRAW_PULL = 0.16, DRAW_RISE = 0.035, ARROW_HEAD_Z = -0.05;
const TREMOR_START = 0.92, TREMOR_AMOUNT = 0.006, RECOIL_DURATION = 0.22, RECOIL_OVERSHOOT = 0.05;
// Weight/lag/landing/leap polish.
const LAG_BASE_RATE = 14, LAND_DURATION = 0.28, LAND_DROP = 0.05;
const AIRBORNE_Y = 0.05, AIRBORNE_RX = 0.1, AIRBORNE_RZ = 0.02;

// ---------- ability pose curves ----------

interface Pose { x: number; y: number; z: number; rx: number; ry: number; rz: number; scale: number; }
function zeroPose(): Pose {
  return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };
}
function resetPose(p: Pose): void {
  p.x = p.y = p.z = p.rx = p.ry = p.rz = 0;
  p.scale = 1;
}
const hump = (t: number) => Math.sin(Math.max(0, Math.min(1, t)) * Math.PI); // 0 -> 1 -> 0
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

interface AbilityAnim {
  duration: number; // seconds
  pose(t: number, out: Pose, sign: number): void; // t: 0 (cast)->1 (settled); sign: Cleave-only alt
}

// Hump-shaped (0 -> peak -> 0, always settles back to rest by t=1) gesture from per-axis peak
// weights; `scale` is a delta from 1 (e.g. -0.9 shrinks near-invisible, for Blink). Covers most
// abilities — Cleave/Ground Slam/Fireball get bespoke curves below, real wind-up/impact shapes.
function gesture(weights: Partial<Pose>, duration: number): AbilityAnim {
  const { scale, ...rest } = weights;
  const keys = Object.keys(rest) as (keyof Omit<Pose, 'scale'>)[];
  return {
    duration,
    pose(t, out) {
      const a = hump(t);
      for (const k of keys) out[k] = (rest[k] ?? 0) * a;
      if (scale !== undefined) out.scale = 1 + scale * a;
    },
  };
}

const DEFAULT_ANIM = gesture({ z: -0.14, rx: -0.3 }, 0.18); // generic jab fallback

// Warrior Cleave: wind-up/slash/recovery arc, alternating side each cast via `sign` so the
// 0.35s-cooldown primary doesn't loop. 0.3s total leaves a beat before the next swing, and
// amplitudes stay modest so the blade sweeps without dragging the crosshair under it.
const CLEAVE_WU = 0.18, CLEAVE_SL = 0.42, CLEAVE_BACK = 0.22, CLEAVE_THRU = 0.28, CLEAVE_X = 0.09;
const cleaveAnim: AbilityAnim = {
  duration: 0.3,
  pose(t, out, sign) {
    if (t < CLEAVE_WU) {
      const a = easeOut(t / CLEAVE_WU);
      out.rz = sign * CLEAVE_BACK * a;
      out.y = 0.04 * a;
    } else if (t < CLEAVE_WU + CLEAVE_SL) {
      const s = easeOut((t - CLEAVE_WU) / CLEAVE_SL);
      out.rz = sign * (CLEAVE_BACK - s * (CLEAVE_BACK + CLEAVE_THRU));
      out.x = -sign * s * CLEAVE_X;
      out.z = -Math.sin(s * Math.PI) * 0.1;
      out.y = 0.04 * (1 - s);
    } else {
      const c = easeOut((t - CLEAVE_WU - CLEAVE_SL) / (1 - CLEAVE_WU - CLEAVE_SL));
      out.rz = -sign * CLEAVE_THRU * (1 - c);
      out.x = -sign * CLEAVE_X * (1 - c);
    }
    out.ry = out.rz * 0.3; // extra diagonal quality
  },
};

// Warrior Ground Slam: overhead raise/hold, then a hard downward smash with an impact snap.
const SLAM_RAISE = 0.4, SLAM_HOLD = 0.5;
const groundSlamAnim: AbilityAnim = {
  duration: 0.55,
  pose(t, out) {
    if (t < SLAM_RAISE) {
      const a = easeOut(t / SLAM_RAISE);
      out.y = a * 0.28;
      out.rx = -a * 0.7;
    } else if (t < SLAM_HOLD) {
      out.y = 0.28;
      out.rx = -0.7;
    } else {
      const b = (t - SLAM_HOLD) / (1 - SLAM_HOLD), be = easeOut(b);
      out.y = 0.28 * (1 - be);
      out.rx = -0.7 * (1 - be) + 0.35 * Math.sin(b * Math.PI);
      out.z = -0.18 * Math.sin(b * Math.PI);
    }
  },
};

// Mage Fireball: two-handed overhead summon, hold, thrust down/forward — vs. Bolt's quick flick.
const FIRE_RAISE = 0.4, FIRE_HOLD = 0.55;
const fireballAnim: AbilityAnim = {
  duration: 0.75,
  pose(t, out) {
    if (t < FIRE_RAISE) {
      const a = easeOut(t / FIRE_RAISE);
      out.y = a * 0.24;
      out.rx = -a * 0.55;
    } else if (t < FIRE_HOLD) {
      out.y = 0.24;
      out.rx = -0.55;
    } else {
      const b = (t - FIRE_HOLD) / (1 - FIRE_HOLD), be = easeOut(b);
      out.y = 0.24 * (1 - be);
      out.rx = -0.55 * (1 - be);
      out.z = -0.22 * Math.sin(b * Math.PI);
    }
  },
};

// id -> animation (ids are unique across every class, so one flat map is safe). Archer entries
// are just the release-moment kick; draw/nock/loose is the continuous pose in buildArcherRig.
const ABILITY_ANIM: Record<string, AbilityAnim> = {
  arcaneBolt: gesture({ z: -0.1, rx: -0.22, ry: 0.12 }, 0.14),
  fireball: fireballAnim,
  frostField: gesture({ ry: 0.35, rz: 0.12, z: -0.1 }, 0.6),
  blink: gesture({ scale: -0.9, z: 0.12 }, 0.3),
  cleave: cleaveAnim,
  groundSlam: groundSlamAnim,
  secondWind: gesture({ z: 0.1, y: -0.06, rx: 0.18 }, 0.6),
  leap: gesture({ y: -0.08, rx: 0.15 }, 0.22),
  quickshot: gesture({ z: 0.08, rx: 0.12 }, 0.14),
  piercingShot: gesture({ z: 0.14, rx: 0.22, rz: 0.06 }, 0.22),
  pinningShot: gesture({ z: -0.05, rx: -0.08, scale: 0.04 }, 0.3),
  grapple: gesture({ z: -0.16, rx: -0.35, ry: -0.15 }, 0.3),
};

// ---------- rigs ----------

interface ContinuousCtx { charge01: number; chargingId: string | null; justReleased: boolean; }

interface ViewmodelRig {
  group: THREE.Group;
  basePos: THREE.Vector3;
  baseRot: THREE.Euler;
  baseScale: number;
  weight: number; // 0 (light) .. 1 (heavy): camera-lag + landing dip amount; sword heavy, bow light
  light?: THREE.Light;
  setFlash(flash01: number, big: boolean): void; // flash01 decays 1->0 over FLASH_DECAY; big = non-primary
  continuous?(dt: number, ctx: ContinuousCtx): void; // archer: pose bow/string/arrow from draw state
  grappleAttach?: THREE.Object3D; // archer: world-space rope origin
}

/** Build a mesh (optionally at [x,y,z]), add it to `group`, and return it — the one-liner
 *  every rig below leans on so a mesh + its placement is one statement, not three. */
function addMesh(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, pos?: [number, number, number]): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  group.add(m);
  return m;
}
function stdMat(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, ...extra });
}
/** Start a rig group: position/rotate/scale it and parent it to the camera. */
function startRig(pos: THREE.Vector3, rot: THREE.Euler, scale: number): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(pos);
  group.rotation.copy(rot);
  group.scale.setScalar(scale);
  R.camera.add(group);
  return group;
}
/** Add the flash-reactive point light every rig has (BASE_LIGHT_INTENSITY, short LIGHT_DISTANCE). */
function addLight(group: THREE.Group, color: number, at: THREE.Vector3): THREE.PointLight {
  const l = new THREE.PointLight(color, BASE_LIGHT_INTENSITY, LIGHT_DISTANCE, 2);
  l.position.copy(at);
  group.add(l);
  return l;
}

/** Mage: a tilted wooden staff, glowing crystal orb tip, a few shard accents. */
function buildMageRig(): ViewmodelRig {
  const basePos = new THREE.Vector3(0.34, -0.34, -0.62), baseRot = new THREE.Euler(-0.22, 0.18, -0.16);
  const group = startRig(basePos, baseRot, MAGE_SCALE);

  addMesh(group, new THREE.CylinderGeometry(0.026, 0.04, 1.5, 8), stdMat(0x5b3a22, { roughness: 0.85, metalness: 0.05 }));

  const orbMat = stdMat(0xb46bff, { emissive: 0xb46bff, emissiveIntensity: MAGE_ORB_EMISSIVE, roughness: 0.25, metalness: 0.1 });
  const orb = addMesh(group, new THREE.SphereGeometry(0.1, 14, 12), orbMat, [0, 0.79, 0]);

  const shardMat = stdMat(0xbfe3ff, { emissive: 0x6fb8ff, emissiveIntensity: 0.7, roughness: 0.2 });
  const shardGeo = new THREE.ConeGeometry(0.024, 0.17, 4);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const shard = addMesh(group, shardGeo, shardMat, [Math.cos(a) * 0.1, 0.8, Math.sin(a) * 0.1]);
    shard.rotation.set(0, a, Math.PI / 2.3);
  }

  const orbLight = addLight(group, 0xb46bff, orb.position);

  return {
    group, basePos, baseRot, baseScale: MAGE_SCALE, weight: 0.4, light: orbLight,
    setFlash(flash01, big) {
      const mul = big ? 2.2 : 1;
      orbMat.emissiveIntensity = MAGE_ORB_EMISSIVE + flash01 * 2.5 * mul;
      orb.scale.setScalar(1 + flash01 * 0.6 * mul);
      orbLight.intensity = BASE_LIGHT_INTENSITY + flash01 * 0.9 * mul;
    },
  };
}

/** Warrior: a straight steel blade, gold crossguard/pommel, and an inset gem that flares on
 *  every cast — same trick as the mage's orb. */
function buildWarriorRig(): ViewmodelRig {
  const basePos = new THREE.Vector3(0.36, -0.32, -0.58), baseRot = new THREE.Euler(-0.15, 0.22, -0.22);
  const group = startRig(basePos, baseRot, WARRIOR_SCALE);

  addMesh(group, new THREE.BoxGeometry(0.09, 1.0, 0.022), stdMat(0xcdd6dd, { roughness: 0.35, metalness: 0.75 }), [0, 0.62, 0]);

  const goldMat = stdMat(0xd4af37, { roughness: 0.4, metalness: 0.6 });
  addMesh(group, new THREE.BoxGeometry(0.34, 0.06, 0.06), goldMat, [0, 0.1, 0]);
  addMesh(group, new THREE.CylinderGeometry(0.035, 0.04, 0.26, 8), stdMat(0x3a2a1a, { roughness: 0.9 }), [0, -0.06, 0]);
  addMesh(group, new THREE.SphereGeometry(0.055, 10, 8), goldMat, [0, -0.21, 0]);

  const gemMat = stdMat(0xff5533, { emissive: 0xff5533, emissiveIntensity: 1.1, roughness: 0.3 });
  const gem = addMesh(group, new THREE.SphereGeometry(0.032, 10, 8), gemMat, [0, -0.21, 0.055]);
  const gemLight = addLight(group, 0xff5533, gem.position);

  return {
    group, basePos, baseRot, baseScale: WARRIOR_SCALE, weight: 0.85, light: gemLight,
    setFlash(flash01, big) {
      const mul = big ? 2.2 : 1;
      gemMat.emissiveIntensity = 1.1 + flash01 * 2.5 * mul;
      gem.scale.setScalar(1 + flash01 * 0.6 * mul);
      gemLight.intensity = BASE_LIGHT_INTENSITY + flash01 * 0.9 * mul;
    },
  };
}

/** Archer: a recurved wooden bow (a partial torus, pre-rotated in the geometry itself so the
 *  sweep is centered and stands vertically), a taut string, a focus gem in the grip, and a
 *  nocked arrow (real shaft + head, shown while drawing) whose shaft stretches from a fixed
 *  rest point near the grip back to wherever the string currently is. */
function buildArcherRig(): ViewmodelRig {
  const basePos = new THREE.Vector3(0.34, -0.34, -0.6), baseRot = new THREE.Euler(-0.08, 0.26, 0.04);
  const group = startRig(basePos, baseRot, ARCHER_SCALE);

  const limbR = 0.42, arc = Math.PI * 1.05; // a touch past a semicircle: recurve-style tip flare
  const limbGeo = new THREE.TorusGeometry(limbR, 0.024, 6, 20, arc);
  limbGeo.rotateZ(-arc / 2); // recenter the sweep on local +X
  limbGeo.rotateY(Math.PI / 2); // stand it up: spans Y (height) and Z (front/back)
  addMesh(group, limbGeo, stdMat(0x6b4a2a, { roughness: 0.8, metalness: 0.05 }));

  // Tips land at the same Z; stringRestZ sits closer to the viewer than the belly of the bow —
  // "drawing" means pulling the string further toward the viewer still, i.e. increasing z.
  const stringRestZ = -limbR * Math.cos(arc / 2);
  const stringLen = 2 * limbR * Math.sin(arc / 2);
  const string = addMesh(group, new THREE.CylinderGeometry(0.006, 0.006, stringLen, 5), stdMat(0xe8e2d0, { roughness: 0.6 }), [0, 0, stringRestZ]);
  const grip = addMesh(group, new THREE.BoxGeometry(0.05, 0.22, 0.05), stdMat(0x3a2a1a, { roughness: 0.85 }), [0, 0, -0.2]);

  const gemMat = stdMat(0x3ea373, { emissive: 0x3ea373, emissiveIntensity: 1.1, roughness: 0.25 });
  const gem = addMesh(group, new THREE.SphereGeometry(0.028, 10, 8), gemMat, [0, 0, -0.24]);
  const gemLight = addLight(group, 0x3ea373, gem.position);

  // Nocked arrow: head fixed at the rest point near the grip, shaft stretches back to the string.
  const arrowGroup = new THREE.Group();
  arrowGroup.visible = false;
  group.add(arrowGroup);
  const shaftGeo = new THREE.CylinderGeometry(0.01, 0.01, 1, 5);
  shaftGeo.rotateX(Math.PI / 2); // bake so scale.z stretches it along the draw axis
  const arrowShaft = addMesh(arrowGroup, shaftGeo, stdMat(0x8a7355, { roughness: 0.7 }));
  const arrowHead = addMesh(arrowGroup, new THREE.ConeGeometry(0.016, 0.06, 6), stdMat(0x555a5f, { metalness: 0.6, roughness: 0.4 }), [0, 0, ARROW_HEAD_Z]);
  arrowHead.rotation.x = -Math.PI / 2;

  let drawVisual = 0; // 0 = rest, 1 = full draw; independent of charge01 so release can snap it
  let recoilT = 1, releaseFrom = 0, localT = 0; // recoilT: 1 = settled, 0 = just released

  return {
    group, basePos, baseRot, baseScale: ARCHER_SCALE, weight: 0.2, light: gemLight, grappleAttach: grip,
    setFlash(flash01, big) {
      const mul = big ? 2.2 : 1;
      gemMat.emissiveIntensity = 1.1 + flash01 * 2.5 * mul;
      gem.scale.setScalar(1 + flash01 * 0.6 * mul);
      gemLight.intensity = BASE_LIGHT_INTENSITY + flash01 * 0.9 * mul;
    },
    continuous(dt, ctx) {
      localT += dt;
      arrowGroup.visible = !!ctx.chargingId;
      if (ctx.chargingId) {
        drawVisual = ctx.charge01;
        recoilT = 1;
      } else if (ctx.justReleased) {
        recoilT = 0;
        releaseFrom = drawVisual;
      }
      if (recoilT < 1) {
        recoilT = Math.min(1, recoilT + dt / RECOIL_DURATION);
        // Fast decay from the release point plus a brief negative overshoot (the string
        // snapping past rest) that itself settles back to 0 by recoilT=1.
        drawVisual = releaseFrom * (1 - recoilT) ** 3 - RECOIL_OVERSHOOT * Math.sin(recoilT * Math.PI) * (1 - recoilT);
      } else if (!ctx.chargingId) {
        drawVisual = 0;
      }

      const tailZ = stringRestZ + drawVisual * DRAW_PULL;
      string.position.z = tailZ;
      const shaftLen = Math.max(0.001, tailZ - ARROW_HEAD_Z);
      arrowShaft.scale.z = shaftLen;
      arrowShaft.position.z = ARROW_HEAD_Z + shaftLen / 2;

      group.position.y += ctx.charge01 * DRAW_RISE; // aiming settle: slight rise/steadying
      group.rotation.x -= ctx.charge01 * 0.05;
      if (ctx.charge01 > TREMOR_START) {
        const k = (ctx.charge01 - TREMOR_START) / (1 - TREMOR_START);
        const tremor = (Math.sin(localT * 53) * 0.6 + Math.sin(localT * 87) * 0.4) * TREMOR_AMOUNT * k;
        group.position.x += tremor;
        group.rotation.z += tremor;
      }
    },
  };
}

/** class id -> rig builder. Add a class here (and nowhere else in this file) to give it a
 *  first-person model; an id with no entry falls back to the mage staff. */
const RIG_BUILDERS: Record<string, () => ViewmodelRig> = {
  mage: buildMageRig,
  warrior: buildWarriorRig,
  archer: buildArcherRig,
};

// Grapple rope scratch (module scope: reused every frame, never allocated in the loop).
const ropeStart = new THREE.Vector3(), ropeEnd = new THREE.Vector3(), ropeDir = new THREE.Vector3();
const UP_AXIS = new THREE.Vector3(0, 1, 0);

export function initViewmodel(game: GameState): void {
  // R.camera may not be in the scene graph yet — needed for its children to render at all.
  if (R.camera.parent === null) R.scene.add(R.camera);

  const rigs = new Map<string, ViewmodelRig>();
  for (const [id, build] of Object.entries(RIG_BUILDERS)) rigs.set(id, build());
  const fallbackRig = rigs.get('mage')!;

  // Grapple rope: a world-space cylinder, not a camera child — see the render() comment below
  // for why that's the easy way to reconcile a camera-space prop with a world-space anchor.
  const ropeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 5), new THREE.MeshBasicMaterial({ color: 0x2a2018 }));
  ropeMesh.visible = false;
  ropeMesh.frustumCulled = false;
  R.scene.add(ropeMesh);

  // castT: 1 = settled/idle. castFlash: 1 -> 0 decay right after a cast. castBig: non-primary ability.
  let castAnim: AbilityAnim = DEFAULT_ANIM, castT = 1, castSign = 1, cleaveSign = 1, castFlash = 0, castBig = false;
  const abilityPose = zeroPose();

  game.events.on('ability:cast', ({ id }) => {
    const p = game.localPlayer;
    castAnim = ABILITY_ANIM[id] ?? DEFAULT_ANIM;
    castT = 0;
    if (id === 'cleave') cleaveSign = -cleaveSign; // alternate swing direction each hit
    castSign = id === 'cleave' ? cleaveSign : 1;
    castBig = !!p && id !== p.classDef.primary.id;
    castFlash = 1;
  });

  // landT: 1 = settled; lookInit guards the one-time smoothedYaw/Pitch seed on the first frame.
  let lastReleasedAt = actionState.releasedAt, smoothedYaw = 0, smoothedPitch = 0, lookInit = false;
  let prevGrounded = true, landT = 1, airborneBlend = 0;

  game.addSystem({
    render(dt) {
      const p = game.localPlayer;
      const visible = !!p && p.alive && (game.phase === 'build' || game.phase === 'combat');
      const active = (p && rigs.get(p.classDef.id)) || fallbackRig;

      for (const rig of rigs.values()) {
        const isActive = rig === active;
        rig.group.visible = visible && isActive;
        if (rig.light) rig.light.visible = visible && isActive;
      }
      if (!visible || !p) {
        ropeMesh.visible = false;
        return;
      }
      if (!lookInit) {
        smoothedYaw = p.yaw;
        smoothedPitch = p.pitch;
        lookInit = true;
      }

      const t = game.time;
      const idleY = Math.sin(t * 1.6) * 0.016, idleX = Math.sin(t * 0.9) * 0.008, idleRotZ = Math.sin(t * 1.1) * 0.026;

      const speed = Math.hypot(playerMotion.velX, playerMotion.velZ);
      const walkAmt = Math.min(speed / (p.classDef.moveSpeed || 1), 1.3);
      let walkY = Math.sin(t * 11) * 0.055 * walkAmt;
      let walkX = Math.cos(t * 5.5) * 0.03 * walkAmt;
      let walkRotZ = Math.sin(t * 11) * 0.07 * walkAmt;
      let walkRotX = Math.abs(Math.sin(t * 11)) * 0.018 * walkAmt;

      // Leap: airborne pose instead of the walk-bob, blended in/out so the switch isn't a pop.
      airborneBlend += ((actionState.leaping ? 1 : 0) - airborneBlend) * Math.min(1, dt * 10);
      const walkBlend = 1 - airborneBlend;
      walkY = walkY * walkBlend + AIRBORNE_Y * airborneBlend;
      walkX *= walkBlend;
      walkRotZ = walkRotZ * walkBlend + AIRBORNE_RZ * airborneBlend;
      walkRotX = walkRotX * walkBlend + AIRBORNE_RX * airborneBlend;

      // Landing settle: downward dip on the grounded-edge, eased back out; heavier rigs dip more.
      if (!prevGrounded && playerMotion.grounded) landT = 0;
      prevGrounded = playerMotion.grounded;
      landT = Math.min(1, landT + dt / LAND_DURATION);
      const landDip = -Math.sin(landT * Math.PI) * LAND_DROP * (0.5 + active.weight * 0.5);

      // Weight/lag: local rotation briefly opposes a camera turn and springs back — since the
      // rig is a camera child, that reads as trailing instead of welded. Heavier (sword) rigs
      // catch up slower and lag further; the light bow barely trails.
      const alpha = 1 - Math.exp(-LAG_BASE_RATE * (1.2 - active.weight) * dt);
      smoothedYaw += (p.yaw - smoothedYaw) * alpha;
      smoothedPitch += (p.pitch - smoothedPitch) * alpha;
      const maxLag = 0.04 + active.weight * 0.14;
      const lagYaw = THREE.MathUtils.clamp(smoothedYaw - p.yaw, -maxLag, maxLag);
      const lagPitch = THREE.MathUtils.clamp(smoothedPitch - p.pitch, -maxLag, maxLag) * 0.6;

      // Ability animation, keyed off the last ability:cast id (see ABILITY_ANIM above).
      castT = Math.min(1, castT + dt / castAnim.duration);
      resetPose(abilityPose);
      castAnim.pose(castT, abilityPose, castSign);

      const { group, basePos, baseRot, baseScale } = active;
      group.position.set(basePos.x + idleX + walkX + abilityPose.x, basePos.y + idleY + walkY + abilityPose.y + landDip, basePos.z + abilityPose.z);
      group.rotation.set(baseRot.x + walkRotX + abilityPose.rx + lagPitch, baseRot.y + abilityPose.ry + lagYaw, baseRot.z + idleRotZ + walkRotZ + abilityPose.rz);
      group.scale.setScalar(baseScale * abilityPose.scale);

      const justReleased = actionState.releasedAt !== lastReleasedAt && actionState.releasedAt >= 0;
      lastReleasedAt = actionState.releasedAt;
      active.continuous?.(dt, { charge01: actionState.charge01, chargingId: actionState.chargingId, justReleased });

      castFlash = Math.max(0, castFlash - dt / FLASH_DECAY);
      active.setFlash(castFlash, castBig);

      // Grapple rope: the rig is camera-space, the anchor is world-space — reconciling those as
      // a plain world-space line is far easier than projecting the anchor into camera-local
      // space. One wrinkle: matrixWorld only refreshes when the renderer traverses the scene, a
      // frame after we set position/rotation above — force it here so the rope isn't stale.
      if (actionState.grappleAnchor && active.grappleAttach) {
        R.camera.updateWorldMatrix(true, true);
        active.grappleAttach.getWorldPosition(ropeStart);
        ropeEnd.copy(actionState.grappleAnchor);
        ropeDir.copy(ropeEnd).sub(ropeStart);
        const dist = ropeDir.length();
        ropeMesh.visible = dist > 0.05;
        if (ropeMesh.visible) {
          ropeDir.divideScalar(dist);
          ropeMesh.position.copy(ropeStart).addScaledVector(ropeDir, dist / 2);
          ropeMesh.scale.set(1, dist, 1);
          ropeMesh.quaternion.setFromUnitVectors(UP_AXIS, ropeDir);
        }
      } else {
        ropeMesh.visible = false;
      }
    },
  });
}
