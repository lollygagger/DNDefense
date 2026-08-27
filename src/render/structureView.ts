import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { Socket, StructureInstance } from '../sim/types';
import { ARMORY_DEF_ID, CROSSBOW_DEF_ID, type CrossbowInstance } from '../sim/structures';
import { R } from './scene';

/** Owned by [structures-allies]. Crossbow/armory meshes in sockets, upgrade looks (ballista
 *  bulk, rapid glow), recoil animation. Reads sim state only, never mutates it. Polls wall
 *  sockets every render frame — simple and automatically robust to walls/structures being
 *  rebuilt or destroyed underneath us. */

const RECOIL_DURATION = 0.15; // seconds
const RECOIL_DIST = 0.14; // local -Z kick distance

interface Rec {
  defId: string;
  group: THREE.Group;
  // crossbow-only
  recoilPivot?: THREE.Group;
  limbsMesh?: THREE.Mesh;
  accentMesh?: THREE.Mesh;
  // armory-only
  trimMesh?: THREE.Mesh;
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

  const hutMat = new THREE.MeshLambertMaterial({ color: 0x8a7355, flatShading: true });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a3f2c, flatShading: true });
  const bannerMat = new THREE.MeshLambertMaterial({ color: 0x2f5fa8, flatShading: true, side: THREE.DoubleSide });
  const rackMat = new THREE.MeshLambertMaterial({ color: 0x4a4a4a, flatShading: true });
  const swordMat = new THREE.MeshLambertMaterial({ color: 0xcccccc, flatShading: true });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xd4af37, flatShading: true });

  const hutBaseGeo = new THREE.BoxGeometry(2.2, 1.3, 1.8);
  const hutRoofGeo = new THREE.ConeGeometry(1.7, 0.9, 4);
  const bannerGeo = new THREE.PlaneGeometry(0.5, 0.9);
  const rackGeo = new THREE.BoxGeometry(0.9, 0.9, 0.15);
  const swordGeo = new THREE.BoxGeometry(0.08, 0.6, 0.08);
  const trimGeo = new THREE.BoxGeometry(0.3, 0.15, 0.3);

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

  function buildArmoryRec(): Rec {
    const group = new THREE.Group();
    // Sits in the courtyard behind the wall now (socket.worldPos moved off the wall top — see
    // data/castle.ts's CHAMBER_BUILDING_OFFSET); face the banner/rack side back toward the wall's
    // sally-port archway the allies emerge from, same Math.PI this always used.
    group.rotation.y = Math.PI;

    const base = new THREE.Mesh(hutBaseGeo, hutMat);
    base.position.set(0, 0.65, 0);
    group.add(base);

    const roof = new THREE.Mesh(hutRoofGeo, roofMat);
    roof.position.set(0, 1.3 + 0.45, 0);
    roof.rotation.y = Math.PI / 4;
    group.add(roof);

    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.set(-0.6, 0.95, 0.93);
    group.add(banner);

    const rack = new THREE.Mesh(rackGeo, rackMat);
    rack.position.set(0.7, 0.5, 0.93);
    group.add(rack);

    const sword1 = new THREE.Mesh(swordGeo, swordMat);
    sword1.position.set(0.55, 0.78, 0.97);
    sword1.rotation.z = 0.3;
    group.add(sword1);
    const sword2 = new THREE.Mesh(swordGeo, swordMat);
    sword2.position.set(0.85, 0.78, 0.97);
    sword2.rotation.z = -0.3;
    group.add(sword2);

    const trim = new THREE.Mesh(trimGeo, trimMat);
    trim.position.set(0, 1.42, 0);
    trim.visible = false;
    group.add(trim);

    R.scene.add(group);
    return { defId: ARMORY_DEF_ID, group, trimMesh: trim };
  }

  function updateCrossbowRec(rec: Rec, structure: StructureInstance, socket: Socket, g: GameState): void {
    const cb = structure as CrossbowInstance;
    rec.group.position.copy(socket.muzzlePos);
    rec.group.rotation.y = cb.aimYaw;

    const isBallista = structure.purchased.includes('ballista1') || structure.purchased.includes('ballista2');
    const isRapid = structure.purchased.includes('rapid1') || structure.purchased.includes('rapid2');

    rec.group.scale.setScalar(isBallista ? 1.35 : 1);
    if (rec.limbsMesh) rec.limbsMesh.material = isBallista ? limbMetalMat : limbWoodMat;
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

  function updateArmoryRec(rec: Rec, structure: StructureInstance, socket: Socket): void {
    rec.group.position.copy(socket.worldPos);
    if (rec.trimMesh) rec.trimMesh.visible = structure.purchased.length > 0;
  }

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
            if (rec) {
              R.scene.remove(rec.group);
            }
            rec = structure.defId === CROSSBOW_DEF_ID ? buildCrossbowRec() : buildArmoryRec();
            active.set(socket.id, rec);
          }

          if (rec.defId === CROSSBOW_DEF_ID) updateCrossbowRec(rec, structure, socket, g);
          else updateArmoryRec(rec, structure, socket);
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
