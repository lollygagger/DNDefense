import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { SimEnemy } from '../sim/enemies';
import { ENEMY_DEFS } from '../data/enemies';
import { R } from './scene';
import { spawnBurst } from './fx';

/** Owned by [enemies-waves]. Charming low-poly enemies: pooled THREE.Groups (a handful of
 *  boxes/cones each — alive counts stay well under ~80), walk-bob, facing, billboarded
 *  health bars, death bursts. Reads sim state only, never mutates it. */

const PALETTE: Record<string, { body: number; skin: number; accent: number; burst: number }> = {
  goblin: { body: 0x4f9440, skin: 0x6cb84f, accent: 0x2f5e28, burst: 0x6cd14e },
  orc: { body: 0x94432c, skin: 0xa9633f, accent: 0x54281a, burst: 0xc45a35 },
  skeletonArcher: { body: 0xe8e2cd, skin: 0xf2eddc, accent: 0x8a7f68, burst: 0xf5efdb },
  orcWarlord: { body: 0x8a3524, skin: 0xa14a30, accent: 0x3c3c46, burst: 0xff5a30 },
};
const FALLBACK = { body: 0x888888, skin: 0xaaaaaa, accent: 0x555555, burst: 0xcccccc };

const BAR_H = 0.14;

interface Rec {
  defId: string;
  group: THREE.Group;
  barBg: THREE.Sprite;
  barFill: THREE.Sprite;
  fillMat: THREE.SpriteMaterial;
  barW: number;
  barY: number; // world offset above feet
  big: boolean;
  yaw: number;
  bobPhase: number;
  lastX: number;
  lastZ: number;
}

export function initEnemyView(game: GameState): void {
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

  // Models face +Z (the direction of travel at yaw 0 — toward the castle).
  function buildBody(defId: string, g: THREE.Group): void {
    const c = PALETTE[defId] ?? FALLBACK;
    switch (defId) {
      case 'goblin': {
        g.add(part(new THREE.BoxGeometry(0.55, 0.65, 0.42), c.body, 0, 0.42, 0));
        g.add(part(new THREE.BoxGeometry(0.42, 0.36, 0.4), c.skin, 0, 0.95, 0.05));
        g.add(part(new THREE.ConeGeometry(0.09, 0.34, 4), c.skin, -0.3, 1.05, 0, 0, 0, Math.PI / 2.6));
        g.add(part(new THREE.ConeGeometry(0.09, 0.34, 4), c.skin, 0.3, 1.05, 0, 0, 0, -Math.PI / 2.6));
        g.add(part(new THREE.BoxGeometry(0.09, 0.5, 0.09), c.accent, 0.36, 0.55, 0.18, 0.5, 0, 0));
        break;
      }
      case 'orc': {
        g.add(part(new THREE.BoxGeometry(1.05, 1.05, 0.65), c.body, 0, 0.85, 0));
        g.add(part(new THREE.BoxGeometry(0.52, 0.46, 0.5), c.skin, 0, 1.68, 0.05));
        g.add(part(new THREE.BoxGeometry(0.28, 0.85, 0.28), c.skin, -0.68, 0.9, 0));
        g.add(part(new THREE.BoxGeometry(0.28, 0.85, 0.28), c.skin, 0.68, 0.9, 0));
        g.add(part(new THREE.ConeGeometry(0.06, 0.2, 4), c.accent, -0.14, 1.5, 0.28));
        g.add(part(new THREE.ConeGeometry(0.06, 0.2, 4), c.accent, 0.14, 1.5, 0.28));
        break;
      }
      case 'skeletonArcher': {
        g.add(part(new THREE.BoxGeometry(0.34, 0.85, 0.2), c.body, 0, 0.85, 0));
        g.add(part(new THREE.BoxGeometry(0.3, 0.3, 0.28), c.skin, 0, 1.48, 0));
        g.add(part(new THREE.BoxGeometry(0.11, 0.45, 0.11), c.body, -0.11, 0.22, 0));
        g.add(part(new THREE.BoxGeometry(0.11, 0.45, 0.11), c.body, 0.11, 0.22, 0));
        // bow: half-torus arc held out front-left, opening toward the enemy
        g.add(
          part(new THREE.TorusGeometry(0.42, 0.035, 6, 12, Math.PI), c.accent, -0.32, 1.05, 0.25, 0, Math.PI / 2, Math.PI / 2),
        );
        break;
      }
      case 'orcWarlord': {
        g.add(part(new THREE.BoxGeometry(1.8, 1.7, 1.05), c.body, 0, 1.45, 0));
        g.add(part(new THREE.BoxGeometry(0.72, 0.62, 0.7), c.skin, 0, 2.65, 0.05));
        g.add(part(new THREE.BoxGeometry(0.78, 0.24, 0.76), c.accent, 0, 2.98, 0.05)); // helmet rim
        g.add(part(new THREE.ConeGeometry(0.13, 0.65, 5), c.accent, -0.26, 3.35, 0.05));
        g.add(part(new THREE.ConeGeometry(0.13, 0.65, 5), c.accent, 0.26, 3.35, 0.05));
        g.add(part(new THREE.BoxGeometry(0.55, 0.42, 0.65), c.accent, -1.15, 2.15, 0));
        g.add(part(new THREE.BoxGeometry(0.55, 0.42, 0.65), c.accent, 1.15, 2.15, 0));
        break;
      }
      default: {
        g.add(part(new THREE.BoxGeometry(0.6, 1.2, 0.5), c.body, 0, 0.6, 0));
        g.add(part(new THREE.BoxGeometry(0.4, 0.4, 0.4), c.skin, 0, 1.4, 0));
      }
    }
  }

  function makeRec(defId: string): Rec {
    const def = ENEMY_DEFS[defId];
    const group = new THREE.Group();
    buildBody(defId, group);
    R.scene.add(group);

    const barW = Math.min(Math.max((def?.radius ?? 0.5) * 2.4, 1.1), 3.2);
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
      defId,
      group,
      barBg,
      barFill,
      fillMat,
      barW,
      barY: (def?.height ?? 1.6) + 0.55,
      big: defId === 'orcWarlord',
      yaw: 0,
      bobPhase: 0,
      lastX: 0,
      lastZ: 0,
    };
  }

  const pools = new Map<string, Rec[]>();
  const active = new Map<number, Rec>();

  function acquire(e: SimEnemy): Rec {
    const pool = pools.get(e.defId);
    const rec = pool && pool.length > 0 ? pool.pop()! : makeRec(e.defId);
    rec.group.visible = true;
    rec.yaw = e.yaw;
    rec.bobPhase = (e.id % 7) * 0.9; // desync bobbing
    rec.lastX = e.pos.x;
    rec.lastZ = e.pos.z;
    return rec;
  }

  function release(rec: Rec): void {
    rec.group.visible = false;
    rec.barBg.visible = false;
    rec.barFill.visible = false;
    let pool = pools.get(rec.defId);
    if (!pool) {
      pool = [];
      pools.set(rec.defId, pool);
    }
    pool.push(rec);
  }

  const camRight = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const seen = new Set<number>();
  let animTime = 0;

  game.addSystem({
    render(dt, g) {
      animTime += dt;
      camRight.setFromMatrixColumn(R.camera.matrixWorld, 0);
      camFwd.setFromMatrixColumn(R.camera.matrixWorld, 2).negate();

      seen.clear();
      for (const enemy of g.enemies as SimEnemy[]) {
        if (!enemy.alive) continue;
        seen.add(enemy.id);
        let rec = active.get(enemy.id);
        if (!rec) {
          rec = acquire(enemy);
          active.set(enemy.id, rec);
        }

        // movement estimate drives the walk-bob
        const mdx = enemy.pos.x - rec.lastX;
        const mdz = enemy.pos.z - rec.lastZ;
        rec.lastX = enemy.pos.x;
        rec.lastZ = enemy.pos.z;
        const speed = dt > 0 ? Math.sqrt(mdx * mdx + mdz * mdz) / dt : 0;
        const moving = Math.min(speed / 3, 1);
        rec.bobPhase += dt * (5 + speed * 2);

        let y = enemy.pos.y + Math.abs(Math.sin(rec.bobPhase)) * 0.09 * moving;
        if (g.phase === 'gameover') {
          // victory hops — the keep is down, let them celebrate
          y = enemy.pos.y + Math.abs(Math.sin(animTime * 5 + enemy.id * 1.3)) * 0.45;
        }
        rec.group.position.set(enemy.pos.x, y, enemy.pos.z);

        // smooth facing toward the sim's yaw
        let dyaw = enemy.yaw - rec.yaw;
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        rec.yaw += dyaw * Math.min(1, dt * 10);
        rec.group.rotation.y = rec.yaw;
        rec.group.rotation.z = Math.sin(rec.bobPhase * 0.5) * 0.06 * moving;

        // health bar (hidden at full HP)
        const frac = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0;
        const show = frac < 0.999;
        rec.barBg.visible = show;
        rec.barFill.visible = show;
        if (show) {
          const bx = enemy.pos.x;
          const by = enemy.pos.y + rec.barY;
          const bz = enemy.pos.z;
          rec.barBg.position.set(bx + camFwd.x * 0.02, by, bz + camFwd.z * 0.02);
          const w = Math.max(frac * rec.barW, 0.02);
          rec.barFill.scale.set(w, BAR_H, 1);
          const shift = -(rec.barW - w) / 2; // left-anchored fill in billboard space
          rec.barFill.position.set(
            bx + camRight.x * shift + camFwd.x * 0.05,
            by + camRight.y * shift,
            bz + camRight.z * shift + camFwd.z * 0.05,
          );
          rec.fillMat.color.setHSL(frac * 0.33, 0.75, 0.45);
        }
      }

      // anything gone from the sim died — burst + release
      for (const [id, rec] of active) {
        if (seen.has(id)) continue;
        const c = PALETTE[rec.defId] ?? FALLBACK;
        spawnBurst(rec.group.position, c.burst, rec.big ? 36 : 14, rec.big ? 9 : 5, rec.big ? 0.8 : 0.5);
        release(rec);
        active.delete(id);
      }
    },
  });
}
