import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { Socket, Wall } from '../sim/types';
import { R } from './scene';
import {
  CHAMBER_ARCH_HEIGHT,
  CHAMBER_ARCH_WIDTH,
  CHAMBER_BUILDING_OFFSET,
  MERLON_DEPTH,
  MERLON_HEIGHT,
  MERLON_SPACING,
  MERLON_WIDTH,
  PARAPET_HEIGHT,
  STAIR_HALF_WIDTH,
  STAIR_LENGTH,
  STAIR_X,
  WALL_HALF_WIDTH,
  WALL_HEIGHT,
  WALL_THICKNESS,
} from '../data/castle';

/** Owned by [world-castle]. Castle visuals: crenellated walls, stair ramps, damage tint,
 *  rubble, ghost outlines for unbuilt tiers, glowing empty-socket markers, wall HP bars.
 *  Reads sim state every frame (never mutates it); walkable surfaces match
 *  sim/castle.worldHeight exactly — wall tops at y=WALL_HEIGHT over z in [w.z, w.z+THICKNESS],
 *  stair ramps behind descending linearly over STAIR_LENGTH. Everything above WALL_HEIGHT
 *  (parapet, merlons, banners) is cosmetic. */

const W = WALL_HALF_WIDTH;
const H = WALL_HEIGHT;
const T = WALL_THICKNESS;

const STONE_BASE: Record<number, number> = { 1: 0xa9a49a, 2: 0x9da3a8, 3: 0xaaa2ae };
const CHARRED = new THREE.Color(0x3a3430);

/** Solid ramp: y=h at the z=0 edge sloping to y=0 at z=len — matches worldHeight's stair math. */
function makeStairGeo(hw: number, h: number, len: number): THREE.BufferGeometry {
  const A = [-hw, 0, 0], B = [hw, 0, 0], C = [hw, 0, len], D = [-hw, 0, len];
  const E = [-hw, h, 0], F = [hw, h, 0];
  const tris = [E, D, C, E, C, F, A, E, F, A, F, B, A, D, E, B, F, C];
  const positions = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => positions.set(v, i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

interface WallView {
  wall: Wall;
  intactGroup: THREE.Group;
  ghostGroup: THREE.Group | null;
  rubble: THREE.InstancedMesh;
  stoneMat: THREE.MeshLambertMaterial;
  baseColor: THREE.Color;
  lastFrac: number;
  hpBar: THREE.Group;
  hpFill: THREE.Mesh;
  hpFillMat: THREE.MeshBasicMaterial;
  markers: { socket: Socket; group: THREE.Group }[];
}

export function initCastleView(game: GameState): void {
  // ---- shared geometries / materials ----
  const bodyGeo = new THREE.BoxGeometry(W * 2, H, T);
  const parapetGeo = new THREE.BoxGeometry(W * 2, PARAPET_HEIGHT, MERLON_DEPTH);
  const merlonGeo = new THREE.BoxGeometry(MERLON_WIDTH, MERLON_HEIGHT, MERLON_DEPTH);
  const stairGeo = makeStairGeo(STAIR_HALF_WIDTH, H, STAIR_LENGTH);
  const foundationGeo = new THREE.BoxGeometry(W * 2, 0.24, T);
  const ghostEdgesGeo = new THREE.EdgesGeometry(bodyGeo);
  const rubbleGeo = new THREE.DodecahedronGeometry(0.8, 0);
  // Chamber sally-port archway: a cosmetic opening through the wall (front + back faces) so the
  // barracks — now in the courtyard behind the wall, see CHAMBER_BUILDING_OFFSET — reads as
  // connected to the field by a doorway. Never a real hole: sim/castle.ts's blocksProjectile
  // keeps the whole wall body solid regardless of x, on purpose (see its doc comment).
  const archOpeningGeo = new THREE.PlaneGeometry(CHAMBER_ARCH_WIDTH, CHAMBER_ARCH_HEIGHT);
  const archLintelGeo = new THREE.BoxGeometry(CHAMBER_ARCH_WIDTH + 0.6, 0.35, 0.5);
  const slitFrameGeo = new THREE.PlaneGeometry(1.0, 2.8);
  const slitGlowGeo = new THREE.PlaneGeometry(0.45, 2.3);
  const plateGeo = new THREE.PlaneGeometry(1.1, 1.1);
  // Sized ~to the barracks' own footprint now that it marks a ground-level building plot in the
  // courtyard rather than a small wall-top glyph (was 0.5-0.85, tuned for the old position).
  const chamberRingGeo = new THREE.RingGeometry(0.9, 1.3, 24);
  const hpBgGeo = new THREE.BoxGeometry(8, 0.6, 0.05);
  const hpFillGeo = new THREE.BoxGeometry(7.7, 0.42, 0.09);

  const ghostFillMat = new THREE.MeshBasicMaterial({
    color: 0x9fd8ff, transparent: true, opacity: 0.08, depthWrite: false,
  });
  const ghostLineMat = new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.4 });
  const foundationMat = new THREE.MeshLambertMaterial({ color: 0x6f6a62, flatShading: true });
  const rubbleMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const doorMat = new THREE.MeshLambertMaterial({ color: 0x2e2620 });
  const slitFrameMat = new THREE.MeshBasicMaterial({ color: 0x1c1f26 });
  const embGlowMat = new THREE.MeshBasicMaterial({
    color: 0x59d8ff, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide,
  });
  const chamberGlowMat = new THREE.MeshBasicMaterial({
    color: 0xffc94d, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide,
  });
  const hpBgMat = new THREE.MeshBasicMaterial({ color: 0x2a1616, transparent: true, opacity: 0.85 });
  const bannerPoleMat = new THREE.MeshLambertMaterial({ color: 0x4a3826 });
  const bannerMat = new THREE.MeshLambertMaterial({ color: 0x6b3fa0, side: THREE.DoubleSide });

  const views: WallView[] = [];
  const destroyed: Record<number, boolean> = { 1: false, 2: false, 3: false };
  game.events.on('wall:destroyed', ({ tier }) => { destroyed[tier] = true; });
  game.events.on('wall:built', ({ tier }) => { destroyed[tier] = false; });

  for (const w of game.castle.walls) {
    const baseColor = new THREE.Color(STONE_BASE[w.tier]);
    const stoneMat = new THREE.MeshLambertMaterial({ color: baseColor.clone(), flatShading: true });

    // ---- intact wall ----
    const g = new THREE.Group();
    g.position.set(0, 0, w.z); // local z: 0 = front face, T = back face

    const body = new THREE.Mesh(bodyGeo, stoneMat);
    body.position.set(0, H / 2, T / 2);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const parapet = new THREE.Mesh(parapetGeo, stoneMat);
    parapet.position.set(0, H + PARAPET_HEIGHT / 2, MERLON_DEPTH / 2 - 0.2);
    parapet.castShadow = true;
    g.add(parapet);

    // Even count, symmetric about x=0, so a crenel gap (not a merlon) sits exactly on x=0 and
    // x=±12 (the embrasure sockets) — sim/castle.ts's blocksProjectile assumes this same
    // symmetric/even layout for its projectile-blocking query. See docs/ARCHITECTURE.md.
    const rawMerlonCount = Math.floor((2 * (W - 1)) / MERLON_SPACING) + 1;
    const merlonCount = rawMerlonCount % 2 === 0 ? rawMerlonCount : rawMerlonCount - 1;
    const merlons = new THREE.InstancedMesh(merlonGeo, stoneMat, merlonCount);
    const dummy = new THREE.Object3D();
    const startX = -((merlonCount - 1) * MERLON_SPACING) / 2;
    for (let i = 0; i < merlonCount; i++) {
      dummy.position.set(
        startX + i * MERLON_SPACING,
        H + PARAPET_HEIGHT + MERLON_HEIGHT / 2,
        MERLON_DEPTH / 2 - 0.2
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      merlons.setMatrixAt(i, dummy.matrix);
    }
    merlons.castShadow = true;
    g.add(merlons);

    for (const sx of [-STAIR_X, STAIR_X]) {
      const stair = new THREE.Mesh(stairGeo, stoneMat);
      stair.position.set(sx, 0, T); // ramp runs from the back face outward
      stair.castShadow = true;
      stair.receiveShadow = true;
      g.add(stair);
    }

    if (w.tier === 3) {
      for (const sx of [-19, 19]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6), bannerPoleMat);
        pole.position.set(sx, H + 1.6, T - 0.5);
        g.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.75), bannerMat);
        flag.position.set(sx - Math.sign(sx) * 0.62, H + 2.7, T - 0.5);
        g.add(flag);
      }
    }

    // ---- socket markers (visible only while the socket is empty) ----
    const markers: WallView['markers'] = [];
    for (const s of w.sockets) {
      const mg = new THREE.Group();
      if (s.kind === 'embrasure') {
        const frame = new THREE.Mesh(slitFrameGeo, slitFrameMat);
        frame.position.set(s.localX, s.muzzlePos.y, -0.02);
        frame.rotation.y = Math.PI;
        mg.add(frame);
        const glow = new THREE.Mesh(slitGlowGeo, embGlowMat);
        glow.position.set(s.localX, s.muzzlePos.y, -0.06);
        glow.rotation.y = Math.PI;
        mg.add(glow);
        const plate = new THREE.Mesh(plateGeo, embGlowMat);
        plate.position.set(s.localX, H + 0.03, T / 2);
        plate.rotation.x = -Math.PI / 2;
        mg.add(plate);
      } else {
        // Ground-level ring in the courtyard, at the barracks building's own spot (s.worldPos
        // is wall-local (localX, 0, T + CHAMBER_BUILDING_OFFSET) here) — marks where the
        // building will go now that it's off the wall top, not on it.
        const ring = new THREE.Mesh(chamberRingGeo, chamberGlowMat);
        ring.position.set(s.localX, 0.03, T + CHAMBER_BUILDING_OFFSET);
        ring.rotation.x = -Math.PI / 2;
        mg.add(ring);
      }
      g.add(mg);
      markers.push({ socket: s, group: mg });

      // Sally-port archway through the wall for chambers (permanent wall dressing, both faces —
      // cosmetic only, see archOpeningGeo's comment). Front face (facing the field) mirrors the
      // original door; back face (facing the courtyard/barracks) is new.
      if (s.kind === 'chamber') {
        for (const faceZ of [-0.02, T + 0.02]) {
          const intoCourtyard = faceZ > 0;
          const arch = new THREE.Mesh(archOpeningGeo, doorMat);
          arch.position.set(s.localX, CHAMBER_ARCH_HEIGHT / 2, faceZ);
          arch.rotation.y = intoCourtyard ? 0 : Math.PI;
          g.add(arch);
          const lintel = new THREE.Mesh(archLintelGeo, stoneMat);
          lintel.position.set(s.localX, CHAMBER_ARCH_HEIGHT + 0.02, faceZ);
          g.add(lintel);
        }
      }
    }
    R.scene.add(g);

    // ---- ghost outline for unbuilt tiers 1-2 ----
    let ghostGroup: THREE.Group | null = null;
    if (w.tier !== 3) {
      ghostGroup = new THREE.Group();
      ghostGroup.position.set(0, 0, w.z);
      const fill = new THREE.Mesh(bodyGeo, ghostFillMat);
      fill.position.set(0, H / 2, T / 2);
      ghostGroup.add(fill);
      const edges = new THREE.LineSegments(ghostEdgesGeo, ghostLineMat);
      edges.position.copy(fill.position);
      ghostGroup.add(edges);
      const slab = new THREE.Mesh(foundationGeo, foundationMat);
      slab.position.set(0, 0.12, T / 2);
      slab.receiveShadow = true;
      ghostGroup.add(slab);
      R.scene.add(ghostGroup);
    }

    // ---- rubble (decorative, non-blocking; shown after wall:destroyed) ----
    const rubble = new THREE.InstancedMesh(rubbleGeo, rubbleMat, 18);
    const col = new THREE.Color();
    for (let i = 0; i < 18; i++) {
      const s = 0.5 + Math.random() * 1.2;
      dummy.position.set(
        (Math.random() * 2 - 1) * (W - 1),
        s * 0.35,
        w.z - 1.2 + Math.random() * (T + 2.4)
      );
      dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      dummy.scale.set(s, s * (0.5 + Math.random() * 0.4), s);
      dummy.updateMatrix();
      rubble.setMatrixAt(i, dummy.matrix);
      rubble.setColorAt(i, col.setHSL(0.07, 0.05, 0.4 + Math.random() * 0.2));
    }
    rubble.castShadow = true;
    rubble.visible = false;
    R.scene.add(rubble);

    // ---- floating HP bar (billboard, hidden at full HP) ----
    const hpBar = new THREE.Group();
    hpBar.position.set(0, H + PARAPET_HEIGHT + MERLON_HEIGHT + 1.6, w.z + T / 2);
    hpBar.add(new THREE.Mesh(hpBgGeo, hpBgMat));
    const hpFillMat = new THREE.MeshBasicMaterial({ color: 0x44cc55 });
    const hpFill = new THREE.Mesh(hpFillGeo, hpFillMat);
    hpBar.add(hpFill);
    hpBar.visible = false;
    R.scene.add(hpBar);

    views.push({
      wall: w, intactGroup: g, ghostGroup, rubble, stoneMat, baseColor,
      lastFrac: 1, hpBar, hpFill, hpFillMat, markers,
    });
  }

  // ---- per-frame sync (reads sim state only; no allocation) ----
  let t = 0;
  game.addSystem({
    render(dt) {
      t += dt;
      const pulse = 0.45 + 0.3 * Math.sin(t * 2.6);
      embGlowMat.opacity = pulse;
      chamberGlowMat.opacity = 0.45 + 0.3 * Math.sin(t * 2.6 + 1.3);

      for (const v of views) {
        const w = v.wall;
        const intact = w.built && w.hp > 0;
        v.intactGroup.visible = intact;
        if (v.ghostGroup) v.ghostGroup.visible = !w.built;
        v.rubble.visible = destroyed[w.tier];

        if (intact) {
          // damage tint: darken toward charred as hp drops
          const frac = w.hp / w.maxHp;
          if (Math.abs(frac - v.lastFrac) > 0.005) {
            v.lastFrac = frac;
            v.stoneMat.color.copy(v.baseColor).lerp(CHARRED, (1 - frac) * 0.75);
          }
          for (const m of v.markers) m.group.visible = !m.socket.structure;
        }

        // HP bar
        const showBar = intact && w.hp < w.maxHp - 0.5;
        v.hpBar.visible = showBar;
        if (showBar) {
          const frac = Math.max(0, w.hp / w.maxHp);
          v.hpFill.scale.x = Math.max(frac, 0.001);
          v.hpFill.position.x = -3.85 * (1 - frac);
          v.hpFillMat.color.setHSL(frac * 0.32, 0.72, 0.45);
          v.hpBar.quaternion.copy(R.camera.quaternion);
        }
      }
    },
  });
}
