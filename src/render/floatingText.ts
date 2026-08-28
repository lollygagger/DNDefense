import * as THREE from 'three';
import type { GameState } from '../sim/GameState';
import { getDamageQueue, flushDueBuckets, type DamageEventKind } from '../sim/damageEvents';
import { R } from './scene';
import { STATUS_COLOR } from './statusIcons';

/** Owned by [enemies-waves] (combat-legibility task, 2026-08-27). Floating combat text: small
 *  billboarded number sprites that rise and fade off an enemy the instant `sim/damageEvents.ts`
 *  records a hit on it. This is what makes a damage-over-time tick and a marked enemy's bonus
 *  damage actually visible, rather than just "a violet circle is doing something."
 *
 *  TEXT WITHOUT A FONT DEPENDENCY. Same precedent as render/statusIcons.ts's procedural glyph
 *  textures: draw onto an offscreen 2D canvas (native Canvas `fillText`, no bundled font asset,
 *  no npm dependency — the browser's own system font stack) and use the result as a THREE.Sprite
 *  map. Numbers are drawn once in plain outlined white and cached by their displayed string;
 *  per-instance color comes from tinting the SpriteMaterial, exactly like statusIcons.ts's glyphs
 *  are tinted by `STATUS_COLOR` — so the same "42" texture is reused for every enemy that happens
 *  to take 42 damage, in whatever color that particular hit's category calls for.
 *
 *  THREE VISUAL CATEGORIES (the "make the numbers say something" requirement):
 *   - `hit`  — a direct, discrete attack connecting (bolt/arrow/swing/beam tick/tower shot).
 *     Near-white, sized a little by magnitude so a big hit visibly reads as a big hit.
 *   - `dot`  — an aggregated damage-over-time bucket (bleed, a burning/curse zone, the
 *     flamethrower cone, wall base damage — see damageEvents.ts for how these get identified
 *     without being individually tagged). Deliberately smaller and dimmer than a `hit`, and at
 *     fixed size regardless of the bucket's summed total, so a horde of bleeding/burning enemies
 *     reads as "still taking damage" without competing with real hits for attention.
 *   - `kill` — the blow that actually ends an enemy. Brightest, biggest, longest-lived; never
 *     bucketed (see damageEvents.ts), so a kill is never swallowed by a DoT stream.
 *  AMPLIFIED (the "prove the mark works" requirement): any hit landing while the target is
 *  vulnerable (Curse of Agony's mark, Warrior's Fracture, Archer's Hunter's Mark...) is recolored
 *  to `STATUS_COLOR.mark` — the exact color enemyView.ts's own "mark" status icon already uses —
 *  and scaled up an extra 25%, regardless of which of the three categories above it belongs to.
 *  A marked enemy's numbers visibly matching its own mark icon's color, and running hotter than
 *  an unmarked enemy's, is what makes "the violet mark makes them take more damage" legible
 *  without a tutorial.
 *
 *  READABILITY UNDER LOAD. Concurrent floaters are capped at MAX_FLOATING_TEXTS (40) — a pooled
 *  set of Sprites reused via acquire/release, the same shape as fx.ts's bursts/rings/fields. When
 *  the pool is full and an incoming `hit` or `kill` has nowhere to go, it steals the slot of the
 *  shortest-remaining-life `dot` floater instead of being dropped — real hits and kills always
 *  win a slot over a frequent, lower-priority DoT tick. Only `dot` itself is ever silently
 *  dropped once the pool is saturated with higher-priority floaters, matching the existing
 *  MAX_BURSTS/MAX_RINGS/MAX_FIELDS "drop rather than grow" idiom. */

type FloatKind = DamageEventKind;

interface Floater {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  life: number;
  maxLife: number;
  riseSpeed: number;
  baseOpacity: number;
  kind: FloatKind;
  vx: number;
  vz: number;
}

const MAX_FLOATING_TEXTS = 40;

// ---------- number textures (cached by displayed string, tinted per-instance) ----------

const TEX_W = 110;
const TEX_H = 56;
const MAX_CACHED_TEXTURES = 150; // small strings, cheap textures — plenty of headroom for the
// variety endless-mode scaling produces without caching every value ever seen

const numberTextures = new Map<string, THREE.CanvasTexture>();

function numberTexture(label: string): THREE.Texture {
  const cached = numberTextures.get(label);
  if (cached) return cached;

  if (numberTextures.size >= MAX_CACHED_TEXTURES) {
    // FIFO eviction (oldest-inserted, not true LRU): in an endless mode where damage values
    // trend steadily upward as waves scale, "oldest" already approximates "least likely to be
    // needed again" closely enough without tracking per-texture last-use.
    const oldestKey = numberTextures.keys().next().value;
    if (oldestKey !== undefined) {
      numberTextures.get(oldestKey)?.dispose();
      numberTextures.delete(oldestKey);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '800 34px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#000';
  ctx.strokeText(label, TEX_W / 2, TEX_H / 2 + 1);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, TEX_W / 2, TEX_H / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  numberTextures.set(label, tex);
  return tex;
}

// ---------- per-kind visual style ----------

interface KindStyle {
  scale: number; // sprite height, world units (width = 2x, matching the canvas aspect)
  life: number; // seconds
  rise: number; // units/sec, eased down toward the end of life
  opacity: number;
  color: number;
}

const STYLE: Record<FloatKind, KindStyle> = {
  hit: { scale: 0.46, life: 0.85, rise: 1.3, opacity: 1, color: 0xfff2e0 },
  dot: { scale: 0.3, life: 0.6, rise: 1.0, opacity: 0.72, color: 0xd9a878 },
  kill: { scale: 0.64, life: 1.05, rise: 1.55, opacity: 1, color: 0xfff6c8 },
};

const AMPLIFIED_COLOR = STATUS_COLOR.mark; // shares its hue with the mark status icon on purpose
const AMPLIFIED_SCALE_MUL = 1.25;

/** Gentle magnitude scaling for hit/kill only — dot stays flat-sized regardless of its bucket
 *  total (see file doc comment: it must never compete with real hits). Log-based so a huge
 *  endless-mode boss hit pops without the sprite growing without bound. */
function magnitudeScaleMul(amount: number): number {
  const t = 1 + Math.log10(Math.max(amount, 1) / 25) * 0.35;
  return Math.min(1.7, Math.max(0.75, t));
}

// ---------- pool ----------

const pool: Floater[] = [];
const active: Floater[] = [];

function makeFloater(): Floater {
  const mat = new THREE.SpriteMaterial({ map: numberTexture('0'), depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.visible = false;
  sprite.renderOrder = 13;
  R.scene.add(sprite);
  return { sprite, mat, life: 0, maxLife: 1, riseSpeed: 1, baseOpacity: 1, kind: 'hit', vx: 0, vz: 0 };
}

function acquireFloater(): Floater | null {
  if (active.length < MAX_FLOATING_TEXTS) return pool.pop() ?? makeFloater();
  // Pool saturated: let a hit/kill steal the slot of the shortest-remaining-life `dot` floater
  // rather than being dropped (see file doc comment). The caller only reaches here for hit/kill;
  // `spawnFloater` never calls this path for `dot`.
  let victim = -1;
  let bestLife = Infinity;
  for (let i = 0; i < active.length; i++) {
    if (active[i].kind === 'dot' && active[i].life < bestLife) {
      bestLife = active[i].life;
      victim = i;
    }
  }
  if (victim < 0) return null;
  const f = active[victim];
  active.splice(victim, 1);
  return f;
}

function spawnFloater(x: number, y: number, z: number, amount: number, kind: FloatKind, amplified: boolean): void {
  const full = active.length >= MAX_FLOATING_TEXTS;
  if (full && kind === 'dot') return; // lowest priority: dropped outright once saturated
  const f = full ? acquireFloater() : (pool.pop() ?? makeFloater());
  if (!f) return;

  const style = STYLE[kind];
  const label = kind === 'kill' ? Math.max(1, Math.round(amount)).toString() : Math.round(amount).toString();
  f.mat.map = numberTexture(label); // non-null -> non-null swap, no shader recompile (same
  // precedent as enemyView.ts's status icons reassigning `.map` every frame)

  const magMul = kind === 'dot' ? 1 : magnitudeScaleMul(amount);
  const ampMul = amplified ? AMPLIFIED_SCALE_MUL : 1;
  const h = style.scale * magMul * ampMul;
  f.sprite.scale.set(h * (TEX_W / TEX_H), h, 1);
  f.mat.color.setHex(amplified ? AMPLIFIED_COLOR : style.color);
  f.baseOpacity = style.opacity;
  f.mat.opacity = style.opacity;

  const jitter = 0.26;
  f.sprite.position.set(x + (Math.random() - 0.5) * jitter, y, z + (Math.random() - 0.5) * jitter);
  f.vx = (Math.random() - 0.5) * 0.4;
  f.vz = (Math.random() - 0.5) * 0.4;
  f.riseSpeed = style.rise;
  f.life = style.life;
  f.maxLife = style.life;
  f.kind = kind;
  f.sprite.visible = true;
  active.push(f);
}

export function initFloatingText(game: GameState): void {
  game.addSystem({
    render(dt, g) {
      flushDueBuckets(g);
      const q = getDamageQueue(g);
      for (let i = 0; i < q.count; i++) {
        const ev = q.events[i];
        if (ev.kind !== 'kill' && Math.round(ev.amount) < 1) continue; // nothing worth showing
        spawnFloater(ev.x, ev.y, ev.z, ev.amount, ev.kind, ev.amplified);
      }
      q.count = 0;

      for (let i = active.length - 1; i >= 0; i--) {
        const f = active[i];
        f.life -= dt;
        if (f.life <= 0) {
          f.sprite.visible = false;
          active.splice(i, 1);
          pool.push(f);
          continue;
        }
        const t = 1 - f.life / f.maxLife;
        f.sprite.position.y += f.riseSpeed * dt * (1 - t * 0.4); // eases off toward the end
        f.sprite.position.x += f.vx * dt;
        f.sprite.position.z += f.vz * dt;
        f.mat.opacity = f.baseOpacity * (f.life / f.maxLife);
      }
    },
  });
}
