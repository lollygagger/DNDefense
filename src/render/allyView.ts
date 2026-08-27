import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { SwordsmanUnit } from '../sim/allies';
import { SWORDSMAN } from '../data/structures';
import { R } from './scene';
import { spawnBurst } from './fx';

/** Owned by [structures-allies]. Pooled low-poly swordsman rendering — mirrors enemyView.ts's
 *  pattern (acquire/release pool, walk-bob, billboarded health bar hidden at full HP, death
 *  burst). Reads sim state only, never mutates it. */

const BODY_COLOR = 0x2f5fa8; // blue tabard
const TRIM_COLOR = 0x1c3f73;
const SKIN_COLOR = 0xe8c39e; // pale head
const METAL_COLOR = 0xb9bec4; // sword/shield
const BURST_COLOR = 0x6fa8ff;

const BAR_H = 0.14;

interface Rec {
  group: THREE.Group;
  barBg: THREE.Sprite;
  barFill: THREE.Sprite;
  fillMat: THREE.SpriteMaterial;
  barW: number;
  barY: number;
  yaw: number;
  bobPhase: number;
  lastX: number;
  lastZ: number;
}

export function initAllyView(game: GameState): void {
  const mats = new Map<number, THREE.MeshLambertMaterial>();
  const matFor = (color: number): THREE.MeshLambertMaterial => {
    let m = mats.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, flatShading: true });
      mats.set(color, m);
    }
    return m;
  };

  const part = (
    geo: THREE.BufferGeometry,
    color: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, matFor(color));
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    return mesh;
  };

  // Faces +Z at yaw 0, matching enemyView's convention.
  function buildBody(): THREE.Group {
    const g = new THREE.Group();
    // legs
    g.add(part(new THREE.BoxGeometry(0.18, 0.55, 0.2), TRIM_COLOR, -0.13, 0.275, 0));
    g.add(part(new THREE.BoxGeometry(0.18, 0.55, 0.2), TRIM_COLOR, 0.13, 0.275, 0));
    // tabard torso
    g.add(part(new THREE.BoxGeometry(0.55, 0.6, 0.34), BODY_COLOR, 0, 0.85, 0));
    // belt trim
    g.add(part(new THREE.BoxGeometry(0.57, 0.1, 0.36), TRIM_COLOR, 0, 0.56, 0));
    // head
    g.add(part(new THREE.BoxGeometry(0.32, 0.3, 0.3), SKIN_COLOR, 0, 1.32, 0));
    // arms
    g.add(part(new THREE.BoxGeometry(0.16, 0.45, 0.16), BODY_COLOR, -0.37, 0.95, 0));
    g.add(part(new THREE.BoxGeometry(0.16, 0.45, 0.16), BODY_COLOR, 0.37, 0.95, 0));
    // shield (left hand)
    g.add(part(new THREE.BoxGeometry(0.08, 0.5, 0.4), METAL_COLOR, -0.46, 0.85, 0.05));
    // sword (right hand), angled forward
    g.add(part(new THREE.BoxGeometry(0.08, 0.6, 0.08), METAL_COLOR, 0.4, 0.95, 0.28, 0.9, 0, 0));
    g.add(part(new THREE.BoxGeometry(0.12, 0.14, 0.12), TRIM_COLOR, 0.4, 0.68, 0.1));
    return g;
  }

  function makeRec(): Rec {
    const group = buildBody();
    R.scene.add(group);

    const barW = Math.min(Math.max(SWORDSMAN.radius * 2.4, 1.1), 3.2);
    const bgMat = new THREE.SpriteMaterial({ color: 0x141414, depthWrite: false });
    const barBg = new THREE.Sprite(bgMat);
    barBg.scale.set(barW + 0.08, BAR_H + 0.08, 1);
    barBg.renderOrder = 10;
    barBg.visible = false;
    R.scene.add(barBg);
    const fillMat = new THREE.SpriteMaterial({ color: 0x44cc44, depthWrite: false });
    const barFill = new THREE.Sprite(fillMat);
    barFill.scale.set(barW, BAR_H, 1);
    barFill.renderOrder = 11;
    barFill.visible = false;
    R.scene.add(barFill);

    return {
      group,
      barBg,
      barFill,
      fillMat,
      barW,
      barY: SWORDSMAN.height + 0.4,
      yaw: 0,
      bobPhase: 0,
      lastX: 0,
      lastZ: 0,
    };
  }

  const pool: Rec[] = [];
  const active = new Map<number, Rec>();

  function acquire(ally: SwordsmanUnit): Rec {
    const rec = pool.pop() ?? makeRec();
    rec.group.visible = true;
    rec.yaw = ally.yaw;
    rec.bobPhase = (ally.id % 7) * 0.9;
    rec.lastX = ally.pos.x;
    rec.lastZ = ally.pos.z;
    return rec;
  }

  function release(rec: Rec): void {
    rec.group.visible = false;
    rec.barBg.visible = false;
    rec.barFill.visible = false;
    pool.push(rec);
  }

  const camRight = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const seen = new Set<number>();

  game.addSystem({
    render(dt, g) {
      camRight.setFromMatrixColumn(R.camera.matrixWorld, 0);
      camFwd.setFromMatrixColumn(R.camera.matrixWorld, 2).negate();

      seen.clear();
      for (const ally of g.allies as SwordsmanUnit[]) {
        if (!ally.alive) continue;
        seen.add(ally.id);
        let rec = active.get(ally.id);
        if (!rec) {
          rec = acquire(ally);
          active.set(ally.id, rec);
        }

        const mdx = ally.pos.x - rec.lastX;
        const mdz = ally.pos.z - rec.lastZ;
        rec.lastX = ally.pos.x;
        rec.lastZ = ally.pos.z;
        const speed = dt > 0 ? Math.sqrt(mdx * mdx + mdz * mdz) / dt : 0;
        const moving = Math.min(speed / 3, 1);
        rec.bobPhase += dt * (5 + speed * 2);

        const y = ally.pos.y + Math.abs(Math.sin(rec.bobPhase)) * 0.08 * moving;
        rec.group.position.set(ally.pos.x, y, ally.pos.z);

        let dyaw = ally.yaw - rec.yaw;
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        rec.yaw += dyaw * Math.min(1, dt * 10);
        rec.group.rotation.y = rec.yaw;
        rec.group.rotation.z = Math.sin(rec.bobPhase * 0.5) * 0.05 * moving;

        const frac = ally.maxHp > 0 ? ally.hp / ally.maxHp : 0;
        const show = frac < 0.999;
        rec.barBg.visible = show;
        rec.barFill.visible = show;
        if (show) {
          const bx = ally.pos.x;
          const by = ally.pos.y + rec.barY;
          const bz = ally.pos.z;
          rec.barBg.position.set(bx + camFwd.x * 0.02, by, bz + camFwd.z * 0.02);
          const w = Math.max(frac * rec.barW, 0.02);
          rec.barFill.scale.set(w, BAR_H, 1);
          const shift = -(rec.barW - w) / 2;
          rec.barFill.position.set(
            bx + camRight.x * shift + camFwd.x * 0.05,
            by + camRight.y * shift,
            bz + camRight.z * shift + camFwd.z * 0.05,
          );
          rec.fillMat.color.setHSL(frac * 0.33, 0.75, 0.45);
        }
      }

      for (const [id, rec] of active) {
        if (seen.has(id)) continue;
        spawnBurst(rec.group.position, BURST_COLOR, 16, 5.5, 0.5);
        release(rec);
        active.delete(id);
      }
    },
  });
}
