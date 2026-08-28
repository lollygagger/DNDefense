import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { Socket, StructureInstance } from '../sim/types';
import {
  ARC_LIGHTNING_DEF_ID,
  ARCHER_BARRACKS_DEF_ID,
  ARMORY_DEF_ID,
  CROSSBOW_DEF_ID,
  FIELD_HOSPITAL_DEF_ID,
  FLAMETHROWER_DEF_ID,
  getStructureDef,
  MAGE_TOWER_DEF_ID,
  TANK_BARRACKS_DEF_ID,
  type ArcLightningInstance,
  type CrossbowInstance,
  type FlamethrowerInstance,
} from '../sim/structures';
import { R } from './scene';
import { FLAMETHROWER } from '../data/structures';
import {
  buildArcherBarracksRec,
  buildArmoryRec,
  buildFieldHospitalRec,
  buildMageTowerRec,
  buildTankBarracksRec,
} from './structures/spawnerHuts';

/** Owned by [structures-allies]. Meshes for every embrasure/chamber structure. Chamber-socket
 *  spawner buildings (Armory, Archer Barracks, Mage Tower, Tank Barracks, Field Hospital) live in
 *  ./structures/spawnerHuts.ts (split out to stay under the ~400-line guideline once the two new
 *  embrasure turrets below needed room) — this file is the render driver plus the three
 *  embrasure/muzzle-mounted turrets (Crossbow, Flamethrower, Arc Lightning), which all share the
 *  "sits at the socket's muzzlePos, rotates to aimYaw" update shape the huts don't need. Reads
 *  sim state only, never mutates it. Polls wall sockets every render frame — simple and
 *  automatically robust to walls/structures being rebuilt or destroyed underneath us. */

const RECOIL_DURATION = 0.15; // seconds
const RECOIL_DIST = 0.14; // local -Z kick distance

export interface Rec {
  defId: string;
  group: THREE.Group;
  // turret structures (crossbow/flamethrower/arc lightning): recoil/kick pivot
  recoilPivot?: THREE.Group;
  limbsMesh?: THREE.Mesh;
  accentMesh?: THREE.Mesh;
  // any hut-style spawner building: a "has upgrades" glow indicator
  trimMesh?: THREE.Mesh;
  // mage tower / arc lightning: idle pulse on a glowing orb
  orbMesh?: THREE.Mesh;
  // any hut-style spawner building: a second, brighter "has bought a 600g/1600g high tier" tell
  // (late-game spawner-upgrades task, 2026-08-27) — distinct from trimMesh, which lights up on
  // ANY purchase (even a cheap 70g one). See hasHighTier()/updateHutRec() below.
  eliteMesh?: THREE.Mesh;
}

/** True once a structure owns any node from its late-game 600g/1600g high tier (late-game
 *  spawner-upgrades task, 2026-08-27) — driven by the def's own upgrade cost rather than a
 *  hardcoded id list, so this works for all five current spawners (and any future one) with no
 *  per-building branching here: every high-tier node costs >=600g, every cheap-tier node costs
 *  well under that (see data/structures.ts). */
function hasHighTier(structure: StructureInstance): boolean {
  const def = getStructureDef(structure.defId);
  if (!def) return false;
  return structure.purchased.some((id) => {
    const node = def.upgrades.find((n) => n.id === id);
    return (node?.cost ?? 0) >= 600;
  });
}

export function initStructureView(game: GameState): void {
  // ---- shared geometries/materials, built once ----
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2c, flatShading: true });
  const stockMat = new THREE.MeshLambertMaterial({ color: 0x4a3220, flatShading: true });
  const limbWoodMat = new THREE.MeshLambertMaterial({ color: 0x8a6a3c, flatShading: true });
  const limbMetalMat = new THREE.MeshLambertMaterial({ color: 0x3c3f45, flatShading: true });
  const boltMat = new THREE.MeshLambertMaterial({ color: 0xcbb994, flatShading: true });
  const rapidAccentMat = new THREE.MeshBasicMaterial({ color: 0xfff06b });

  const cbMountGeo = new THREE.BoxGeometry(0.9, 0.5, 1.1);
  const cbStockGeo = new THREE.BoxGeometry(0.32, 0.32, 1.2);
  const cbLimbGeo = new THREE.BoxGeometry(1.6, 0.16, 0.16);
  const cbBoltGeo = new THREE.CylinderGeometry(0.045, 0.06, 0.9, 6);
  const cbAccentGeo = new THREE.SphereGeometry(0.12, 8, 6);

  // Flamethrower turret parts — a squat fuel tank + wide nozzle, reusing the crossbow's metal
  // palette so all three embrasure turrets read as one "family" of wall-mounted hardware.
  const flameTankGeo = new THREE.CylinderGeometry(0.3, 0.34, 0.7, 8);
  const flameNozzleGeo = new THREE.CylinderGeometry(0.22, 0.13, 0.55, 8);
  const flameGlowGeo = new THREE.ConeGeometry(0.26, 0.6, 8);
  const flameGlowMat = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.75 });

  // Arc Lightning turret parts — a slim conductor rod topped with a crackling orb.
  const rodGeo = new THREE.CylinderGeometry(0.05, 0.07, 1.1, 6);
  const lightningOrbGeo = new THREE.OctahedronGeometry(0.24, 0);
  const lightningOrbMat = new THREE.MeshBasicMaterial({ color: 0xd6f3ff, transparent: true, opacity: 0.9 });

  function buildCrossbowRec(): Rec {
    const group = new THREE.Group();

    const mount = new THREE.Mesh(cbMountGeo, woodMat);
    mount.position.set(0, -0.1, 0.15);
    group.add(mount);

    // limbs/stock/bolt/accent live on a small pivot so recoil can kick it straight back
    const recoilPivot = new THREE.Group();
    group.add(recoilPivot);

    const stock = new THREE.Mesh(cbStockGeo, stockMat);
    stock.position.set(0, 0.05, 0.45);
    recoilPivot.add(stock);

    const limbs = new THREE.Mesh(cbLimbGeo, limbWoodMat);
    limbs.position.set(0, 0.08, -0.35);
    recoilPivot.add(limbs);

    const bolt = new THREE.Mesh(cbBoltGeo, boltMat);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(0, 0.1, 0.05);
    recoilPivot.add(bolt);

    const accent = new THREE.Mesh(cbAccentGeo, rapidAccentMat);
    accent.position.set(0, 0.28, 0.35);
    accent.visible = false;
    recoilPivot.add(accent);

    R.scene.add(group);
    return { defId: CROSSBOW_DEF_ID, group, recoilPivot, limbsMesh: limbs, accentMesh: accent };
  }

  /** Squat fuel tank + wide nozzle + a glowing cone standing in for the flame jet, visible only
   *  while `active` (see FlamethrowerInstance) so it doesn't look permanently lit regardless of
   *  whether anything is actually in range. */
  function buildFlamethrowerRec(): Rec {
    const group = new THREE.Group();

    const mount = new THREE.Mesh(cbMountGeo, woodMat);
    mount.position.set(0, -0.1, 0.15);
    group.add(mount);

    const recoilPivot = new THREE.Group();
    group.add(recoilPivot);

    const tank = new THREE.Mesh(flameTankGeo, limbMetalMat);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(0, 0.15, 0.4);
    recoilPivot.add(tank);

    const nozzle = new THREE.Mesh(flameNozzleGeo, stockMat);
    nozzle.rotation.x = -Math.PI / 2;
    nozzle.position.set(0, 0.12, -0.25);
    recoilPivot.add(nozzle);

    const glow = new THREE.Mesh(flameGlowGeo, flameGlowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, 0.12, -0.75);
    glow.visible = false;
    recoilPivot.add(glow);

    R.scene.add(group);
    return { defId: FLAMETHROWER_DEF_ID, group, recoilPivot, limbsMesh: nozzle, accentMesh: glow };
  }

  /** A slim rod topped with a crackling orb — the orb flashes brighter on every shot (see
   *  ArcLightningInstance.firedAt) the way the crossbow's stock kicks back on recoil. */
  function buildArcLightningRec(): Rec {
    const group = new THREE.Group();

    const mount = new THREE.Mesh(cbMountGeo, woodMat);
    mount.position.set(0, -0.1, 0.15);
    group.add(mount);

    const recoilPivot = new THREE.Group();
    group.add(recoilPivot);

    const rod = new THREE.Mesh(rodGeo, limbMetalMat);
    rod.rotation.x = Math.PI / 2;
    rod.position.set(0, 0.4, -0.15);
    recoilPivot.add(rod);

    const orb = new THREE.Mesh(lightningOrbGeo, lightningOrbMat);
    orb.position.set(0, 0.4, -0.7);
    recoilPivot.add(orb);

    R.scene.add(group);
    return { defId: ARC_LIGHTNING_DEF_ID, group, recoilPivot, orbMesh: orb };
  }

  function updateCrossbowRec(rec: Rec, structure: StructureInstance, socket: Socket, g: GameState): void {
    const cb = structure as CrossbowInstance;
    rec.group.position.copy(socket.muzzlePos);
    rec.group.rotation.y = cb.aimYaw;

    const isBallista = structure.purchased.includes('ballista1') || structure.purchased.includes('ballista2');
    const isRapid = structure.purchased.includes('rapid1') || structure.purchased.includes('rapid2');
    const isCannon = structure.purchased.includes('cannon1') || structure.purchased.includes('cannon2');

    rec.group.scale.setScalar(isCannon ? 1.6 : isBallista ? 1.35 : 1);
    if (rec.limbsMesh) rec.limbsMesh.material = isCannon || isBallista ? limbMetalMat : limbWoodMat;
    if (rec.accentMesh) {
      rec.accentMesh.visible = isRapid;
      if (isRapid) rec.accentMesh.scale.setScalar(1 + Math.sin(g.time * 6) * 0.15);
    }

    if (rec.recoilPivot) {
      const since = g.time - cb.firedAt;
      const k = since >= 0 && since < RECOIL_DURATION ? 1 - since / RECOIL_DURATION : 0;
      rec.recoilPivot.position.z = -k * RECOIL_DIST;
    }
  }

  /** Fixed facing (no aim tracking — it bathes its whole cone at once); the glow cone is only
   *  visible while `active` and its length grows with the currently-purchased level's range, so
   *  the model itself hints at the roadmap's "AoE grows with level" instead of a static prop. */
  function updateFlamethrowerRec(rec: Rec, structure: StructureInstance, socket: Socket, g: GameState): void {
    const ft = structure as FlamethrowerInstance;
    rec.group.position.copy(socket.muzzlePos);
    rec.group.rotation.y = ft.aimYaw;
    if (rec.accentMesh) {
      rec.accentMesh.visible = ft.active;
      if (ft.active) {
        const flicker = 1 + Math.sin(g.time * 30) * 0.18;
        rec.accentMesh.scale.set(flicker, flicker, (ft.currentRange / FLAMETHROWER.range) * flicker);
      }
    }
  }

  /** No aim tracking beyond facing the last target (this is a chain hit, not a lead-and-fire
   *  weapon); the orb flashes brighter for a beat right after firing, mirroring the crossbow's
   *  recoil kick as the "something just happened" cue. */
  function updateArcLightningRec(rec: Rec, structure: StructureInstance, socket: Socket, g: GameState): void {
    const al = structure as ArcLightningInstance;
    rec.group.position.copy(socket.muzzlePos);
    rec.group.rotation.y = al.aimYaw;
    if (rec.orbMesh) {
      const since = g.time - al.firedAt;
      const flash = since >= 0 && since < 0.15 ? 1.8 - since * 5 : 1;
      rec.orbMesh.scale.setScalar(flash * (1 + Math.sin(g.time * 10) * 0.08));
    }
  }

  /** Every hut-style spawner building shares this: sit at the socket's ground position, show a
   *  little gold trim once any upgrade has been purchased. The Mage Tower additionally pulses
   *  its finial orb so the tower reads as "active" even at a glance from across the courtyard.
   *  A maxed-out 600g/1600g high tier gets a second, stronger tell on top of the trim — a
   *  hovering, rotating crystal (eliteMesh, per-building color set in spawnerHuts.ts) that only
   *  appears once hasHighTier() is true, so three visual states exist at a glance: fresh (bare
   *  hut), cheap-upgraded (gold trim only), high-tier (trim + glowing crystal). */
  function updateHutRec(rec: Rec, structure: StructureInstance, socket: Socket, g: GameState): void {
    rec.group.position.copy(socket.worldPos);
    if (rec.trimMesh) rec.trimMesh.visible = structure.purchased.length > 0;
    if (rec.orbMesh) {
      const s = 1 + Math.sin(g.time * 2.4) * 0.12;
      rec.orbMesh.scale.setScalar(s);
    }
    if (rec.eliteMesh) {
      const elite = hasHighTier(structure);
      rec.eliteMesh.visible = elite;
      if (elite) {
        rec.eliteMesh.scale.setScalar(1 + Math.sin(g.time * 3) * 0.18);
        rec.eliteMesh.rotation.y = g.time * 1.5;
      }
    }
  }

  const BUILDERS: Record<string, () => Rec> = {
    [CROSSBOW_DEF_ID]: buildCrossbowRec,
    [FLAMETHROWER_DEF_ID]: buildFlamethrowerRec,
    [ARC_LIGHTNING_DEF_ID]: buildArcLightningRec,
    [ARMORY_DEF_ID]: buildArmoryRec,
    [ARCHER_BARRACKS_DEF_ID]: buildArcherBarracksRec,
    [MAGE_TOWER_DEF_ID]: buildMageTowerRec,
    [TANK_BARRACKS_DEF_ID]: buildTankBarracksRec,
    [FIELD_HOSPITAL_DEF_ID]: buildFieldHospitalRec,
  };

  // Turrets sit at the socket's muzzlePos and rotate to face aimYaw; huts sit at the socket's
  // ground worldPos and never rotate beyond their fixed courtyard-facing orientation.
  const TURRET_UPDATERS: Record<string, typeof updateCrossbowRec> = {
    [CROSSBOW_DEF_ID]: updateCrossbowRec,
    [FLAMETHROWER_DEF_ID]: updateFlamethrowerRec,
    [ARC_LIGHTNING_DEF_ID]: updateArcLightningRec,
  };

  const active = new Map<string, Rec>();
  const seen = new Set<string>();

  game.addSystem({
    render(_dt, g) {
      seen.clear();
      for (const wall of g.castle.walls) {
        for (const socket of wall.sockets) {
          const structure = socket.structure;
          if (!structure) continue;
          seen.add(socket.id);

          let rec = active.get(socket.id);
          if (!rec || rec.defId !== structure.defId) {
            if (rec) R.scene.remove(rec.group);
            const build = BUILDERS[structure.defId] ?? buildArmoryRec;
            rec = build();
            active.set(socket.id, rec);
          }

          const updateTurret = TURRET_UPDATERS[rec.defId];
          if (updateTurret) updateTurret(rec, structure, socket, g);
          else updateHutRec(rec, structure, socket, g);
        }
      }

      for (const [id, rec] of active) {
        if (seen.has(id)) continue;
        R.scene.remove(rec.group);
        active.delete(id);
      }
    },
  });
}
