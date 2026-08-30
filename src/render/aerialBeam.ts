import * as THREE from 'three';
import { R } from './scene';

/** Owned by [ability-fx]; split out of fx.ts to keep that file near the ~400-line budget
 *  (ARCHITECTURE.md: "split rather than grow" — fx.ts was already over budget before this task).
 *
 *  A short-lived, tapered vertical flame column linking an aerial attacker's real altitude to
 *  the ground point its attack actually lands on. Used by the dragon's breath impact (fx.ts's
 *  `dragonBreath` entry) so a scorch mark appearing under a dragon reads unambiguously as "that
 *  thing overhead did this" rather than fire that came from nowhere.
 *
 *  Same discipline as fx.ts's bursts/rings/fields: allocate on spawn, dispose on expiry, capped
 *  array, no per-frame allocation, everything driven by `dt`. */

interface Beam {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

const beams: Beam[] = [];
// Dragon breath ticks at most once/second per dragon (attackInterval, data/enemies.ts) and each
// beam lives ~0.2s, so this comfortably covers several dragons breathing in the same instant.
const MAX_BEAMS = 6;

/** `groundPos` is the impact point (already at ground level); `originY` is the attacker's real
 *  world-space Y at the moment of the attack (e.g. the dragon's dive-bottom altitude) — both
 *  real gameplay values from sim/flyers.ts, not guessed constants, so the beam's height can
 *  never drift out of sync with the actual flight model. */
export function spawnBeam(groundPos: THREE.Vector3, originY: number, radius: number, color: number, life = 0.22): void {
  if (beams.length >= MAX_BEAMS) return;
  const height = Math.max(0.4, originY - groundPos.y);
  const geo = new THREE.CylinderGeometry(radius * 0.15, radius * 0.4, height, 10, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(groundPos.x, groundPos.y + height / 2, groundPos.z);
  R.scene.add(mesh);
  beams.push({ mesh, life, maxLife: life });
}

/** Called once per render frame by fx.ts's driver system — advances life, fades opacity, and
 *  disposes+removes expired beams. */
export function updateBeams(dt: number): void {
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i];
    b.life -= dt;
    if (b.life <= 0) {
      R.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      (b.mesh.material as THREE.Material).dispose();
      beams.splice(i, 1);
      continue;
    }
    (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.6 * (b.life / b.maxLife);
  }
}

// ---------- Persistent channel beam (the Warlock's Soul Siphon, and any future channel) ----------
// Unlike the pooled, fade-and-die beams above (spawnBeam/updateBeams — right for a one-shot flash
// like the dragon's breath), a channel needs ONE beam repositioned every frame for as long as it's
// held. Spawning a fresh pooled beam every render frame would blow straight past MAX_BEAMS and
// read as flicker (several independently-fading copies stacked on top of each other) rather than
// a steady line. So this is a single lazily-created, reused-forever mesh instead — the same
// "grow/hold/reposition in place" idea fx.ts's own ground fields use, just for a segment instead
// of a disc. Driven from viewmodel.ts's render loop (camera-space origin, world-space endpoint),
// not from a sim event, since a channel's origin is the rig's own muzzle point every frame.
let channelMesh: THREE.Mesh | null = null; // the wash: drawn at the beam's TRUE hit radius
let channelCore: THREE.Mesh | null = null; // the bright thin line inside it
let channelDisc: THREE.Mesh | null = null; // the lit footprint, flat on the ground
let channelSpot: THREE.Mesh | null = null; // small billboard at the true landing point
const CHANNEL_UP = new THREE.Vector3(0, 1, 0);
const channelDir = new THREE.Vector3();
const CHANNEL_CORE_RADIUS = 0.16;
/** The wash still skips the first stretch of the beam. The brightness ramp already stops the
 *  muzzle end from glowing, but the camera sitting inside even unlit geometry is worth avoiding —
 *  and the thin core runs the full length regardless, so the beam always reads as leaving the
 *  staff. Small enough that anything in the gap is point blank and plainly visible anyway. */
const CHANNEL_WASH_NEAR = 1.5;

/** TWO meshes, because one can't tell the truth and still read as a beam.
 *
 *  The wash is drawn at the beam's real acquisition radius, so what you see is exactly what it
 *  kills. That matters: the Warlock's beam widens to several units across at deep ranks, and it
 *  was previously drawn at a fixed hairline thickness scaled by a token multiplier — at max rank
 *  a beam drawn 0.6 units wide was killing everything within 18. Enemies well outside anything
 *  you could see were dying, which reads as a bug however powerful it feels.
 *
 *  Drawn honestly and alone, though, a wide beam stops looking like a beam and becomes a fog
 *  bank. So the wash is faint and a dense core rides inside it at a fixed hairline width — the
 *  core is the "I am aiming a beam" read, the wash is the "this is what it covers" read. */
function ensureChannelMeshes(): { wash: THREE.Mesh; core: THREE.Mesh; disc: THREE.Mesh; spot: THREE.Mesh } {
  if (!channelMesh || !channelCore || !channelDisc || !channelSpot) {
    // Unit geometries, scaled per frame. The wash is a straight cylinder at the beam's TRUE radius
    // its whole length — no taper, so it never understates what the hit test sweeps.
    //
    // What keeps that watchable is a brightness ramp baked into vertex colours instead: black at
    // the muzzle, full colour at the far end. Perspective and additive blending otherwise conspire
    // to put all the light in exactly the wrong place — the near end of the cylinder is closest to
    // the camera, so it covers the most screen, and its walls are seen nearly edge-on so their
    // alpha piles up. The result read inverted: a blazing cloud around the staff, and the enemies
    // actually being burned sitting in the dimmest part of it. Multiplying by a near-black vertex
    // colour makes the muzzle end contribute nothing under additive blending, so the glow lands
    // where the damage does. 8 height segments give the ramp something to interpolate across.
    const washGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 8, true);
    const wpos = washGeo.attributes.position;
    const wcol = new Float32Array(wpos.count * 3);
    for (let i = 0; i < wpos.count; i++) {
      // y runs -0.5 (muzzle) .. +0.5 (far end); squared so it stays dark well past the player.
      const t = Math.min(1, Math.max(0, wpos.getY(i) + 0.5));
      const k = t * t;
      wcol[i * 3] = k;
      wcol[i * 3 + 1] = k;
      wcol[i * 3 + 2] = k;
    }
    washGeo.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    channelMesh = new THREE.Mesh(
      washGeo,
      new THREE.MeshBasicMaterial({
        color: 0xff2fb8,
        vertexColors: true, // the muzzle-to-target brightness ramp above
        transparent: true,
        opacity: 0.09, // just enough to show the volume; the disc below carries the real read
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    channelCore = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xffd4f2,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    // The FOOTPRINT: a camera-facing disc at the point the beam lands, at the full hit radius.
    // Without it the wash is an open tube — look down its axis and you see straight through the
    // hole, so every lit pixel is off in the side walls and the spot actually being burned is the
    // one place with no light on it at all. Measured before this existed: zero added brightness
    // at the beam's centre against 43-66 out at the walls, which is why it read inverted.
    channelDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff6fd0,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    channelSpot = new THREE.Mesh(channelDisc.geometry, channelDisc.material);
    for (const m of [channelMesh, channelCore, channelDisc, channelSpot]) {
      m.frustumCulled = false;
      m.visible = false;
      R.scene.add(m);
    }
  }
  return { wash: channelMesh, core: channelCore, disc: channelDisc, spot: channelSpot };
}

/** Show (and reposition) or hide the persistent channel beam. `active=false` (or a missing
 *  endpoint) just hides it — the mesh itself lives for the rest of the game, never recreated.
 *  Safe to call every render frame unconditionally. */
export function updateChannelBeam(
  active: boolean,
  from?: THREE.Vector3,
  to?: THREE.Vector3,
  color?: number,
  radius = CHANNEL_CORE_RADIUS,
  groundY = 0
): void {
  const { wash, core, disc, spot } = ensureChannelMeshes();
  if (!active || !from || !to) {
    wash.visible = false;
    core.visible = false;
    disc.visible = false;
    spot.visible = false;
    return;
  }
  channelDir.copy(to).sub(from);
  const dist = channelDir.length();
  if (dist < 0.05) {
    wash.visible = false;
    core.visible = false;
    disc.visible = false;
    spot.visible = false;
    return;
  }
  channelDir.divideScalar(dist);
  if (color !== undefined) (core.material as THREE.MeshBasicMaterial).color.setHex(color);
  core.visible = true;
  core.position.copy(from).addScaledVector(channelDir, dist / 2);
  core.quaternion.setFromUnitVectors(CHANNEL_UP, channelDir);
  // X/Z are the cross-section, Y the length. The core stays a hairline whatever the beam grows to.
  core.scale.set(CHANNEL_CORE_RADIUS, dist, CHANNEL_CORE_RADIUS);

  // The wash carries the real radius in world units, so it matches the hit test exactly — but it
  // starts CHANNEL_WASH_NEAR along so the camera never ends up inside it.
  const washLen = dist - CHANNEL_WASH_NEAR;
  if (washLen <= 0.05) {
    wash.visible = false;
    return;
  }
  wash.visible = true;
  wash.position.copy(from).addScaledVector(channelDir, CHANNEL_WASH_NEAR + washLen / 2);
  wash.quaternion.copy(core.quaternion);
  wash.scale.set(radius, washLen, radius);

  // Footprint marking where the beam is burning. Laid FLAT on the ground rather than billboarded:
  // a camera-facing disc metres across, centred on an enemy standing barely a unit off the floor,
  // buries its lower half in the terrain and reads as the beam going underground. Flat on the
  // ground it can never sink, and it matches the language every other area effect in the game
  // already uses — a lit pool on the floor is exactly what "this patch is being burned" looks
  // like. Lifted a hair to stay off the surface it sits on.
  disc.visible = true;
  disc.position.set(to.x, groundY + 0.06, to.z);
  disc.rotation.set(-Math.PI / 2, 0, 0);
  disc.scale.setScalar(radius);

  // ...and a small billboard right at the true landing point, so a beam held on something well
  // off the ground (a flyer) still marks where it is actually connecting, not just the floor
  // beneath it. Deliberately small: the flat pool carries the width, this only carries the spot.
  const spotR = Math.min(radius * 0.35, 1.2);
  spot.visible = to.y - groundY > spotR * 0.5; // only once it's clear of its own ground pool
  if (spot.visible) {
    spot.position.copy(to).addScaledVector(channelDir, -0.15);
    spot.quaternion.copy(R.camera.quaternion);
    spot.scale.setScalar(spotR);
  }
}
