import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import { R } from './scene';
import {
  ENEMY_SPAWN_Z,
  PROP_MIN_ABS_X,
  ROAD_HALF_WIDTH,
  STAIR_LENGTH,
  WALL_THICKNESS,
  WALL_Z,
} from '../data/castle';

/** Trees behind the castle start past everything the player can reach, so none of them grow
 *  up through the keep's rear stairs or its barracks. Derived from the castle constants —
 *  a literal here went stale the moment the walls were thickened. */
const REAR_TREE_LINE = WALL_Z[3] + WALL_THICKNESS + STAIR_LENGTH + 8;

/** Owned by [world-castle]. Terrain, lighting, environment props. Everything here is static
 *  scenery built once at init — render-only, cosmetic Math.random() is fine.
 *  Props stay at |x| > PROP_MIN_ABS_X (or behind the castle) so they never block enemies. */

const rand = (min: number, max: number): number => min + Math.random() * (max - min);

function buildGround(): void {
  const size = 400;
  const segs = 80;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);

  const grass = new THREE.Color(0x6a8f4f);
  const grassDry = new THREE.Color(0x8a9a55);
  const courtyard = new THREE.Color(0x7d855c);
  const dirt = new THREE.Color(0x8a6f4d);
  const c = new THREE.Color();

  const keepBackZ = WALL_Z[3] + WALL_THICKNESS + 7;
  for (let i = 0; i < pos.count; i++) {
    // Mesh is rotated -PI/2 about X: world x = local x, world z = -local y.
    const x = pos.getX(i);
    const z = -pos.getY(i);

    // Base grass with low-frequency patchiness + per-vertex jitter
    const patch = 0.5 + 0.5 * Math.sin(x * 0.06 + 1.7) * Math.sin(z * 0.045 - 0.6);
    c.copy(grass).lerp(grassDry, patch * 0.55);
    const j = rand(-0.035, 0.035);
    c.r += j;
    c.g += j;
    c.b += j;

    // Worn courtyard earth inside the castle footprint
    if (Math.abs(x) < 23 && z > -2 && z < keepBackZ) {
      c.lerp(courtyard, 0.75);
    }

    // Dirt approach road from the spawn gate to the tier-1 wall, flaring near the castle
    if (z > ENEMY_SPAWN_Z - 8 && z < 2) {
      const flare = z > -14 ? ((z + 14) / 16) * 3 : 0; // widens over the last stretch
      const half = ROAD_HALF_WIDTH + flare + Math.sin(z * 0.35) * 0.7;
      const d = Math.abs(x) - half;
      if (d < 1.8) {
        const t = THREE.MathUtils.clamp(1 - d / 1.8, 0, 1);
        c.lerp(dirt, Math.min(1, t) * 0.9);
      }
    }

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  R.scene.add(ground);
}

function buildSpawnGate(): void {
  const gate = new THREE.Group();
  // Sits just behind the spawn line so spawning enemies never clip the posts.
  gate.position.set(0, 0, ENEMY_SPAWN_Z - 2.2);

  const wood = new THREE.MeshLambertMaterial({ color: 0x4a3826, flatShading: true });
  const woodDark = new THREE.MeshLambertMaterial({ color: 0x352818, flatShading: true });
  const iron = new THREE.MeshLambertMaterial({ color: 0x33343a, flatShading: true });
  const banner = new THREE.MeshLambertMaterial({ color: 0x7a1f1f, side: THREE.DoubleSide });

  // Two massive posts + lintel forming a menacing arch over the road
  const postGeo = new THREE.BoxGeometry(1.8, 9, 1.8);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, wood);
    post.position.set(sx * (ROAD_HALF_WIDTH + 1.6), 4.5, 0);
    post.castShadow = true;
    gate.add(post);
    // iron caps
    const cap = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 2.2), iron);
    cap.position.set(sx * (ROAD_HALF_WIDTH + 1.6), 9.1, 0);
    gate.add(cap);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(2 * ROAD_HALF_WIDTH + 6.8, 1.6, 2.2), woodDark);
  lintel.position.set(0, 9.4, 0);
  lintel.castShadow = true;
  gate.add(lintel);

  // Spikes along the lintel
  const spikeGeo = new THREE.ConeGeometry(0.35, 1.4, 4);
  for (let i = -4; i <= 4; i++) {
    const spike = new THREE.Mesh(spikeGeo, iron);
    spike.position.set(i * 1.3, 10.9, 0);
    gate.add(spike);
  }

  // Torn war banner hanging from the lintel
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.0), banner);
  flag.position.set(0, 7.5, 0.2);
  gate.add(flag);

  // Palisade wings: rows of sharpened stakes marching outward from the gate
  const stakeGeo = new THREE.CylinderGeometry(0.28, 0.42, 5, 5);
  const tipGeo = new THREE.ConeGeometry(0.3, 0.9, 5);
  for (const side of [-1, 1]) {
    for (let x = ROAD_HALF_WIDTH + 3.4; x <= 34; x += 1.1) {
      const h = rand(4.2, 5.6);
      const stake = new THREE.Mesh(stakeGeo, wood);
      stake.scale.y = h / 5;
      stake.position.set(side * x, h / 2, rand(-0.4, 0.4));
      stake.rotation.z = rand(-0.06, 0.06);
      stake.castShadow = true;
      gate.add(stake);
      const tip = new THREE.Mesh(tipGeo, woodDark);
      tip.position.set(stake.position.x, h + 0.4, stake.position.z);
      gate.add(tip);
    }
  }
  R.scene.add(gate);
}

function buildProps(): void {
  // Rocks — instanced, kept off the play field
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 30);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < 30; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    dummy.position.set(
      side * rand(PROP_MIN_ABS_X + 3, 80),
      rand(-0.3, 0.1),
      rand(ENEMY_SPAWN_Z - 15, 36)
    );
    const s = rand(0.6, 2.4);
    dummy.scale.set(s * rand(0.8, 1.4), s * rand(0.5, 0.9), s * rand(0.8, 1.4));
    dummy.rotation.set(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI));
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
    rocks.setColorAt(i, col.setHSL(0.08, 0.04, rand(0.42, 0.58)));
  }
  rocks.castShadow = true;
  R.scene.add(rocks);

  // Trees — instanced trunks + canopies. |x| > PROP_MIN_ABS_X beside the field,
  // or anywhere behind the castle (z > 38).
  const N = 46;
  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 2.2, 5);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6e4f2f, flatShading: true });
  const canopyGeo = new THREE.ConeGeometry(1.7, 4, 6);
  const canopyMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, N);
  for (let i = 0; i < N; i++) {
    let x: number;
    let z: number;
    if (i < 32) {
      const side = i % 2 === 0 ? -1 : 1;
      x = side * rand(PROP_MIN_ABS_X + 2, 90);
      z = rand(ENEMY_SPAWN_Z - 25, 34);
    } else {
      x = rand(-70, 70);
      z = rand(REAR_TREE_LINE, 95);
    }
    const s = rand(0.8, 1.7);
    dummy.rotation.set(0, rand(0, Math.PI * 2), 0);
    dummy.position.set(x, 1.1 * s, z);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y = (2.2 + 1.6) * s;
    dummy.updateMatrix();
    canopies.setMatrixAt(i, dummy.matrix);
    canopies.setColorAt(i, col.setHSL(rand(0.23, 0.3), rand(0.35, 0.5), rand(0.28, 0.4)));
  }
  trunks.castShadow = true;
  canopies.castShadow = true;
  R.scene.add(trunks, canopies);

  // Distant low-poly hills, half-swallowed by the fog line
  const hillMat = new THREE.MeshLambertMaterial({ color: 0x74905c, flatShading: true });
  const hillGeo = new THREE.ConeGeometry(1, 1, 7);
  const hillSpots: [number, number, number, number][] = [
    // [x, z, radius, height]
    [-130, -120, 55, 26],
    [-95, -170, 70, 34],
    [30, -180, 80, 30],
    [130, -130, 60, 24],
    [170, -40, 65, 28],
    [-165, -20, 60, 22],
    [-140, 90, 70, 26],
    [150, 80, 75, 30],
    [0, 150, 90, 32],
  ];
  for (const [x, z, radius, height] of hillSpots) {
    const hill = new THREE.Mesh(hillGeo, hillMat);
    hill.position.set(x, 0, z);
    hill.scale.set(radius, height, radius);
    hill.rotation.y = rand(0, Math.PI);
    R.scene.add(hill);
  }
}

export function initWorld(_game: GameState): void {
  buildGround();
  buildSpawnGate();
  buildProps();

  R.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x4a5d3a, 0.85));
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(40, 60, -30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Cover the field (z=-80) through the keep (z=27) in the shadow frustum
  sun.shadow.camera.left = -80;
  sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80;
  sun.shadow.camera.bottom = -80;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0005;
  R.scene.add(sun);
}
