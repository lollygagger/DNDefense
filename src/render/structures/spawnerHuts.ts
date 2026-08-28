import * as THREE from 'three';
import {
  ARCHER_BARRACKS_DEF_ID,
  ARMORY_DEF_ID,
  FIELD_HOSPITAL_DEF_ID,
  MAGE_TOWER_DEF_ID,
  TANK_BARRACKS_DEF_ID,
} from '../../sim/structures';
import { R } from '../scene';
import type { Rec } from '../structureView';

/** Owned by [structures-allies]. The five "timber hut in the courtyard" chamber-socket spawner
 *  buildings (Armory, Archer Barracks, Mage Tower, Tank Barracks, Field Hospital), split out of
 *  structureView.ts (ARCHITECTURE.md: "Keep files under ~400 lines — split rather than grow")
 *  once the two new embrasure turrets (flamethrower, arc lightning) needed room there. Each
 *  builder is a pure factory — no closure state, nothing dynamic — called once per socket by
 *  structureView.ts's render loop and updated generically by that file's `updateHutRec`. Reads
 *  no sim state directly; `R.scene.add` is the only side effect. */

const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2c, flatShading: true });
const hutMat = new THREE.MeshLambertMaterial({ color: 0x8a7355, flatShading: true });
const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a3f2c, flatShading: true });
const stoneRoofMat = new THREE.MeshLambertMaterial({ color: 0x6a6560, flatShading: true });
const bannerMat = new THREE.MeshLambertMaterial({ color: 0x2f5fa8, flatShading: true, side: THREE.DoubleSide });
const greenBannerMat = new THREE.MeshLambertMaterial({ color: 0x3d6b3a, flatShading: true, side: THREE.DoubleSide });
const crimsonBannerMat = new THREE.MeshLambertMaterial({ color: 0x8a2f2f, flatShading: true, side: THREE.DoubleSide });
const whiteBannerMat = new THREE.MeshLambertMaterial({ color: 0xf0f0e8, flatShading: true, side: THREE.DoubleSide });
const rackMat = new THREE.MeshLambertMaterial({ color: 0x4a4a4a, flatShading: true });
const swordMat = new THREE.MeshLambertMaterial({ color: 0xcccccc, flatShading: true });
const trimMat = new THREE.MeshLambertMaterial({ color: 0xd4af37, flatShading: true });
const stoneMat = new THREE.MeshLambertMaterial({ color: 0x7a746c, flatShading: true });
const steelMat = new THREE.MeshLambertMaterial({ color: 0x5a6470, flatShading: true });
const arcaneOrbMat = new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.85 });
const crossMat = new THREE.MeshLambertMaterial({ color: 0xd94f4f, flatShading: true });

// ---- High-tier "elite" glow (late-game spawner-upgrades task, 2026-08-27) — a small hovering,
// rotating crystal that only appears once a structure owns a 600g/1600g high-tier node (see
// hasHighTier()/updateHutRec() in structureView.ts), one distinct color per building so it also
// hints at WHICH high tier without needing to open the menu: blood-red for the Armory's bleed/
// mark branches, verdant for the Archer Barracks' pierce/splash arrows, icy-white for the Mage
// Tower's residue/twin-cast (distinct from its permanent blue finial orb, which is unrelated to
// upgrades), molten orange for the Tank Barracks' retaliation/sustain, and warm gold-white for
// the Field Hospital's guardian/triage capstones.
const eliteCrystalGeo = new THREE.OctahedronGeometry(0.16, 0);
const eliteArmoryMat = new THREE.MeshBasicMaterial({ color: 0xff2f3f, transparent: true, opacity: 0.9 });
const eliteArcherMat = new THREE.MeshBasicMaterial({ color: 0x7dffb0, transparent: true, opacity: 0.9 });
const eliteMageMat = new THREE.MeshBasicMaterial({ color: 0xf0fbff, transparent: true, opacity: 0.9 });
const eliteTankMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.9 });
const eliteHospitalMat = new THREE.MeshBasicMaterial({ color: 0xffe8a0, transparent: true, opacity: 0.9 });

const hutBaseGeo = new THREE.BoxGeometry(2.2, 1.3, 1.8);
const hutRoofGeo = new THREE.ConeGeometry(1.7, 0.9, 4);
const bannerGeo = new THREE.PlaneGeometry(0.5, 0.9);
const rackGeo = new THREE.BoxGeometry(0.9, 0.9, 0.15);
const swordGeo = new THREE.BoxGeometry(0.08, 0.6, 0.08);
const trimGeo = new THREE.BoxGeometry(0.3, 0.15, 0.3);
const bowGeo = new THREE.TorusGeometry(0.34, 0.035, 6, 12, Math.PI);
const towerBaseGeo = new THREE.CylinderGeometry(0.85, 1.0, 2.0, 8);
const towerRoofGeo = new THREE.ConeGeometry(1.05, 1.1, 8);
const orbGeo = new THREE.OctahedronGeometry(0.22, 0);
const fortBaseGeo = new THREE.BoxGeometry(2.6, 1.1, 2.0);
const fortRoofGeo = new THREE.BoxGeometry(2.7, 0.3, 2.1);
const spikeGeo = new THREE.ConeGeometry(0.09, 0.3, 4);
const tentRoofGeo = new THREE.ConeGeometry(1.6, 0.7, 4);
const crossBarGeo = new THREE.BoxGeometry(0.5, 0.14, 0.03);
const crossBarGeo2 = new THREE.BoxGeometry(0.14, 0.5, 0.03);

/** Shared "sits in the courtyard behind the wall, faces the sally-port archway" placement every
 *  chamber-socket building uses (see data/castle.ts's CHAMBER_BUILDING_OFFSET). */
function newHutGroup(): THREE.Group {
  const group = new THREE.Group();
  group.rotation.y = Math.PI;
  return group;
}

export function buildArmoryRec(): Rec {
  const group = newHutGroup();

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

  const elite = new THREE.Mesh(eliteCrystalGeo, eliteArmoryMat);
  elite.position.set(0, 1.75 + 0.45, 0);
  elite.visible = false;
  group.add(elite);

  R.scene.add(group);
  return { defId: ARMORY_DEF_ID, group, trimMesh: trim, eliteMesh: elite };
}

/** Same hut base as the Armory but a green-trimmed roof and a crossed-bow rack instead of
 *  swords, so it reads as the ranged counterpart at a glance. */
export function buildArcherBarracksRec(): Rec {
  const group = newHutGroup();

  const base = new THREE.Mesh(hutBaseGeo, hutMat);
  base.position.set(0, 0.65, 0);
  group.add(base);

  const roof = new THREE.Mesh(hutRoofGeo, stoneRoofMat);
  roof.position.set(0, 1.3 + 0.45, 0);
  roof.rotation.y = Math.PI / 4;
  group.add(roof);

  const banner = new THREE.Mesh(bannerGeo, greenBannerMat);
  banner.position.set(-0.6, 0.95, 0.93);
  group.add(banner);

  const bow1 = new THREE.Mesh(bowGeo, woodMat);
  bow1.position.set(0.6, 0.85, 0.93);
  bow1.rotation.z = 0.5;
  group.add(bow1);
  const bow2 = new THREE.Mesh(bowGeo, woodMat);
  bow2.position.set(0.85, 0.6, 0.93);
  bow2.rotation.z = -0.5;
  group.add(bow2);

  const trim = new THREE.Mesh(trimGeo, trimMat);
  trim.position.set(0, 1.42, 0);
  trim.visible = false;
  group.add(trim);

  const elite = new THREE.Mesh(eliteCrystalGeo, eliteArcherMat);
  elite.position.set(0, 1.75 + 0.45, 0);
  elite.visible = false;
  group.add(elite);

  R.scene.add(group);
  return { defId: ARCHER_BARRACKS_DEF_ID, group, trimMesh: trim, eliteMesh: elite };
}

/** A tall stone tower + conical roof + glowing finial orb — deliberately the tallest, most
 *  vertical silhouette of the five, since the Mage Tower fields the fewest, priciest allies. */
export function buildMageTowerRec(): Rec {
  const group = newHutGroup();

  const base = new THREE.Mesh(towerBaseGeo, stoneMat);
  base.position.set(0, 1.0, 0);
  group.add(base);

  const roof = new THREE.Mesh(towerRoofGeo, roofMat);
  roof.position.set(0, 2.0 + 0.55, 0);
  group.add(roof);

  const orb = new THREE.Mesh(orbGeo, arcaneOrbMat);
  orb.position.set(0, 2.0 + 1.1 + 0.28, 0);
  group.add(orb);

  const banner = new THREE.Mesh(bannerGeo, bannerMat);
  banner.position.set(0, 1.1, 0.87);
  group.add(banner);

  const trim = new THREE.Mesh(trimGeo, trimMat);
  trim.position.set(0, 2.0 + 1.1 + 0.28, 0);
  trim.scale.setScalar(1.4);
  trim.visible = false;
  group.add(trim);

  // A separate small crystal below the permanent finial orb — the orb itself always pulses
  // (it's the tower's base identity, unrelated to upgrades), so the high-tier tell needs its own
  // mesh rather than repurposing the orb's visibility.
  const elite = new THREE.Mesh(eliteCrystalGeo, eliteMageMat);
  elite.position.set(0, 2.0 + 0.75, 0);
  elite.visible = false;
  group.add(elite);

  R.scene.add(group);
  return { defId: MAGE_TOWER_DEF_ID, group, trimMesh: trim, orbMesh: orb, eliteMesh: elite };
}

/** Wider, lower, flat-roofed and corner-spiked — reads as fortified/bulky, matching the tanks
 *  it trains. Steel accents instead of the armory's plain wood trim. */
export function buildTankBarracksRec(): Rec {
  const group = newHutGroup();

  const base = new THREE.Mesh(fortBaseGeo, stoneMat);
  base.position.set(0, 0.55, 0);
  group.add(base);

  const roof = new THREE.Mesh(fortRoofGeo, steelMat);
  roof.position.set(0, 1.1 + 0.15, 0);
  group.add(roof);

  for (const [sx, sz] of [
    [-1.2, -0.9],
    [1.2, -0.9],
    [-1.2, 0.9],
    [1.2, 0.9],
  ] as const) {
    const spike = new THREE.Mesh(spikeGeo, steelMat);
    spike.position.set(sx, 1.1 + 0.3, sz);
    group.add(spike);
  }

  const banner = new THREE.Mesh(bannerGeo, crimsonBannerMat);
  banner.position.set(0, 0.95, 1.03);
  group.add(banner);

  const trim = new THREE.Mesh(trimGeo, trimMat);
  trim.position.set(0, 1.55, 0);
  trim.visible = false;
  group.add(trim);

  const elite = new THREE.Mesh(eliteCrystalGeo, eliteTankMat);
  elite.position.set(0, 1.85, 0);
  elite.visible = false;
  group.add(elite);

  R.scene.add(group);
  return { defId: TANK_BARRACKS_DEF_ID, group, trimMesh: trim, eliteMesh: elite };
}

/** The hut base with a peaked tent-style roof and a red cross banner — the one spawner building
 *  that isn't about weapons at all, so it should read as a sanctuary, not an armory. */
export function buildFieldHospitalRec(): Rec {
  const group = newHutGroup();

  const base = new THREE.Mesh(hutBaseGeo, hutMat);
  base.position.set(0, 0.65, 0);
  group.add(base);

  const roof = new THREE.Mesh(tentRoofGeo, whiteBannerMat);
  roof.position.set(0, 1.3 + 0.35, 0);
  roof.rotation.y = Math.PI / 4;
  group.add(roof);

  const bar1 = new THREE.Mesh(crossBarGeo, crossMat);
  bar1.position.set(0, 0.95, 0.91);
  group.add(bar1);
  const bar2 = new THREE.Mesh(crossBarGeo2, crossMat);
  bar2.position.set(0, 0.95, 0.91);
  group.add(bar2);

  const banner = new THREE.Mesh(bannerGeo, whiteBannerMat);
  banner.position.set(-0.75, 0.95, 0.93);
  group.add(banner);

  const trim = new THREE.Mesh(trimGeo, trimMat);
  trim.position.set(0, 1.42, 0);
  trim.visible = false;
  group.add(trim);

  const elite = new THREE.Mesh(eliteCrystalGeo, eliteHospitalMat);
  elite.position.set(0, 1.75 + 0.35, 0);
  elite.visible = false;
  group.add(elite);

  R.scene.add(group);
  return { defId: FIELD_HOSPITAL_DEF_ID, group, trimMesh: trim, eliteMesh: elite };
}
