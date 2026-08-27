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
