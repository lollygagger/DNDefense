import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import { R } from './scene';
import { playerMotion } from '../player/controller';
import { actionState } from '../player/actionState';
import { updateChannelBeam } from './aerialBeam';

/** Owned by [player-classes]. First-person viewmodels: a low-poly weapon prop per class,
 *  attached to the camera. Render-only cosmetics — `actionState`/`playerMotion` are read-only.
 *  Data-driven two ways: `RIG_BUILDERS` (class id -> model) is the only thing a future 4th
 *  class needs for a model to exist; `ABILITY_ANIM` (ability id -> wind-up/impact/recovery
 *  curve, falling back to a generic jab) makes every ability look distinct, keyed off
 *  `ability:cast`'s id instead of one shared animation. The archer rig also exposes an optional
 *  `continuous()` hook (draw/nock/loose) and `grappleAttach` point, called generically below. */

// Viewmodel scale: kept small enough that even full-extension animations stay clear of the
// crosshair at screen center (see each rig's own base position/scale below).
const MAGE_SCALE = 0.34, WARRIOR_SCALE = 0.42, ARCHER_SCALE = 0.5, TANK_SCALE = 0.4, MAGE_ORB_EMISSIVE = 1.3;
const WARLOCK_SCALE = 0.36, WARLOCK_BASE_EMISSIVE = 1.0, WARLOCK_BEAM_COLOR = 0xff2fb8;
// Point lights sit ~0.6 units from the camera; anything with real reach floods the scene.
const BASE_LIGHT_INTENSITY = 0.1, LIGHT_DISTANCE = 1.5, FLASH_DECAY = 0.25;
// Archer draw/loose.
const DRAW_PULL = 0.16, DRAW_RISE = 0.035, ARROW_LENGTH = 0.62;
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
  shieldBash: gesture({ z: -0.1, x: -0.06, rx: -0.16 }, 0.16),
  shieldSlam: groundSlamAnim, // same overhead-raise/hold/smash arc — a mace slam is the same gesture
  bulwark: gesture({ y: 0.08, z: 0.12, rx: -0.12 }, 0.5),
  shieldCharge: gesture({ z: -0.08, rx: -0.1, y: -0.05 }, 0.22),
  // Soul Siphon fires an `ability:cast` every ~0.15s tick while held — an empty gesture (no pose
  // offset at all) so those rapid resets never thrash the rig; the actual "channelling" pose
  // (tremor + charge-up glow) is owned entirely by buildWarlockRig's continuous() hook below,
  // driven from live actionState rather than the fire-and-forget cast animation system.
  soulSiphon: gesture({}, 0.1),
  curseOfAgony: gesture({ z: -0.12, rx: -0.28, ry: 0.1 }, 0.35),
  abyssalGrasp: gesture({ ry: -0.3, rz: -0.14, z: -0.08 }, 0.45),
  umbralFlight: gesture({ scale: -0.85, z: 0.1 }, 0.3),
};

// NOTE ON METALNESS: this scene has no environment map, so a high-metalness MeshStandardMaterial
// has nothing to reflect and renders almost black. Metal props here fake it with a bright base
// colour and LOW metalness — raising metalness to make something look "more metal" does the exact
// opposite. Keep metalness <= ~0.25 on anything that should read as lit steel.

// ---------- rigs ----------

interface ContinuousCtx {
  charge01: number;
  chargingId: string | null;
  justReleased: boolean;
  channelId: string | null; // warlock: ability id currently being channelled, else null
  channelRamp01: number; // warlock: live ramp progress on whatever the beam is locked onto
}

interface ViewmodelRig {
  group: THREE.Group;
  basePos: THREE.Vector3;
  baseRot: THREE.Euler;
  baseScale: number;
  weight: number; // 0 (light) .. 1 (heavy): camera-lag + landing dip amount; sword heavy, bow light
  light?: THREE.Light;
  setFlash(flash01: number, big: boolean): void; // flash01 decays 1->0 over FLASH_DECAY; big = non-primary
  continuous?(dt: number, ctx: ContinuousCtx): void; // archer: pose bow/string/arrow; warlock: channel tremor + beam
  grappleAttach?: THREE.Object3D; // archer: world-space rope origin
  beamAttach?: THREE.Object3D; // warlock: world-space channel-beam origin (the rod's crystal tip)
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

  addMesh(group, new THREE.BoxGeometry(0.09, 1.0, 0.022), stdMat(0xd8e0e6, { roughness: 0.4, metalness: 0.2 }), [0, 0.62, 0]);

  const goldMat = stdMat(0xe0bf47, { roughness: 0.45, metalness: 0.2 });
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
  // Riser sits ON the belly of the limb (z = -limbR), where a hand actually grips a bow. It used
  // to float at z = -0.2, unattached, hanging in the middle of the bow's opening — which is most
  // of why the bow read as broken apart rather than as one object.
  const bellyZ = -limbR;
  const grip = addMesh(group, new THREE.BoxGeometry(0.055, 0.26, 0.075), stdMat(0x3a2a1a, { roughness: 0.85 }), [0, 0, bellyZ + 0.01]);
  // Shelf/arrow rest jutting off the riser, so the arrow visibly lies on something.
  addMesh(group, new THREE.BoxGeometry(0.05, 0.018, 0.05), stdMat(0x4a3520, { roughness: 0.85 }), [0.03, 0.03, bellyZ + 0.05]);

  const gemMat = stdMat(0x3ea373, { emissive: 0x3ea373, emissiveIntensity: 1.1, roughness: 0.25 });
  const gem = addMesh(group, new THREE.SphereGeometry(0.03, 10, 8), gemMat, [0, -0.08, bellyZ + 0.05]);
  const gemLight = addLight(group, 0x3ea373, gem.position);

  // Nocked arrow: a RIGID arrow of fixed length that slides backward with the string as you draw.
  // It used to be modelled with the head pinned in place and the shaft scaled to reach the string,
  // so drawing visibly stretched the arrow like rubber instead of pulling it back. Built nock-at-
  // origin pointing forward (-Z), so the whole group just translates by the draw distance.
  const arrowGroup = new THREE.Group();
  arrowGroup.visible = false;
  arrowGroup.position.z = stringRestZ;
  group.add(arrowGroup);
  const shaftGeo = new THREE.CylinderGeometry(0.009, 0.009, ARROW_LENGTH, 5);
  shaftGeo.rotateX(Math.PI / 2); // cylinder's +Y axis -> +Z, so the shaft runs along the draw axis
  addMesh(arrowGroup, shaftGeo, stdMat(0x8a7355, { roughness: 0.7 }), [0, 0, -ARROW_LENGTH / 2]);
  const arrowHead = addMesh(arrowGroup, new THREE.ConeGeometry(0.018, 0.07, 6), stdMat(0x9aa2a8, { metalness: 0.15, roughness: 0.45 }), [0, 0, -ARROW_LENGTH]);
  arrowHead.rotation.x = -Math.PI / 2; // cone's +Y tip -> -Z (forward, away from the viewer)
  // Fletching at the nock end.
  const fletchMat = stdMat(0xb04a4a, { roughness: 0.8 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const f = addMesh(arrowGroup, new THREE.BoxGeometry(0.004, 0.03, 0.07), fletchMat, [Math.cos(a) * 0.012, Math.sin(a) * 0.012, -0.05]);
    f.rotation.z = a;
  }

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
      // justReleased is checked unconditionally (not gated behind "chargingId just went
      // false") so a rank with the generic `autoFire` stat (archer's Quickshot rank V — see
      // player/casting.ts's autoFiringId path) can keep chargingId truthy across an entire
      // held burst and still get a visible per-shot recoil kick each time actionState.releasedAt
      // ticks: the normal single-draw flow already clears chargingId before releasing, so this
      // is a superset of the old behavior, not a change to it.
      if (ctx.justReleased) {
        recoilT = 0;
        releaseFrom = drawVisual;
      }
      if (recoilT < 1) {
        recoilT = Math.min(1, recoilT + dt / RECOIL_DURATION);
        // Fast decay from the release point plus a brief negative overshoot (the string
        // snapping past rest) that itself settles back to 0 by recoilT=1.
        drawVisual = releaseFrom * (1 - recoilT) ** 3 - RECOIL_OVERSHOOT * Math.sin(recoilT * Math.PI) * (1 - recoilT);
      } else if (ctx.chargingId) {
        drawVisual = ctx.charge01;
      } else {
        drawVisual = 0;
      }

      const tailZ = stringRestZ + drawVisual * DRAW_PULL;
      string.position.z = tailZ;
      arrowGroup.position.z = tailZ; // rigid arrow rides the string back, never stretches

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

/** Tank: a round shield (with a flash-reactive amber boss) held forward-left, a flanged mace
 *  held forward-right — the bulkiest, heaviest-weighted rig (weight 1) so its camera-lag and
 *  landing dip both read as the slowest, heaviest class in the game. */
function buildTankRig(): ViewmodelRig {
  // Straddles the screen centre instead of sitting off to the right like the one-weapon rigs.
  // The Tank is the only class holding something in BOTH hands, so an off-centre base put the
  // shield and the mace on the same side of the view, overlapping — they read as one hand full of
  // stuff. basePos.x near zero lets the shield swing genuinely left-of-centre (off-hand) and the
  // mace sit right (main hand), which is what actually communicates "shield and weapon".
  const basePos = new THREE.Vector3(0.05, -0.36, -0.62), baseRot = new THREE.Euler(-0.12, 0.1, -0.06);
  const group = startRig(basePos, baseRot, TANK_SCALE);

  const steelMat = stdMat(0xa8b2bd, { roughness: 0.55, metalness: 0.15 });
  const woodMat = stdMat(0x4a3520, { roughness: 0.85 });
  const headMat = stdMat(0xc2c9d0, { roughness: 0.45, metalness: 0.18 });

  // ---- OFF HAND (left of screen): round shield, angled to present its face ----
  const SHIELD_X = -0.62, SHIELD_Y = 0.3; // Y lifts the disc clear of the bottom of the frame
  const shield = addMesh(group, new THREE.CylinderGeometry(0.32, 0.32, 0.055, 16), steelMat, [SHIELD_X, SHIELD_Y, -0.02]);
  shield.rotation.set(Math.PI / 2, 0, 0);
  shield.rotation.z = 0.18; // tipped so it reads as held at an angle, not a flat coin
  // Raised rim + central boss give the disc some depth from the front.
  const rim = addMesh(group, new THREE.TorusGeometry(0.28, 0.033, 6, 20), woodMat, [SHIELD_X, SHIELD_Y, -0.05]);
  rim.rotation.z = 0.18;
  const boss = addMesh(group, new THREE.SphereGeometry(0.095, 10, 8), headMat, [SHIELD_X, SHIELD_Y, -0.09]);
  boss.scale.z = 0.6;

  // ---- MAIN HAND (right of screen): the mace ----
  const MACE_X = 0.5;
  addMesh(group, new THREE.CylinderGeometry(0.03, 0.036, 0.8, 8), woodMat, [MACE_X, 0.42, 0]);
  addMesh(group, new THREE.SphereGeometry(0.11, 10, 8), headMat, [MACE_X, 0.84, 0]);
  const flangeGeo = new THREE.BoxGeometry(0.05, 0.16, 0.05);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fl = addMesh(group, flangeGeo, headMat, [MACE_X + Math.cos(a) * 0.1, 0.84, Math.sin(a) * 0.1]);
    fl.rotation.y = a;
  }

  // Flash gem lives on the shield boss — the Tank's abilities are defensive, so the shield is
  // where the eye should go when one fires.
  const gemMat = stdMat(0xffd23f, { emissive: 0xffd23f, emissiveIntensity: 1.1, roughness: 0.3, metalness: 0.1 });
  const gem = addMesh(group, new THREE.SphereGeometry(0.07, 10, 8), gemMat, [SHIELD_X, SHIELD_Y, -0.13]);
  const gemLight = addLight(group, 0xffd23f, gem.position);

  return {
    group, basePos, baseRot, baseScale: TANK_SCALE, weight: 1, light: gemLight,
    setFlash(flash01, big) {
      const mul = big ? 2.2 : 1;
      gemMat.emissiveIntensity = 1.1 + flash01 * 2.5 * mul;
      gem.scale.setScalar(1 + flash01 * 0.6 * mul);
      gemLight.intensity = BASE_LIGHT_INTENSITY + flash01 * 0.9 * mul;
    },
  };
}

const beamFromScratch = new THREE.Vector3();

/** Warlock: a dark, slightly twisted iron rod with a couple of small chain-link accents (the
 *  pact-magic flavor read) and a floating void-crystal tip that glows magenta — brighter and
 *  more agitated the longer Soul Siphon stays locked onto a target. The crystal doubles as
 *  `beamAttach`, the world-space point the persistent channel beam (aerialBeam.ts) is drawn
 *  from every frame. Distinct hue from every other class/enemy/ally on the field (see
 *  data/warlock.ts's header) so the beam never reads as friendly fire or an enemy attack. */
function buildWarlockRig(): ViewmodelRig {
  const basePos = new THREE.Vector3(0.34, -0.35, -0.62), baseRot = new THREE.Euler(-0.2, 0.2, -0.14);
  const group = startRig(basePos, baseRot, WARLOCK_SCALE);

  // Wooden haft: two segments with a slight kink between them, so it reads as a cut branch
  // rather than a machined pole. Tapered thicker at the grip, flat-shaded like everything else.
  const woodMat = stdMat(0x6b4a2a, { roughness: 0.92, metalness: 0.02 });
  const darkWoodMat = stdMat(0x4a3220, { roughness: 0.95, metalness: 0.02 });
  addMesh(group, new THREE.CylinderGeometry(0.03, 0.044, 0.92, 7), woodMat, [0, 0.14, 0]);
  const upper = addMesh(group, new THREE.CylinderGeometry(0.024, 0.031, 0.5, 7), woodMat, [0.016, 0.63, 0.012]);
  upper.rotation.z = 0.07; // the kink

  // A couple of knots/burls down the shaft — cheap irregularity that sells "wood" at a glance.
  for (const [ky, kx] of [[0.02, 0.028], [0.44, -0.026]] as [number, number][]) {
    const knot = addMesh(group, new THREE.IcosahedronGeometry(0.028, 0), darkWoodMat, [kx, ky, 0.004]);
    knot.scale.set(1, 0.7, 0.8);
  }

  // Leather grip wraps, replacing the old iron chain links — warmer, and consistent with wood.
  const leatherMat = stdMat(0x3a2a1a, { roughness: 0.95, metalness: 0.02 });
  const wrapGeo = new THREE.CylinderGeometry(0.047, 0.047, 0.05, 8);
  for (let i = 0; i < 3; i++) addMesh(group, wrapGeo, leatherMat, [0, -0.12 - i * 0.08, 0]);

  // Open claw at the head: three prongs curving up and inward, cradling the crystal WITHOUT
  // touching it. The gap is the whole point — it's what makes the crystal read as floating
  // rather than glued to a stick.
  const CRADLE_Y = 0.9;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const prong = addMesh(group, new THREE.ConeGeometry(0.016, 0.17, 5), woodMat, [
      0.016 + Math.cos(a) * 0.052,
      CRADLE_Y,
      0.012 + Math.sin(a) * 0.052,
    ]);
    prong.rotation.set(Math.cos(a) * 0.42, -a, Math.sin(a) * -0.42); // splay outward, tips leaning in
  }

  // ---- Floating crystal ----
  // Parented to its own pivot so it can bob and turn under its own power, independent of the
  // staff's sway/animation. Sits clear above the prong tips; `beamAttach` points at the crystal
  // itself, so the channel beam still leaves from exactly where the glow is.
  const crystalPivot = new THREE.Group();
  crystalPivot.position.set(0.02, CRADLE_Y + 0.19, 0.014);
  group.add(crystalPivot);

  const orbMat = stdMat(0x2a0a22, {
    emissive: WARLOCK_BEAM_COLOR,
    emissiveIntensity: WARLOCK_BASE_EMISSIVE,
    roughness: 0.15,
    metalness: 0.1,
  });
  // Elongated octahedron reads as a cut gem rather than a ball.
  const orb = addMesh(crystalPivot, new THREE.OctahedronGeometry(0.085, 0), orbMat, [0, 0, 0]);
  orb.scale.set(1, 1.45, 1);

  // Small shards orbiting the crystal, also on the pivot so they turn with it.
  const shardMat = stdMat(0x7a1fbf, { emissive: 0x9a2fd6, emissiveIntensity: 0.6, roughness: 0.25 });
  const shardGeo = new THREE.OctahedronGeometry(0.022, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const shard = addMesh(crystalPivot, shardGeo, shardMat, [
      Math.cos(a) * 0.082,
      Math.sin(a * 1.7) * 0.03,
      Math.sin(a) * 0.082,
    ]);
    shard.scale.set(1, 1.6, 1);
  }

  // Parented to the pivot, not the staff, so the glow travels with the floating crystal instead
  // of hanging in the air where it started.
  const orbLight = addLight(crystalPivot, WARLOCK_BEAM_COLOR, new THREE.Vector3(0, 0, 0));

  // The crystal is deliberately NOT uniformly scaled (1, 1.45, 1 reads as a cut gem, not a ball),
  // so every pulse below scales RELATIVE to that — setScalar would silently round it back into a
  // sphere the first time it glowed.
  const ORB_ASPECT = new THREE.Vector3(1, 1.45, 1);
  const pulseOrb = (k: number): void => { orb.scale.copy(ORB_ASPECT).multiplyScalar(k); };

  let channelGlow = 0, localT = 0, floatT = 0;

  return {
    group, basePos, baseRot, baseScale: WARLOCK_SCALE, weight: 0.35, light: orbLight, beamAttach: orb,
    setFlash(flash01, big) {
      const mul = big ? 2.2 : 1;
      orbMat.emissiveIntensity = WARLOCK_BASE_EMISSIVE + flash01 * 2.2 * mul;
      pulseOrb(1 + flash01 * 0.5 * mul);
      orbLight.intensity = BASE_LIGHT_INTENSITY + flash01 * 0.9 * mul;
    },
    continuous(dt, ctx) {
      const channeling = ctx.channelId === 'soulSiphon';
      // The crystal is always alive: it turns steadily and bobs in its cradle even at rest, which
      // is what sells "floating" rather than "mounted". Channelling just makes it spin up.
      floatT += dt;
      crystalPivot.rotation.y += dt * (0.8 + ctx.channelRamp01 * 4.5);
      crystalPivot.rotation.x = Math.sin(floatT * 0.9) * 0.12;
      crystalPivot.position.y = CRADLE_Y + 0.19 + Math.sin(floatT * 1.6) * 0.018;
      channelGlow += ((channeling ? 1 : 0) - channelGlow) * Math.min(1, dt * 8);
      orbMat.emissiveIntensity = WARLOCK_BASE_EMISSIVE + channelGlow * (0.9 + ctx.channelRamp01 * 2.4);
      pulseOrb(1 + channelGlow * 0.12 + ctx.channelRamp01 * 0.3);
      orbLight.intensity = BASE_LIGHT_INTENSITY + channelGlow * (0.3 + ctx.channelRamp01 * 0.7);
      if (channeling) {
        localT += dt;
        const tremor = Math.sin(localT * 42) * 0.0035 * (0.3 + ctx.channelRamp01);
        group.position.x += tremor;
        group.rotation.z += tremor * 2.2;
      }
      // Draw (or hide) the persistent world-space beam from the crystal tip to wherever the
      // channel currently ends (an enemy, a blocked-by-cover point, or max range).
      R.camera.updateWorldMatrix(true, true);
      orb.getWorldPosition(beamFromScratch);
      updateChannelBeam(channeling && !!actionState.channelEndPoint, beamFromScratch, actionState.channelEndPoint ?? undefined, WARLOCK_BEAM_COLOR);
    },
  };
}

/** class id -> rig builder. Add a class here (and nowhere else in this file) to give it a
 *  first-person model; an id with no entry falls back to the mage staff. */
const RIG_BUILDERS: Record<string, () => ViewmodelRig> = {
  mage: buildMageRig,
  warrior: buildWarriorRig,
  archer: buildArcherRig,
  tank: buildTankRig,
  warlock: buildWarlockRig,
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
        updateChannelBeam(false);
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
      // Default the channel beam off before letting the active rig's own continuous() (if any)
      // turn it back on — guards against it getting stuck visible if the player stops being a
      // warlock (or stops being visible) on the very frame a channel was live.
      updateChannelBeam(false);
      active.continuous?.(dt, {
        charge01: actionState.charge01,
        chargingId: actionState.chargingId,
        justReleased,
        channelId: actionState.channelId,
        channelRamp01: actionState.channelRamp01,
      });

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
