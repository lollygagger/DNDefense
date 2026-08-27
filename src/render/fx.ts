import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import type { Impact } from '../sim/projectiles';
import { R } from './scene';
import { spawnBeam, updateBeams } from './aerialBeam';

/** Owned by [ability-fx] (was FROZEN). Reads sim state, never mutates it. Instanced projectile
 *  rendering (by `kind`), particle bursts, expanding rings, lingering ground fields, and (via
 *  aerialBeam.ts) short ground-to-sky beams. `spawnBurst`/`spawnRing` are a stable contract
 *  (enemyView/allyView use them for death fx) — original positional signatures unchanged; new
 *  behavior is opt-in via a trailing options object. Cosmetic Math.random() is fine here.
 *
 *  HOSTILE VS. FRIENDLY COLOR CONVENTION. The player's own effects own clean, single-family
 *  hues with no dark tones: Fireball is warm orange/gold, Arcane Bolt is violet, Frost is icy
 *  blue. Enemy-originated attacks (currently: the flying enemies' bomb/breath, sim/flyers.ts)
 *  are deliberately "dirty" instead — every one pairs an off-palette hue (never orange, violet,
 *  or icy blue) with genuine black/charcoal smoke or soot, a visual element the player's own
 *  effects never use. That's the rule for any future enemy attack: smoke + an off-palette hue
 *  means "this is being done to you," not "you did this." */
// ---------- In-flight projectile look (silhouette + motion, not just tint) ----------

interface ProjectileStyle {
  shape: 'orb' | 'shard' | 'bolt' | 'spike' | 'arrow';
  color: number;
  size: number;
  glow?: boolean; // adds a soft additive halo/streak instance
  glowColor?: number;
  trail?: boolean; // stretch + trail the glow backward into a comet streak
  spin?: number; // radians/sec roll around the direction of travel
}

/** One entry per `ProjectileSpec.kind` spawned by sim code. Arcane bolts and heavy ballista
 *  bolts glow and trail like artillery; mundane crossbow bolts and arrows stay dull and
 *  fletched; the fireball is a big trailing ember. Add a kind here — no branching needed. */
const PROJECTILE_STYLES: Record<string, ProjectileStyle> = {
  bolt: { shape: 'shard', color: 0xb46bff, size: 0.26, glow: true, glowColor: 0xd9a8ff, trail: true, spin: 14 },
  crossbow: { shape: 'bolt', color: 0xd9c9a3, size: 0.16, spin: 2 },
  ballista: { shape: 'spike', color: 0xffb347, size: 0.32, glow: true, glowColor: 0xffcf8a, trail: true, spin: 6 },
  arrow: { shape: 'arrow', color: 0x9a9a8a, size: 0.15, spin: 4 },
  fireball: { shape: 'orb', color: 0xff6a2a, size: 0.55, glow: true, glowColor: 0xffb14a, trail: true },
  // Hot air balloon's bomb telegraph (sim/flyers.ts spawns this as a harmless real projectile,
  // ahead of the real detonation, purely so the player sees it coming). Dark powder-keg body;
  // the `trail`'s glow streaks backward along travel — for a straight vertical drop that's
  // *upward*, toward the balloon, so the falling bomb visibly reads as tethered to its source.
  bombFall: { shape: 'orb', color: 0x2b2924, size: 0.4, glow: true, glowColor: 0xff9a3a, trail: true, spin: 5 },
  // Crossbow's Cannon branch: a big, dull iron ball. Deliberately heavy and un-glowy — its
  // whole identity is a slow shot you have to lead, so it should look like a thrown weight
  // rather than a bolt. Large size sells the mass; the lazy spin sells the slow travel.
  cannonball: { shape: 'orb', color: 0x3f4247, size: 0.5, spin: 3 },
};
const FALLBACK_STYLE: ProjectileStyle = { shape: 'orb', color: 0xffffff, size: 0.25 };

/** Shapes point along local +Z ("forward") — rotateX(90°) turns a cylinder/cone's default +Y
 *  into +Z, and the render loop quaternion-aligns +Z to each projectile's velocity direction,
 *  so these read nose-first along their travel. Geometry .scale()/.rotateX() return `this`. */
function buildShapeGeometry(style: ProjectileStyle): THREE.BufferGeometry {
  const s = style.size;
  switch (style.shape) {
    case 'shard': // magic bolt crystal, distinct from a plain sphere
      return new THREE.OctahedronGeometry(s, 0).scale(1, 1, 2.4);
    case 'bolt': // thin mundane shaft (crossbow bolt)
      return new THREE.CylinderGeometry(s * 0.3, s * 0.42, s * 2.6, 6).rotateX(Math.PI / 2);
    case 'spike': // heavy tapered bolt (ballista upgrade / Piercing Shot)
      return new THREE.ConeGeometry(s * 0.5, s * 2.8, 6).rotateX(Math.PI / 2);
    case 'arrow': // slender fletched arrow, apex-forward
      return new THREE.ConeGeometry(s * 0.3, s * 2.4, 4).rotateX(Math.PI / 2);
    case 'orb':
    default:
      return new THREE.SphereGeometry(s, 8, 6);
  }
}

// ---------- Particle bursts (shared helper — signature frozen, behavior extensible) ----------

export interface BurstOptions {
  upMin?: number; // fraction of speed aimed upward, min (default 0.2)
  upMax?: number; // fraction of speed aimed upward, max (default 1.1)
  gravity?: number; // downward accel, units/s^2 (default 18)
  size?: number; // point size (default 0.35)
  converge?: boolean; // start spread out and fly inward (implosion) instead of outward
  startRadius?: number; // converge-only: initial offset from pos (default speed*0.15)
}

interface Burst {
  points: THREE.Points;
  vels: Float32Array;
  life: number;
  maxLife: number;
  gravity: number;
}

const bursts: Burst[] = [];
const MAX_BURSTS = 48;

/** Spawn a one-shot particle burst. `pos/color/count/speed/life` are the original frozen
 *  positional contract (enemyView.ts, allyView.ts call it exactly this way for death effects).
 *  `opts` is additive: omit it and behavior is byte-for-byte what it always was. */
export function spawnBurst(
  pos: THREE.Vector3,
  color: number,
  count = 14,
  speed = 6,
  life = 0.5,
  opts?: BurstOptions,
): void {
  if (bursts.length >= MAX_BURSTS) return;
  const upMin = opts?.upMin ?? 0.2;
  const upMax = opts?.upMax ?? 1.1;
  const gravity = opts?.gravity ?? 18;
  const size = opts?.size ?? 0.35;
  const converge = opts?.converge ?? false;
  const startRadius = opts?.startRadius ?? speed * 0.15;

  const positions = new Float32Array(count * 3);
  const vels = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const up = upMin + Math.random() * (upMax - upMin);
    const dirX = Math.cos(theta);
    const dirZ = Math.sin(theta);
    const spd = speed * (0.4 + Math.random() * 0.6);
    if (converge) {
      // Start on a ring around pos, fly inward — reads as a portal/implosion (mage Blink).
      positions[i * 3] = pos.x + dirX * startRadius;
      positions[i * 3 + 1] = pos.y + 0.2 + up * startRadius * 0.5;
      positions[i * 3 + 2] = pos.z + dirZ * startRadius;
      vels[i * 3] = -dirX * spd;
      vels[i * 3 + 1] = -up * spd * 0.4;
      vels[i * 3 + 2] = -dirZ * spd;
    } else {
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y + 0.2;
      positions[i * 3 + 2] = pos.z;
      vels[i * 3] = dirX * spd;
      vels[i * 3 + 1] = up * speed * 0.8;
      vels[i * 3 + 2] = dirZ * spd;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  R.scene.add(points);
  bursts.push({ points, vels, life, maxLife: life, gravity });
}

// ---------- Expanding rings (instant AoE flash — frozen signature) ----------

interface Ring {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  targetRadius: number;
}

const rings: Ring[] = [];
const MAX_RINGS = 24;

export function spawnRing(pos: THREE.Vector3, radius: number, color: number, life = 0.45): void {
  if (rings.length >= MAX_RINGS) return;
  const geo = new THREE.RingGeometry(0.1, 0.35, 32);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(pos.x, pos.y + 0.06, pos.z);
  R.scene.add(mesh);
  rings.push({ mesh, life, maxLife: life, targetRadius: radius });
}

// ---------- Lingering ground fields (Frost Field, Ground Slam, Leap landing) ----------

/** A disc + pulsing rim that grows to `radius`, holds for the bulk of `duration`, then fades —
 *  unlike `spawnRing` (a one-shot flash), the boundary stays visible the whole time it matters.
 *  Used by Frost Field's slow zone and Ground Slam's stagger window. */
interface Field {
  disc: THREE.Mesh;
  rim: THREE.Mesh;
  life: number;
  totalLife: number;
  targetRadius: number;
  growTime: number;
  fadeTime: number;
}

const fields: Field[] = [];
const MAX_FIELDS = 8;

function spawnField(pos: THREE.Vector3, radius: number, color: number, duration: number): void {
  if (fields.length >= MAX_FIELDS) return;
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(pos.x, pos.y + 0.05, pos.z);
  disc.scale.setScalar(0.001);
  R.scene.add(disc);

  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(pos.x, pos.y + 0.07, pos.z);
  rim.scale.setScalar(0.001);
  R.scene.add(rim);

  const growTime = Math.min(0.35, duration * 0.25);
  const fadeTime = Math.min(0.5, duration * 0.3);
  fields.push({ disc, rim, life: duration, totalLife: duration, targetRadius: radius, growTime, fadeTime });
}

// ---------- Real-radius lookup for AoE impacts ----------

/** FALLBACK ONLY. `Impact` now carries the true `radius`/`duration` the sim actually applied,
 *  and `rankVisual()` prefers those — always use the live values when present. This table
 *  survives purely for impacts emitted without them (older call sites, or a kind whose radius
 *  isn't meaningful), and it is a known staleness hazard: retune an ability in src/data/ and
 *  these numbers silently keep drawing the old size. If you find yourself editing this table,
 *  populate `radius`/`duration` at the `impacts.push()` call site instead. */
interface RankVisual {
  radius: number;
  duration?: number;
}
const ABILITY_RANK_VISUALS: Record<string, RankVisual[]> = {
  fireball: [{ radius: 4 }, { radius: 5 }, { radius: 6 }, { radius: 6.5 }],
  frostField: [{ radius: 5, duration: 4 }, { radius: 5, duration: 5 }, { radius: 5, duration: 6 }, { radius: 6.5, duration: 7 }],
  groundSlam: [{ radius: 3, duration: 1.2 }, { radius: 3, duration: 1.2 }, { radius: 3, duration: 1.2 }, { radius: 4, duration: 1.6 }],
  leap: [{ radius: 2.5 }, { radius: 2.5 }, { radius: 2.5 }, { radius: 3 }],
};

/** Prefer what the sim actually did (imp.radius/duration) over the mirrored balance table, so
 *  an AoE indicator can never disagree with the damage the player just dealt. */
function rankVisual(game: GameState, abilityId: string, imp?: Impact): RankVisual {
  const table = ABILITY_RANK_VISUALS[abilityId];
  const rank = game.localPlayer?.abilityRanks[abilityId] ?? 0;
  const fallback = table[Math.min(Math.max(rank, 0), table.length - 1)];
  if (imp?.radius === undefined && imp?.duration === undefined) return fallback;
  return {
    radius: imp.radius ?? fallback.radius,
    duration: imp.duration ?? fallback.duration,
  };
}

// ---------- Impact look, one entry per `kind` (data-driven — no per-kind branching) ----------

type ImpactFn = (imp: Impact, game: GameState) => void;

const IMPACT_EFFECTS: Record<string, ImpactFn> = {
  // Arcane Bolt hit: a tight violet spark, not an explosion.
  bolt: (imp) => {
    spawnBurst(imp.pos, 0xc98cff, 14, 5, 0.35, { upMin: 0.3, upMax: 0.9, size: 0.28 });
    spawnRing(imp.pos, 0.7, 0xb46bff, 0.22);
  },
  // Crossbow bolt: a small dull thunk, no ring — deliberately the least dramatic hit.
  crossbow: (imp) => {
    spawnBurst(imp.pos, 0xcbb98f, 7, 3.5, 0.3, { upMin: 0.1, upMax: 0.5, gravity: 22, size: 0.22 });
  },
  // Ballista bolt / Piercing Shot: a heavier orange shockwave — same kind, same look, by design.
  ballista: (imp) => {
    spawnBurst(imp.pos, 0xffb347, 20, 8, 0.4, { upMin: 0.15, upMax: 0.7, size: 0.34 });
    spawnRing(imp.pos, 1.3, 0xff9a3a, 0.3);
  },
  // Quickshot / enemy arrows: a flat, fast, sharp spray — no upward fountain, no ring.
  arrow: (imp) => {
    spawnBurst(imp.pos, 0x9a9a8a, 7, 4.5, 0.28, { upMin: 0.05, upMax: 0.45, gravity: 24, size: 0.2 });
  },
  // Cannon splash: a heavy earth-and-iron thump. Slow, low, weighty particles rather than a
  // bright flash — this is a mass impact, not an explosion. Ring uses the shell's real splash
  // radius (published from aoeRadius), so the indicator can't disagree with what it damaged.
  cannonball: (imp) => {
    spawnBurst(imp.pos, 0x6b6257, 24, 7, 0.5, { upMin: 0.2, upMax: 0.8, gravity: 26, size: 0.36 });
    spawnBurst(imp.pos, 0x2f2d2a, 10, 3.5, 0.55, { upMin: 0.4, upMax: 1, gravity: 6, size: 0.45 });
    if (imp.radius) spawnRing(imp.pos, imp.radius, 0x8a7f6d, 0.4);
  },
  // Flamethrower cone tick: a low, rolling wash of fire. Short-lived and repeated (the tower
  // pulses this while burning), so it stays cheap and reads as continuous flame rather than a
  // series of discrete hits. Its lingering field is sized from the tower's real cone reach.
  flame: (imp) => {
    spawnBurst(imp.pos, 0xff7a1e, 14, 5, 0.3, { upMin: 0.3, upMax: 1, gravity: -2, size: 0.44 });
    spawnBurst(imp.pos, 0xffd66b, 6, 3, 0.22, { upMin: 0.4, upMax: 1.1, gravity: -4, size: 0.3 });
    if (imp.radius) spawnField(imp.pos, imp.radius, 0xff6a2a, imp.duration ?? 0.4);
  },
  // Arc lightning: a hard, instantaneous white-hot spark. No ring and no lingering anything —
  // the chain's readability comes from several of these popping in sequence across the targets
  // it jumped between, which is exactly the information the player wants.
  lightning: (imp) => {
    spawnBurst(imp.pos, 0xeaf4ff, 12, 11, 0.16, { upMin: 0.2, upMax: 1.1, gravity: 0, size: 0.26 });
    spawnBurst(imp.pos, 0x66c2ff, 8, 7, 0.24, { upMin: 0.1, upMax: 0.9, gravity: 4, size: 0.32 });
  },
  // Fireball: two-tone detonation + a ring sized to the real blast radius for the caster's rank.
  fireball: (imp, game) => {
    const { radius } = rankVisual(game, 'fireball', imp);
    spawnBurst(imp.pos, 0xff6a2a, 26, 10, 0.6, { upMin: 0.3, upMax: 1.1, size: 0.42 });
    spawnBurst(imp.pos, 0xffe27a, 12, 5, 0.3, { upMin: 0.4, upMax: 1, gravity: 6, size: 0.5 });
    spawnRing(imp.pos, radius, 0xff8a3a, 0.5);
  },
  // Balloon bomb's own quiet ground-touch (the harmless falling prop from sim/flyers.ts landing
  // slightly before/after the real blast) — a small dust thud, deliberately unshowy so it never
  // competes with the real 'bombBlast' explosion.
  bombFall: (imp) => {
    spawnBurst(imp.pos, 0x8a8578, 6, 3, 0.2, { upMin: 0.05, upMax: 0.3, gravity: 20, size: 0.18 });
  },
  // Hot air balloon's bomb: black powder-smoke + a sickly toxic-green flash, sized to the real
  // blast radius (sim/flyers.ts). Deliberately not fire-colored — reads as a lobbed explosive,
  // not a spell — and the black smoke marks it hostile per this file's color convention.
  bombBlast: (imp) => {
    const radius = imp.radius ?? 4;
    spawnBurst(imp.pos, 0x2a2722, 22, 6, 0.55, { upMin: 0.3, upMax: 0.85, gravity: 5, size: 0.42 });
    spawnBurst(imp.pos, 0xc7e05a, 16, 9, 0.35, { upMin: 0.2, upMax: 0.8, size: 0.34 });
    spawnRing(imp.pos, radius, 0x8a9a3a, 0.45);
  },
  // Dragon breath: crimson fire + black soot (never Fireball's clean orange/gold), a scorch ring
  // at the real breath radius, and a beam connecting the dragon's real dive-bottom altitude
  // (imp.originY, sim/flyers.ts) down to the ground point it hit — so the source overhead is
  // never ambiguous, unlike an explosion floating with nothing visibly causing it.
  dragonBreath: (imp) => {
    const radius = imp.radius ?? 3;
    spawnBurst(imp.pos, 0xff4d2e, 20, 8, 0.4, { upMin: 0.25, upMax: 0.9, size: 0.4 });
    spawnBurst(imp.pos, 0x241f1c, 10, 4, 0.45, { upMin: 0.3, upMax: 0.7, gravity: 4, size: 0.32 });
    spawnRing(imp.pos, radius, 0xb8202a, 0.4);
    if (imp.originY !== undefined) spawnBeam(imp.pos, imp.originY, radius, 0xd8402a, 0.22);
  },
  // Frost Field (aoe) gets a lingering field at the real radius/duration; Pinning Shot (single
  // target, same kind) just gets a small snowflake burst on the enemy it hit.
  frost: (imp, game) => {
    if (imp.aoe) {
      const { radius, duration = 4 } = rankVisual(game, 'frostField', imp);
      spawnBurst(imp.pos, 0xbdeeff, 16, 4, 0.4, { upMin: 0.1, upMax: 0.6, gravity: 4, size: 0.3 });
      spawnField(imp.pos, radius, 0x7fd8ff, duration);
    } else {
      spawnBurst(imp.pos, 0x9fe4ff, 9, 3.5, 0.3, { upMin: 0.2, upMax: 0.8, gravity: 6, size: 0.26 });
    }
  },
  // Cleave: a bright, flat, near-instant spray — no ring, since the impact point carries no
  // swing direction to draw an honest cone from.
  slash: (imp) => {
    spawnBurst(imp.pos, 0xf2f2f2, 12, 7, 0.18, { upMin: 0.05, upMax: 0.3, gravity: 2, size: 0.3 });
  },
  // Ground Slam: earthy shockwave burst + a lingering field at the real radius/stagger window.
  slam: (imp, game) => {
    const { radius, duration = 1.2 } = rankVisual(game, 'groundSlam', imp);
    spawnBurst(imp.pos, 0xcaa06a, 20, 7, 0.4, { upMin: 0.1, upMax: 0.5, gravity: 20, size: 0.3 });
    spawnField(imp.pos, radius, 0xd98a4a, duration);
  },
  // Leap: small dust puff on takeoff; a bigger vertical dust plume + real-radius ring on
  // landing (vs Ground Slam's flatter shockwave).
  leap: (imp, game) => {
    if (imp.aoe) {
      const { radius } = rankVisual(game, 'leap', imp);
      spawnBurst(imp.pos, 0x9c8a70, 22, 6.5, 0.45, { upMin: 0.4, upMax: 1.1, gravity: 14, size: 0.32 });
      spawnRing(imp.pos, radius, 0xb0a488, 0.35);
    } else {
      spawnBurst(imp.pos, 0xaaa290, 8, 3, 0.25, { upMin: 0.1, upMax: 0.4, gravity: 18, size: 0.22 });
    }
  },
  // Grapple Hook: a quick steel-green snap at both the launch and landing point.
  grapple: (imp) => {
    spawnBurst(imp.pos, 0x8fd67a, 10, 6, 0.22, { upMin: 0.2, upMax: 0.7, gravity: 10, size: 0.24 });
    spawnRing(imp.pos, 1.2, 0x8fd67a, 0.2);
  },
  // Blink: particles implode on departure, explode on arrival — reads as a teleport.
  blink: (imp) => {
    spawnBurst(imp.pos, 0xb46bff, 16, 6, 0.3, { upMin: 0.2, upMax: 0.9, converge: true, size: 0.3 });
    spawnRing(imp.pos, 1.4, 0xd9a8ff, 0.25);
  },
  // Second Wind: slow-rising warm motes around the caster — a heal glow, not a combat impact.
  secondWind: (imp) => {
    spawnBurst(imp.pos, 0xff8fa3, 14, 2.2, 0.7, { upMin: 0.8, upMax: 1.3, gravity: -2, size: 0.3 });
  },
  // Bulwark (Tank): a brief brass/gold shield flare, not a lingering field — the ability itself
  // is a self-buff with no gameplay radius to size a ring from, so this is a fixed "moment" flash
  // exactly like Blink/Grapple's, not a faked AoE indicator. Warm metallic gold reads as "shield"
  // and is deliberately distinct from Second Wind's pink (healing) and from any damage look.
  bulwark: (imp) => {
    spawnBurst(imp.pos, 0xe0c060, 16, 4.5, 0.4, { upMin: 0.15, upMax: 0.6, gravity: -1, size: 0.3 });
    spawnRing(imp.pos, 1.6, 0xf0d878, 0.35);
  },
};

function handleImpact(imp: Impact, game: GameState): void {
  const fn = IMPACT_EFFECTS[imp.kind];
  if (fn) fn(imp, game);
  else spawnBurst(imp.pos, FALLBACK_STYLE.color, imp.aoe ? 20 : 8, imp.aoe ? 8 : 4);
}

// ---------- Driver ----------

const FORWARD = new THREE.Vector3(0, 0, 1);
const tmpDir = new THREE.Vector3();

/** Disposable-object plumbing shared by bursts/rings/fields' expiry cleanup. */
function killMesh(o: THREE.Points | THREE.Mesh): void {
  R.scene.remove(o);
  o.geometry.dispose();
  (o.material as THREE.Material).dispose();
}

/** A capacity-256 InstancedMesh, added to the scene once and reused forever (capacity bounds
 *  worst-case instances per kind regardless of how many projectiles are actually alive). */
function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, 256);
  m.count = 0;
  m.frustumCulled = false;
  R.scene.add(m);
  return m;
}

export function initFx(game: GameState): void {
  // Instanced projectile rendering, one main mesh + optional glow mesh per kind, lazily built.
  const kindMeshes = new Map<string, THREE.InstancedMesh>();
  const glowMeshes = new Map<string, THREE.InstancedMesh>();
  const dummy = new THREE.Object3D();
  let animTime = 0;

  const meshFor = (kind: string, style: ProjectileStyle): THREE.InstancedMesh => {
    let m = kindMeshes.get(kind);
    if (!m) {
      m = makeInstanced(buildShapeGeometry(style), new THREE.MeshBasicMaterial({ color: style.color }));
      kindMeshes.set(kind, m);
    }
    return m;
  };

  const glowMeshFor = (kind: string, style: ProjectileStyle): THREE.InstancedMesh => {
    let m = glowMeshes.get(kind);
    if (!m) {
      const mat = new THREE.MeshBasicMaterial({
        color: style.glowColor ?? style.color,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      m = makeInstanced(new THREE.SphereGeometry(style.size * 1.7, 6, 5), mat);
      glowMeshes.set(kind, m);
    }
    return m;
  };

  game.addSystem({
    render(dt) {
      animTime += dt;

      // Projectiles: oriented along travel direction, with an optional trailing glow.
      for (const m of kindMeshes.values()) m.count = 0;
      for (const m of glowMeshes.values()) m.count = 0;
      for (const p of game.projectiles.list) {
        if (!p.alive) continue;
        const style = PROJECTILE_STYLES[p.kind] ?? FALLBACK_STYLE;

        tmpDir.copy(p.vel);
        if (tmpDir.lengthSq() < 1e-6) tmpDir.copy(FORWARD);
        else tmpDir.normalize();

        const m = meshFor(p.kind, style);
        if (m.count < 256) {
          dummy.position.copy(p.pos);
          dummy.quaternion.setFromUnitVectors(FORWARD, tmpDir);
          dummy.scale.set(1, 1, 1);
          if (style.spin) dummy.rotateZ(animTime * style.spin);
          dummy.updateMatrix();
          m.setMatrixAt(m.count++, dummy.matrix);
        }

        if (style.glow) {
          const gm = glowMeshFor(p.kind, style);
          if (gm.count < 256) {
            const stretch = style.trail ? 2.6 : 1.3;
            const backOffset = style.trail ? style.size * 1.8 : 0;
            dummy.position.copy(p.pos).addScaledVector(tmpDir, -backOffset);
            dummy.quaternion.setFromUnitVectors(FORWARD, tmpDir);
            dummy.scale.set(1, 1, stretch);
            dummy.updateMatrix();
            gm.setMatrixAt(gm.count++, dummy.matrix);
          }
        }
      }
      for (const m of kindMeshes.values()) m.instanceMatrix.needsUpdate = true;
      for (const m of glowMeshes.values()) m.instanceMatrix.needsUpdate = true;

      // Impact events -> per-kind effect (burst/ring/field), then drain the channel.
      for (const imp of game.projectiles.impacts) handleImpact(imp, game);
      game.projectiles.impacts.length = 0;

      // Bursts
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.life -= dt;
        if (b.life <= 0) {
          killMesh(b.points);
          bursts.splice(i, 1);
          continue;
        }
        const attr = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        for (let j = 0; j < arr.length; j += 3) {
          b.vels[j + 1] -= b.gravity * dt;
          arr[j] += b.vels[j] * dt;
          arr[j + 1] += b.vels[j + 1] * dt;
          arr[j + 2] += b.vels[j + 2] * dt;
        }
        attr.needsUpdate = true;
        (b.points.material as THREE.PointsMaterial).opacity = b.life / b.maxLife;
      }

      // Rings
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.life -= dt;
        if (r.life <= 0) {
          killMesh(r.mesh);
          rings.splice(i, 1);
          continue;
        }
        const t = 1 - r.life / r.maxLife;
        const s = 0.2 + t * r.targetRadius;
        r.mesh.scale.set(s, s, s);
        (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      }

      // Fields: grow to targetRadius, hold (pulsing rim), fade.
      for (let i = fields.length - 1; i >= 0; i--) {
        const f = fields[i];
        f.life -= dt;
        if (f.life <= 0) {
          killMesh(f.disc);
          killMesh(f.rim);
          fields.splice(i, 1);
          continue;
        }
        const elapsed = f.totalLife - f.life;
        let radiusT = 1;
        let opacityMul = 1;
        if (elapsed < f.growTime) {
          radiusT = elapsed / f.growTime;
          opacityMul = radiusT;
        } else if (f.life < f.fadeTime) {
          opacityMul = f.life / f.fadeTime;
        }
        const rad = Math.max(0.001, f.targetRadius * radiusT);
        f.disc.scale.setScalar(rad);
        f.rim.scale.setScalar(rad);
        (f.disc.material as THREE.MeshBasicMaterial).opacity = 0.14 * opacityMul;
        const pulse = 0.55 + Math.sin(elapsed * 3) * 0.12;
        (f.rim.material as THREE.MeshBasicMaterial).opacity = pulse * opacityMul;
      }

      // Beams (dragon breath's ground-to-sky connector) — own cap/lifecycle in aerialBeam.ts.
      updateBeams(dt);
    },
  });
}
