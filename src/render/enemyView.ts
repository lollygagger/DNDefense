import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { SimEnemy } from '../sim/enemies';
import { ENEMY_DEFS, isFlyerDef } from '../data/enemies';
import { R } from './scene';
import { spawnBurst, spawnRing } from './fx';
import { isStunned, slowSeverity } from '../sim/status';
import { isBleeding, isBurning, isVulnerable } from '../sim/abilityEffects';
import { ROOT_SEVERITY_THRESHOLD, STATUS_COLOR, statusIconTexture, type StatusIconKind } from './statusIcons';

/** Owned by [enemies-waves]. Charming low-poly enemies: pooled THREE.Groups (a handful of
 *  boxes/cones each — alive counts stay well under ~80), walk-bob, facing, billboarded
 *  health bars, death bursts. Flyers (hot air balloon, dragon) additionally get a pooled ground
 *  shadow decal — the altitude cue a player needs to judge height, since nothing else in this
 *  low-poly style implies depth/height on its own. Also draws up to 2 billboarded status icons
 *  per enemy (stun/root/slow/mark/bleed/burn — see the STATUS ICONS section below) and a one-
 *  shot flash the instant a stun actually lands. Reads sim state only, never mutates it. */

// ---------- STATUS ICONS (ability-clarity task, 2026-08-27) ----------
// The blocker this task had to solve first: bleed/vulnerability/shield/thorns lived in
// module-private WeakMaps inside sim/abilityEffects.ts, invisible to render. That file (and
// sim/status.ts, for stun/slow) now exports small read-only query functions — isStunned,
// slowSeverity, isBleeding, isVulnerable, isBurning — every one a primitive-returning read of
// data that was already being tracked for gameplay, none of them able to change what an effect
// does or how long it lasts. This section just calls them.
//
// Icon budget: at most 2 icons per enemy, chosen in a fixed priority order (the status most
// likely to change what the player does next wins a slot first):
//   1. stun  — hard CC, the single most decision-relevant thing that can happen to an enemy.
//   2. root/slow — the same Unit.slowFactor mechanic at two readable tiers (see statusIcons.ts's
//      ROOT_SEVERITY_THRESHOLD): a heavy snare changes positioning decisions more than a mild one.
//   3. mark — vulnerable/marked (bonus damage taken): tells the player which target to focus.
//   4. bleed — a running damage tally; informative, rarely urgent.
//   5. burn  — standing in a damage zone; the ground effect itself (render/fx.ts) already
//      telegraphs this on the terrain, so the per-enemy icon is the lowest priority of the six.
// Two per enemy, not more, keeps a screen full of enemies readable instead of turning into icon
// soup — the icons are billboarded sprites tied 1:1 to each enemy's own pooled Rec (exactly like
// its health-bar sprites), so the worst case across the whole game is bounded by the same ~80
// concurrent enemy cap the health bars already live within: 160 icon sprites, the same order of
// magnitude as the 160 health-bar sprites already shipping today.

const PALETTE: Record<string, { body: number; skin: number; accent: number; burst: number }> = {
  goblin: { body: 0x4f9440, skin: 0x6cb84f, accent: 0x2f5e28, burst: 0x6cd14e },
  orc: { body: 0x94432c, skin: 0xa9633f, accent: 0x54281a, burst: 0xc45a35 },
  skeletonArcher: { body: 0xe8e2cd, skin: 0xf2eddc, accent: 0x8a7f68, burst: 0xf5efdb },
  orcWarlord: { body: 0x8a3524, skin: 0xa14a30, accent: 0x3c3c46, burst: 0xff5a30 },
  // Festive patchwork canopy (gold/maroon) — reads as a balloon, avoids every existing hue
  // (goblin green, orc red-brown, skeleton bone-white, ally blue, mage purple).
  hotAirBalloon: { body: 0xd9a233, skin: 0x8a2f3d, accent: 0x6b4a2c, burst: 0xffcf6b },
  // Dark charcoal body with molten-orange belly/eye accents — deliberately not green (goblin)
  // or red-brown (orc/warlord) or purple (mage) so it reads as its own distinct threat.
  dragon: { body: 0x2b2b33, skin: 0xd83f2c, accent: 0xffb020, burst: 0xff6a2a },
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
  // Flyers only (null otherwise): a flat ground decal tracking straight beneath the flyer,
  // shrinking/fading with altitude — the height cue a player uses to judge how high it is.
  shadow: THREE.Mesh | null;
  shadowMat: THREE.MeshBasicMaterial | null;
  shadowBaseR: number;
  // Status icons: up to 2 small billboarded glyphs shown above the enemy, independent of the
  // health bar's own full-HP hiding (a full-HP enemy can still be stunned/slowed). wasStunned
  // is render-side bookkeeping only (not sim state) so the one-shot "stun just landed" flash
  // fires exactly once per stun, not every frame the icon happens to be visible.
  icon1: THREE.Sprite;
  icon1Mat: THREE.SpriteMaterial;
  icon2: THREE.Sprite;
  icon2Mat: THREE.SpriteMaterial;
  wasStunned: boolean;
}

const ICON_SIZE = 0.34;
const ICON_SPACING = 0.4;

// Shared, allocation-free once built: every flyer's shadow decal reuses this one flat-disc
// geometry (only its per-instance material's opacity and its mesh's scale/position differ).
const shadowGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);

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
      case 'hotAirBalloon': {
        // Basket (feet/origin = basket floor)
        g.add(part(new THREE.BoxGeometry(0.9, 0.7, 0.9), c.accent, 0, 0.35, 0));
        // Corner ropes rising to the envelope's neck
        for (const [rx, rz] of [
          [-0.38, -0.38],
          [0.38, -0.38],
          [-0.38, 0.38],
          [0.38, 0.38],
        ] as [number, number][]) {
          g.add(part(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 4), c.accent, rx * 0.7, 1.1, rz * 0.7));
        }
        // Burner flame between basket and envelope
        g.add(part(new THREE.ConeGeometry(0.16, 0.34, 5), c.skin, 0, 1.55, 0));
        // Envelope (canopy)
        g.add(part(new THREE.SphereGeometry(1.3, 8, 6), c.body, 0, 2.75, 0));
        // Gore-stripe bands wrapping the envelope
        g.add(part(new THREE.TorusGeometry(1.15, 0.09, 6, 14), c.skin, 0, 2.35, 0, Math.PI / 2, 0, 0));
        g.add(part(new THREE.TorusGeometry(1.0, 0.09, 6, 14), c.skin, 0, 3.55, 0, Math.PI / 2, 0, 0));
        break;
      }
      case 'dragon': {
        // Body + glowing underbelly plates
        g.add(part(new THREE.BoxGeometry(0.9, 0.85, 1.9), c.body, 0, 1.3, 0));
        g.add(part(new THREE.BoxGeometry(0.68, 0.32, 1.7), c.skin, 0, 1.02, 0));
        // Tail, tapering away from the direction of travel (-Z)
        g.add(part(new THREE.ConeGeometry(0.32, 1.5, 5), c.body, 0, 1.25, -1.6, -Math.PI / 2, 0, 0));
        // Wings swept back off both flanks
        g.add(part(new THREE.BoxGeometry(1.7, 0.07, 0.85), c.skin, -0.9, 1.5, -0.05, 0, -0.35, 0.15));
        g.add(part(new THREE.BoxGeometry(1.7, 0.07, 0.85), c.skin, 0.9, 1.5, -0.05, 0, 0.35, -0.15));
        // Head, horns, glowing eyes
        g.add(part(new THREE.BoxGeometry(0.46, 0.4, 0.55), c.body, 0, 1.68, 1.05));
        g.add(part(new THREE.ConeGeometry(0.07, 0.32, 4), c.accent, -0.15, 2.0, 0.95));
        g.add(part(new THREE.ConeGeometry(0.07, 0.32, 4), c.accent, 0.15, 2.0, 0.95));
        g.add(part(new THREE.SphereGeometry(0.055, 6, 5), c.accent, -0.16, 1.72, 1.32));
        g.add(part(new THREE.SphereGeometry(0.055, 6, 5), c.accent, 0.16, 1.72, 1.32));
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

    let shadow: THREE.Mesh | null = null;
    let shadowMat: THREE.MeshBasicMaterial | null = null;
    let shadowBaseR = 0;
    if (isFlyerDef(defId)) {
      shadowBaseR = Math.max((def?.radius ?? 1) * 1.5, 1.4);
      shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
      shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.renderOrder = 1;
      shadow.visible = false;
      R.scene.add(shadow);
    }

    // Status icon sprites: a map is assigned up front (never left null) so later frames can
    // swap which glyph an instance shows by reassigning `.map` without triggering a shader
    // recompile — SpriteMaterial only needs `needsUpdate` when a map goes from absent to present.
    const icon1Mat = new THREE.SpriteMaterial({ map: statusIconTexture('stun'), depthWrite: false, transparent: true });
    const icon1 = new THREE.Sprite(icon1Mat);
    icon1.scale.set(ICON_SIZE, ICON_SIZE, 1);
    icon1.renderOrder = 12;
    icon1.visible = false;
    R.scene.add(icon1);
    const icon2Mat = new THREE.SpriteMaterial({ map: statusIconTexture('stun'), depthWrite: false, transparent: true });
    const icon2 = new THREE.Sprite(icon2Mat);
    icon2.scale.set(ICON_SIZE, ICON_SIZE, 1);
    icon2.renderOrder = 12;
    icon2.visible = false;
    R.scene.add(icon2);

    return {
      defId,
      group,
      barBg,
      barFill,
      fillMat,
      barW,
      barY: (def?.height ?? 1.6) + 0.55,
      big: defId === 'orcWarlord' || defId === 'hotAirBalloon' || defId === 'dragon',
      yaw: 0,
      bobPhase: 0,
      lastX: 0,
      lastZ: 0,
      shadow,
      shadowMat,
      shadowBaseR,
      icon1,
      icon1Mat,
      icon2,
      icon2Mat,
      wasStunned: false,
    };
  }

  const pools = new Map<string, Rec[]>();
  const active = new Map<number, Rec>();

  function acquire(e: SimEnemy): Rec {
    const pool = pools.get(e.defId);
    const rec = pool && pool.length > 0 ? pool.pop()! : makeRec(e.defId);
    rec.group.visible = true;
    if (rec.shadow) rec.shadow.visible = true;
    rec.yaw = e.yaw;
    rec.bobPhase = (e.id % 7) * 0.9; // desync bobbing
    rec.lastX = e.pos.x;
    rec.lastZ = e.pos.z;
    // A freshly (re)acquired enemy never spawns pre-stunned in this game, so starting false
    // here never causes a false "stun just landed" flash on the very first frame it's seen.
    rec.wasStunned = false;
    return rec;
  }

  function release(rec: Rec): void {
    rec.group.visible = false;
    rec.barBg.visible = false;
    rec.barFill.visible = false;
    rec.icon1.visible = false;
    rec.icon2.visible = false;
    if (rec.shadow) rec.shadow.visible = false;
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
        } else if (rec.shadow) {
          // Flyers get a gentle idle float instead of a walk-bob (they have no footsteps, and
          // the balloon in particular barely has any horizontal speed once parked to bob from).
          y += Math.sin(animTime * 1.3 + enemy.id) * 0.15;
        }
        rec.group.position.set(enemy.pos.x, y, enemy.pos.z);

        // Ground shadow: the altitude cue. Shrinks and fades the higher the flyer is above the
        // ground directly beneath it, so a player can judge height at a glance.
        if (rec.shadow && rec.shadowMat) {
          const groundY = g.castle.worldHeight(enemy.pos.x, enemy.pos.z);
          const above = Math.max(0, enemy.pos.y - groundY);
          const t = Math.min(above / 12, 1); // 0 = touching ground, 1 = at/above cruise altitude
          const scale = rec.shadowBaseR * (1.2 - 0.6 * t);
          rec.shadow.position.set(enemy.pos.x, groundY + 0.03, enemy.pos.z);
          rec.shadow.scale.set(scale, scale, 1);
          rec.shadowMat.opacity = 0.42 - 0.28 * t;
        }

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

        // ---- status icons (see the STATUS ICONS section at the top of this file) ----
        const stunned = isStunned(enemy, g);
        if (stunned && !rec.wasStunned) {
          // The moment a stun actually lands: a bright, sharp flash distinct from every other
          // impact look in the game (fx.ts's IMPACT_EFFECTS), the same regardless of which of
          // the five stun sources caused it (Fireball rank V, Frost Field Deep Freeze, Shield
          // Slam, Leap Earthshaker/Shield Charge, Abyssal Grasp mastery) — "stun" reads as one
          // unmistakable concept everywhere it appears, not five different-looking ones.
          spawnBurst(rec.group.position, 0xfff9c4, 16, 6, 0.32, { upMin: 0.4, upMax: 1.1, size: 0.3 });
          spawnRing(rec.group.position, 1.1, 0xfff275, 0.3);
        }
        rec.wasStunned = stunned;

        const severity = slowSeverity(enemy, g);
        const slowKind: StatusIconKind | null = severity <= 0 ? null : severity >= ROOT_SEVERITY_THRESHOLD ? 'root' : 'slow';
        const marked = isVulnerable(enemy, g);
        const bleeding = isBleeding(enemy, g);
        const burning = isBurning(enemy, g);

        // Fixed priority cascade, capped at 2 slots — see the module doc comment for the order
        // and why. Written as plain branches (not a small helper closure) so nothing allocates
        // here; this runs for every enemy, every render frame.
        let iconKind1: StatusIconKind | null = null;
        let iconKind2: StatusIconKind | null = null;
        if (stunned) {
          iconKind1 = 'stun';
          if (slowKind) iconKind2 = slowKind;
          else if (marked) iconKind2 = 'mark';
          else if (bleeding) iconKind2 = 'bleed';
          else if (burning) iconKind2 = 'burn';
        } else if (slowKind) {
          iconKind1 = slowKind;
          if (marked) iconKind2 = 'mark';
          else if (bleeding) iconKind2 = 'bleed';
          else if (burning) iconKind2 = 'burn';
        } else if (marked) {
          iconKind1 = 'mark';
          if (bleeding) iconKind2 = 'bleed';
          else if (burning) iconKind2 = 'burn';
        } else if (bleeding) {
          iconKind1 = 'bleed';
          if (burning) iconKind2 = 'burn';
        } else if (burning) {
          iconKind1 = 'burn';
        }

        rec.icon1.visible = iconKind1 !== null;
        rec.icon2.visible = iconKind2 !== null;
        if (iconKind1 !== null) {
          const iy = enemy.pos.y + rec.barY + 0.3;
          const singleSlot = iconKind2 === null;
          const off1 = singleSlot ? 0 : -ICON_SPACING / 2;
          rec.icon1Mat.map = statusIconTexture(iconKind1);
          rec.icon1Mat.color.setHex(STATUS_COLOR[iconKind1]);
          rec.icon1.position.set(
            enemy.pos.x + camRight.x * off1,
            iy + camRight.y * off1,
            enemy.pos.z + camRight.z * off1,
          );
          if (iconKind2 !== null) {
            const off2 = ICON_SPACING / 2;
            rec.icon2Mat.map = statusIconTexture(iconKind2);
            rec.icon2Mat.color.setHex(STATUS_COLOR[iconKind2]);
            rec.icon2.position.set(
              enemy.pos.x + camRight.x * off2,
              iy + camRight.y * off2,
              enemy.pos.z + camRight.z * off2,
            );
          }
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
