import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { AllyUnit } from '../sim/allies';
import { getAllyDef } from '../data/allies';
import { R } from './scene';
import { spawnBurst } from './fx';

/** Owned by [structures-allies]. Pooled low-poly ally rendering for the whole roster —
 *  mirrors enemyView.ts's pattern (one pool per kind, acquire/release, walk-bob, billboarded
 *  health bar hidden at full HP, death burst). All six kinds share the "ally blue" family from
 *  the art palette (docs/ARCHITECTURE.md) but vary body tone/silhouette/accent so each reads
 *  differently at a glance — a medic's cross vs a tank's tower shield vs a mage's hood, not just
 *  a recolor. Reads sim state only, never mutates it. */

interface Palette {
  body: number;
  trim: number;
  skin: number;
  accent: number;
  burst: number;
}

const PALETTE: Record<string, Palette> = {
  swordsman: { body: 0x2f5fa8, trim: 0x1c3f73, skin: 0xe8c39e, accent: 0xb9bec4, burst: 0x6fa8ff },
  archer: { body: 0x3a6bb0, trim: 0x274a80, skin: 0xe8c39e, accent: 0x6b8f4e, burst: 0x7fc4ff },
  allyMage: { body: 0x33478f, trim: 0x22305f, skin: 0xd9c8a8, accent: 0x7fd8ff, burst: 0x8fd9ff },
  tank: { body: 0x3a5a8a, trim: 0x24365a, skin: 0xd9b98e, accent: 0x9aa6b4, burst: 0x7fb0ff },
  medic: { body: 0x3d6fae, trim: 0x2a4d80, skin: 0xe8c39e, accent: 0xf2f2f2, burst: 0x9fd4ff },
  engineer: { body: 0x3d6fae, trim: 0x2a4d80, skin: 0xe8c39e, accent: 0x8a6a3c, burst: 0x9fd4ff },
};
const FALLBACK: Palette = { body: 0x2f5fa8, trim: 0x1c3f73, skin: 0xe8c39e, accent: 0xb9bec4, burst: 0x6fa8ff };

const BAR_H = 0.14;

interface Rec {
  defId: string;
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

  // Every model faces +Z at yaw 0, matching enemyView's convention.
  function buildBody(defId: string, g: THREE.Group): void {
    const c = PALETTE[defId] ?? FALLBACK;
    switch (defId) {
      // Original swordsman look, unchanged — "keep the existing swordsman's feel intact".
      case 'swordsman': {
        g.add(part(new THREE.BoxGeometry(0.18, 0.55, 0.2), c.trim, -0.13, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.18, 0.55, 0.2), c.trim, 0.13, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.55, 0.6, 0.34), c.body, 0, 0.85, 0));
        g.add(part(new THREE.BoxGeometry(0.57, 0.1, 0.36), c.trim, 0, 0.56, 0));
        g.add(part(new THREE.BoxGeometry(0.32, 0.3, 0.3), c.skin, 0, 1.32, 0));
        g.add(part(new THREE.BoxGeometry(0.16, 0.45, 0.16), c.body, -0.37, 0.95, 0));
        g.add(part(new THREE.BoxGeometry(0.16, 0.45, 0.16), c.body, 0.37, 0.95, 0));
        g.add(part(new THREE.BoxGeometry(0.08, 0.5, 0.4), c.accent, -0.46, 0.85, 0.05));
        g.add(part(new THREE.BoxGeometry(0.08, 0.6, 0.08), c.accent, 0.4, 0.95, 0.28, 0.9, 0, 0));
        g.add(part(new THREE.BoxGeometry(0.12, 0.14, 0.12), c.trim, 0.4, 0.68, 0.1));
        break;
      }
      // Leaner build, no shield, a bow held out front and a quiver on the back — silhouette
      // reads "ranged" instantly next to the swordsman's shield+blade block.
      case 'archer': {
        g.add(part(new THREE.BoxGeometry(0.16, 0.55, 0.18), c.trim, -0.11, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.16, 0.55, 0.18), c.trim, 0.11, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.44, 0.58, 0.28), c.body, 0, 0.85, 0));
        g.add(part(new THREE.BoxGeometry(0.3, 0.3, 0.28), c.skin, 0, 1.3, 0));
        g.add(part(new THREE.ConeGeometry(0.1, 0.2, 4), c.trim, 0, 1.5, -0.02)); // pointed hood/cap
        g.add(part(new THREE.BoxGeometry(0.14, 0.42, 0.14), c.body, -0.32, 0.95, 0));
        g.add(part(new THREE.BoxGeometry(0.14, 0.42, 0.14), c.body, 0.32, 0.95, 0));
        // quiver, angled across the back
        g.add(part(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 6), c.accent, -0.2, 1.0, -0.2, 0, 0, 0.4));
        // bow, held out front
        g.add(part(new THREE.TorusGeometry(0.32, 0.03, 6, 12, Math.PI), c.trim, 0.32, 0.95, 0.22, 0, Math.PI / 2, Math.PI / 2));
        break;
      }
      // Robed, hooded, no visible limbs below the elbow — a staff with a glowing accent orb
      // (icy blue, echoing its slow debuff, distinct from the player mage's purple).
      case 'allyMage': {
        g.add(part(new THREE.ConeGeometry(0.34, 1.1, 8), c.body, 0, 0.65, 0)); // long robe skirt
        g.add(part(new THREE.SphereGeometry(0.22, 8, 6), c.trim, 0, 1.28, 0)); // hood
        g.add(part(new THREE.SphereGeometry(0.13, 6, 5), c.skin, 0, 1.22, 0.15)); // face, just visible
        g.add(part(new THREE.BoxGeometry(0.12, 0.34, 0.12), c.body, -0.28, 0.95, 0.05, 0, 0, 0.3));
        g.add(part(new THREE.CylinderGeometry(0.03, 0.03, 1.15, 5), c.trim, 0.34, 0.95, 0.1, 0, 0, -0.15));
        g.add(part(new THREE.OctahedronGeometry(0.11, 0), c.accent, 0.34, 1.5, 0.05, 0, 0, -0.15)); // staff orb
        break;
      }
      // Broad, stocky, a tower shield that covers most of the front — reads "hold the line"
      // at a glance next to the swordsman's leaner frame.
      case 'tank': {
        g.add(part(new THREE.BoxGeometry(0.26, 0.5, 0.28), c.trim, -0.18, 0.25, 0));
        g.add(part(new THREE.BoxGeometry(0.26, 0.5, 0.28), c.trim, 0.18, 0.25, 0));
        g.add(part(new THREE.BoxGeometry(0.8, 0.72, 0.46), c.body, 0, 0.86, 0));
        g.add(part(new THREE.BoxGeometry(0.42, 0.34, 0.36), c.skin, 0, 1.42, 0));
        g.add(part(new THREE.BoxGeometry(0.46, 0.16, 0.4), c.accent, 0, 1.62, 0)); // helm rim
        g.add(part(new THREE.BoxGeometry(0.2, 0.5, 0.2), c.body, -0.52, 0.9, 0));
        g.add(part(new THREE.BoxGeometry(0.2, 0.5, 0.2), c.body, 0.52, 0.9, 0));
        g.add(part(new THREE.BoxGeometry(0.1, 0.9, 0.6), c.accent, -0.6, 0.85, 0.12)); // tower shield
        g.add(part(new THREE.BoxGeometry(0.09, 0.7, 0.09), c.accent, 0.55, 0.95, 0.32, 0.85, 0, 0)); // heavy mace
        break;
      }
      // Medic: a slim white/red cross patch on the chest reads instantly, plus a satchel.
      case 'medic': {
        g.add(part(new THREE.BoxGeometry(0.17, 0.55, 0.2), c.trim, -0.12, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.17, 0.55, 0.2), c.trim, 0.12, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.5, 0.6, 0.3), c.body, 0, 0.85, 0));
        g.add(part(new THREE.BoxGeometry(0.3, 0.3, 0.28), c.skin, 0, 1.32, 0));
        g.add(part(new THREE.BoxGeometry(0.15, 0.44, 0.15), c.body, -0.34, 0.95, 0));
        g.add(part(new THREE.BoxGeometry(0.15, 0.44, 0.15), c.body, 0.34, 0.95, 0));
        // red cross on white patch, chest-high
        g.add(part(new THREE.BoxGeometry(0.24, 0.24, 0.02), c.accent, 0, 0.92, 0.16));
        g.add(part(new THREE.BoxGeometry(0.2, 0.06, 0.03), 0xd94f4f, 0, 0.92, 0.18));
        g.add(part(new THREE.BoxGeometry(0.06, 0.2, 0.03), 0xd94f4f, 0, 0.92, 0.18));
        // satchel on the hip
        g.add(part(new THREE.BoxGeometry(0.22, 0.2, 0.14), c.trim, 0.3, 0.62, 0.05));
        break;
      }
      // Engineer: a tool belt + a wrench prop and a hard-cap silhouette distinguish it from the
      // medic despite sharing the same body tone.
      case 'engineer': {
        g.add(part(new THREE.BoxGeometry(0.17, 0.55, 0.2), c.trim, -0.12, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.17, 0.55, 0.2), c.trim, 0.12, 0.275, 0));
        g.add(part(new THREE.BoxGeometry(0.5, 0.6, 0.3), c.body, 0, 0.85, 0));
        g.add(part(new THREE.BoxGeometry(0.3, 0.3, 0.28), c.skin, 0, 1.32, 0));
        g.add(part(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 10), c.accent, 0, 1.5, 0)); // hard cap
        g.add(part(new THREE.BoxGeometry(0.15, 0.44, 0.15), c.body, -0.34, 0.95, 0));
        g.add(part(new THREE.BoxGeometry(0.15, 0.44, 0.15), c.body, 0.34, 0.95, 0));
        g.add(part(new THREE.BoxGeometry(0.55, 0.1, 0.34), c.accent, 0, 0.6, 0)); // tool belt
        // wrench, held out front
        g.add(part(new THREE.BoxGeometry(0.06, 0.36, 0.06), 0xb9bec4, 0.38, 0.95, 0.24, 0.6, 0, 0));
        break;
      }
      default: {
        g.add(part(new THREE.BoxGeometry(0.5, 1.2, 0.4), c.body, 0, 0.6, 0));
        g.add(part(new THREE.BoxGeometry(0.3, 0.3, 0.3), c.skin, 0, 1.35, 0));
      }
    }
  }

  function makeRec(defId: string): Rec {
    const group = new THREE.Group();
    buildBody(defId, group);
    R.scene.add(group);

    const radius = getAllyDef(defId)?.radius ?? 0.5;
    const height = getAllyDef(defId)?.height ?? 1.8;
    const barW = Math.min(Math.max(radius * 2.4, 1.1), 3.2);
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
      barY: height + 0.4,
      yaw: 0,
      bobPhase: 0,
      lastX: 0,
      lastZ: 0,
    };
  }

  const pools = new Map<string, Rec[]>();
  const active = new Map<number, Rec>();

  function acquire(ally: AllyUnit): Rec {
    const pool = pools.get(ally.def.id);
    const rec = pool && pool.length > 0 ? pool.pop()! : makeRec(ally.def.id);
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

  game.addSystem({
    render(dt, g) {
      camRight.setFromMatrixColumn(R.camera.matrixWorld, 0);
      camFwd.setFromMatrixColumn(R.camera.matrixWorld, 2).negate();

      seen.clear();
      for (const ally of g.allies as AllyUnit[]) {
        if (!ally.alive) continue;
        seen.add(ally.id);
        let rec = active.get(ally.id);
        if (!rec || rec.defId !== ally.def.id) {
          if (rec) release(rec); // shouldn't normally happen (an ally's def.id never changes), defensive
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
        const c = PALETTE[rec.defId] ?? FALLBACK;
        spawnBurst(rec.group.position, c.burst, 16, 5.5, 0.5);
        release(rec);
        active.delete(id);
      }
    },
  });
}
