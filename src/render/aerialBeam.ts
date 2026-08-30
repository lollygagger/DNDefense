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
const CHANNEL_UP = new THREE.Vector3(0, 1, 0);
const channelDir = new THREE.Vector3();
const CHANNEL_CORE_RADIUS = 0.16;
/** The wash starts this far down the beam instead of at the muzzle. At deep ranks the beam is
 *  metres across, so a wash drawn from the eye puts the camera *inside* the cylinder and floods
 *  the screen with its interior wall. Skipping the first few units keeps the player outside it
 *  while costing nothing in honesty — anything close enough to fall in that gap is already point
 *  blank and plainly visible. The thin core still runs the whole length, so the beam always
 *  reads as leaving the staff. */
const CHANNEL_WASH_NEAR = 3;

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
function ensureChannelMeshes(): { wash: THREE.Mesh; core: THREE.Mesh } {
  if (!channelMesh || !channelCore) {
    // Unit geometries, scaled per frame. The wash TAPERS: full radius at the far end (radiusTop —
    // the quaternion below maps +Y onto the beam direction, so top is the business end) and a
    // quarter of it at the muzzle. Drawn as a true cylinder it is metres across right at the
    // camera and swamps the screen; the taper keeps it honest exactly where the enemies are while
    // staying out of the player's face. The narrow near section is the only place it understates,
    // and anything that close is point blank and plainly visible anyway.
    const washGeo = new THREE.CylinderGeometry(1, 0.25, 1, 16, 1, true);
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    channelMesh = new THREE.Mesh(
      washGeo,
      new THREE.MeshBasicMaterial({
        color: 0xff2fb8,
        transparent: true,
        opacity: 0.11, // faint: it's a volume, not a surface
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
    for (const m of [channelMesh, channelCore]) {
      m.frustumCulled = false;
      m.visible = false;
      R.scene.add(m);
    }
  }
  return { wash: channelMesh, core: channelCore };
}

/** Show (and reposition) or hide the persistent channel beam. `active=false` (or a missing
 *  endpoint) just hides it — the mesh itself lives for the rest of the game, never recreated.
 *  Safe to call every render frame unconditionally. */
export function updateChannelBeam(
  active: boolean,
  from?: THREE.Vector3,
  to?: THREE.Vector3,
  color?: number,
  radius = CHANNEL_CORE_RADIUS
): void {
  const { wash, core } = ensureChannelMeshes();
  if (!active || !from || !to) {
    wash.visible = false;
    core.visible = false;
    return;
  }
  channelDir.copy(to).sub(from);
  const dist = channelDir.length();
  if (dist < 0.05) {
    wash.visible = false;
    core.visible = false;
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
}
