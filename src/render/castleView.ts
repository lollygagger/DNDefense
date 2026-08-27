import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { Socket, Wall, WallTier } from '../sim/types';
import { R } from './scene';
import {
  CHAMBER_ARCH_HEIGHT,
  CHAMBER_ARCH_WIDTH,
  CHAMBER_BUILDING_OFFSET,
  LADDER_RAIL_HALF_SPAN,
  LADDER_RUNG_SPACING,
  LADDER_STANDOFF,
  LADDER_XS,
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
 *  rubble, ghost outlines for unbuilt tiers, glowing empty-socket markers, wall HP bars, ladders.
 *  Reads sim state every frame (never mutates it); walkable surfaces match
 *  sim/castle.worldHeight exactly — wall tops at y=WALL_HEIGHT over z in [w.z, w.z+THICKNESS],
 *  stair ramps behind descending linearly over STAIR_LENGTH. Everything above WALL_HEIGHT
 *  (parapet, merlons, banners, ladders) is cosmetic — including the Higher Battlements upgrade's
 *  extra merlon height (see wallMerlonBonus below): it deepens cover, never adds walkable
 *  surface, and a ladder is a climb-mode trigger for player/controller.ts, never a walkable
 *  surface either (see sim/ladders.ts). Ladder x-positions/standoff/inset are computed here from
 *  the exact same data/castle.ts constants sim/ladders.ts uses — independently derived rather
 *  than imported, the same "shared constants, not shared runtime code" split merlon geometry
 *  already follows between this file and sim/castleBlocking.ts — so the rails/rungs always land
 *  precisely where a player standing in front of them can actually grab one.
 *  Also handles three purely-additive late-game/phase changes: a wall's merlons growing taller
 *  (Higher Battlements), brand-new sockets appearing mid-run (purchased wall expansion), and a
 *  front ladder swinging up flat against the wall top the instant combat starts (see the
 *  FRONT_OUTWARD stow rotation below) — all three detected by polling sim state once a frame
 *  rather than needing new events. */

/** Non-frozen wall-upgrade query, read off game.castle via a narrow local interface + cast —
 *  the same pattern sim/projectiles.ts uses for blocksProjectile (see docs/ARCHITECTURE.md).
 *  Wall (sim/types.ts) is FROZEN and has no room for per-wall upgrade state, so sim/castle.ts
 *  keeps it internally and exposes just this query. */
interface WallCosmetics {
  wallMerlonBonus(tier: WallTier): number;
}

/** Sets one merlon instance's transform: `bonus` (Higher Battlements) grows the box upward from
 *  a fixed bottom edge (the parapet top never moves) by scaling Y and re-centering — matches
 *  sim/castleBlocking.ts's MERLON_TOP + bonus exactly, so the visual and the projectile-blocking
 *  geometry never disagree. */
function setMerlonDummy(dummy: THREE.Object3D, i: number, startX: number, bonus: number): void {
  const h = MERLON_HEIGHT + bonus;
  dummy.position.set(startX + i * MERLON_SPACING, H + PARAPET_HEIGHT + h / 2, MERLON_DEPTH / 2 - 0.2);
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, h / MERLON_HEIGHT, 1);
  dummy.updateMatrix();
}

const W = WALL_HALF_WIDTH;
const H = WALL_HEIGHT;
const T = WALL_THICKNESS;

// Ladders stand proud of the face they're mounted on: -1 (front, field-facing) swings/stands
// toward -z, +1 (back, courtyard-facing) toward +z. Matches sim/ladders.ts's climbZ sign for
// the same face exactly (both derive it from the same LADDER_STANDOFF constant).
const FRONT_OUTWARD = -1;
const BACK_OUTWARD = 1;

/** One ladder's rails + rungs, authored hanging DOWN from a hinge at the top of the wall face
 *  (the returned group's own local origin = that hinge point, in the wall group's local space:
 *  (x, WALL_HEIGHT, faceZLocal)). Everything below is built in coordinates relative to that
 *  hinge so a single `rotation.x` flip (see the render loop's front-ladder stow toggle) swings
 *  the whole thing between "deployed" (hanging straight down the face — climbable) and "stowed"
 *  (lying flat along the wall-top walkway, out of the way) with no geometry rebuild: rotating a
 *  point that hangs down by h at outward offset s by ±90° about X sends it to (s, h) in (y, z)
 *  relative to the hinge — i.e. flat at the walkway surface, extending inward by exactly the
 *  length it used to hang down. `outward` (FRONT_OUTWARD/BACK_OUTWARD) picks both the standoff
 *  direction and (in the render loop) the stow rotation's sign so it always swings UP and IN,
 *  never through the stone. */
function buildLadderPivot(x: number, faceZLocal: number, outward: number, railGeo: THREE.BufferGeometry, rungGeo: THREE.BufferGeometry, mat: THREE.Material): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, H, faceZLocal);
  const s = outward * LADDER_STANDOFF;
  for (const rx of [-LADDER_RAIL_HALF_SPAN, LADDER_RAIL_HALF_SPAN]) {
    const rail = new THREE.Mesh(railGeo, mat);
    rail.position.set(rx, -H / 2, s);
    pivot.add(rail);
  }
  for (let ry = LADDER_RUNG_SPACING; ry < H; ry += LADDER_RUNG_SPACING) {
    const rung = new THREE.Mesh(rungGeo, mat);
    rung.rotation.z = Math.PI / 2; // lay the cylinder along local X, spanning between the rails
    rung.position.set(0, ry - H, s);
    pivot.add(rung);
  }
  return pivot;
}

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
  // Higher Battlements: this wall's merlon InstancedMesh + the layout needed to rebuild its
  // instance transforms on demand, plus the last-applied bonus so the (rare) rebuild only runs
  // when it actually changes rather than every frame.
  merlons: THREE.InstancedMesh;
  merlonCount: number;
  merlonStartX: number;
  lastMerlonBonus: number;
  // Socket expansion: how many of w.sockets already have rendered markers, so a newly-purchased
  // socket (pushed onto the live array after initCastleView already ran) gets its marker built
  // the first frame it appears instead of staying invisible forever.
  lastSocketCount: number;
  // Ladders: only the front ones ever change state (stowed during combat) — see the module doc
  // comment and the render loop's front-ladder stow toggle below.
  frontLadders: THREE.Group[];
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
  // Ladders: plain wooden rails/rungs, shared geometry+material across all 4 grab-points/wall
  // (front x2 + back x2 — see LADDER_XS) x 3 walls. Only a dozen ladders total, so plain Meshes
  // (like the stairs/banners above) rather than InstancedMesh — this file's convention reserves
  // instancing for things that appear in real numbers (merlons, enemies).
  const ladderRailGeo = new THREE.CylinderGeometry(0.05, 0.05, H, 6);
  const ladderRungGeo = new THREE.CylinderGeometry(0.04, 0.04, LADDER_RAIL_HALF_SPAN * 2, 6);
  const ladderWoodMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2a, flatShading: true });

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

  /** Builds one socket's marker (embrasure slit / chamber ring) +, for a chamber, its sally-port
   *  archway — extracted so a socket purchased mid-run (Higher Battlements' sibling expansion
   *  nodes, sim/wallUpgrades.ts) can get the exact same visual the initial 5 get at construction
   *  time, from the per-frame sync loop below instead of only at initCastleView time. */
  function addSocketVisuals(g: THREE.Group, s: Socket, stoneMat: THREE.MeshLambertMaterial, markers: WallView['markers']): void {
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
      setMerlonDummy(dummy, i, startX, 0); // no Higher Battlements bonus yet — see the render loop
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

    // ---- ladders: back (always usable, never stowed) + front (build-phase-only — the render
    // loop below swings these up flat against the wall top the instant combat starts, mirroring
    // sim/ladders.ts's isLadderUsable gate exactly, polled once a frame like Higher Battlements'
    // merlon bonus). Both faces at both LADDER_XS positions, matching sim/ladders.ts's geometry. ----
    const frontLadders: THREE.Group[] = [];
    for (const x of LADDER_XS) {
      const front = buildLadderPivot(x, 0, FRONT_OUTWARD, ladderRailGeo, ladderRungGeo, ladderWoodMat);
      g.add(front);
      frontLadders.push(front);
      const back = buildLadderPivot(x, T, BACK_OUTWARD, ladderRailGeo, ladderRungGeo, ladderWoodMat);
      g.add(back);
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
    for (const s of w.sockets) addSocketVisuals(g, s, stoneMat, markers);
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
      merlons, merlonCount, merlonStartX: startX, lastMerlonBonus: 0,
      lastSocketCount: w.sockets.length,
      frontLadders,
    });
  }

  // ---- per-frame sync (reads sim state only; no allocation) ----
  let t = 0;
  // Front-ladder stow state: driven purely by game.phase (see sim/ladders.ts's isLadderUsable),
  // so one flag covers every wall — only re-applied to the meshes when it actually flips, same
  // "poll once a frame, touch transforms only on change" idiom Higher Battlements' merlon rebuild
  // uses below.
  let lastFrontUsable = game.phase !== 'combat';
  const dummy2 = new THREE.Object3D(); // scratch for merlon-rebuild transforms below, kept out of the hot per-view loop's closures
  game.addSystem({
    render(dt) {
      t += dt;
      const pulse = 0.45 + 0.3 * Math.sin(t * 2.6);
      embGlowMat.opacity = pulse;
      chamberGlowMat.opacity = 0.45 + 0.3 * Math.sin(t * 2.6 + 1.3);

      // Front ladders: build-phase-only, mirroring sim/ladders.ts's isLadderUsable exactly (same
      // game.phase !== 'combat' test). The instant combat starts they swing up flush against the
      // wall top instead of just vanishing — deliberately "pulled up," not a pop — and swing back
      // down the instant the wave clears. One flag for every wall since it's phase-driven, not
      // per-wall state; only touches the meshes on the (rare) frame it actually flips.
      const frontUsable = game.phase !== 'combat';
      if (frontUsable !== lastFrontUsable) {
        lastFrontUsable = frontUsable;
        const stowRot = FRONT_OUTWARD * (Math.PI / 2);
        for (const v of views) {
          for (const pivot of v.frontLadders) pivot.rotation.x = frontUsable ? 0 : stowRot;
        }
      }

      const wallCosmetics = game.castle as unknown as WallCosmetics;

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

          // Higher Battlements: rebuild merlon transforms only when the bonus actually changed
          // (a rare, purchase-driven event) — not a per-frame allocation/update in the common case.
          const bonus = wallCosmetics.wallMerlonBonus(w.tier);
          if (bonus !== v.lastMerlonBonus) {
            v.lastMerlonBonus = bonus;
            for (let i = 0; i < v.merlonCount; i++) {
              setMerlonDummy(dummy2, i, v.merlonStartX, bonus);
              v.merlons.setMatrixAt(i, dummy2.matrix);
            }
            v.merlons.instanceMatrix.needsUpdate = true;
          }

          // Socket expansion: a wall-upgrade purchase (sim/castle.ts's upgradeWall) can push a
          // brand-new Socket onto w.sockets mid-run; give it the same marker/archway a socket
          // built at construction time gets, the first frame it shows up.
          if (w.sockets.length > v.lastSocketCount) {
            for (let i = v.lastSocketCount; i < w.sockets.length; i++) {
              addSocketVisuals(v.intactGroup, w.sockets[i], v.stoneMat, v.markers);
            }
            v.lastSocketCount = w.sockets.length;
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
