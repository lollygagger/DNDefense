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
let channelMesh: THREE.Mesh | null = null;
const CHANNEL_UP = new THREE.Vector3(0, 1, 0);
const channelDir = new THREE.Vector3();

function ensureChannelMesh(): THREE.Mesh {
  if (!channelMesh) {
    channelMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff2fb8,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    channelMesh.frustumCulled = false;
    channelMesh.visible = false;
    R.scene.add(channelMesh);
  }
  return channelMesh;
}

/** Show (and reposition) or hide the persistent channel beam. `active=false` (or a missing
 *  endpoint) just hides it — the mesh itself lives for the rest of the game, never recreated.
 *  Safe to call every render frame unconditionally. */
export function updateChannelBeam(
  active: boolean,
  from?: THREE.Vector3,
  to?: THREE.Vector3,
  color?: number,
  girth = 1
): void {
  const mesh = ensureChannelMesh();
  if (!active || !from || !to) {
    mesh.visible = false;
    return;
  }
  channelDir.copy(to).sub(from);
  const dist = channelDir.length();
  if (dist < 0.05) {
    mesh.visible = false;
    return;
  }
  channelDir.divideScalar(dist);
  mesh.visible = true;
  if (color !== undefined) (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
  mesh.position.copy(from).addScaledVector(channelDir, dist / 2);
  // X/Z are the beam's cross-section, Y its length. `girth` lets an upgraded beam read as
  // physically thicker (see actionState.channelGirth) rather than the widening being invisible.
  mesh.scale.set(girth, dist, girth);
  mesh.quaternion.setFromUnitVectors(CHANNEL_UP, channelDir);
}
