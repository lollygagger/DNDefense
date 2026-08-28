import * as THREE from 'three';

/** Owned by [ability-fx]. Small library of procedural canvas-texture glyphs for the enemy status
 *  icons drawn by render/enemyView.ts, plus the shared color/severity constants that file (and
 *  optionally ui/hud.ts's player-status row) uses. Split out of enemyView.ts to keep that file
 *  focused on the pooled-mesh discipline it already documents (ARCHITECTURE.md: "split rather
 *  than grow").
 *
 *  Every glyph is drawn once, in white with a black outline, onto a small offscreen canvas and
 *  cached as a THREE.Texture — never rebuilt per-instance or per-frame. A SpriteMaterial tints a
 *  texture by multiplying its RGB against material.color, so the white fill picks up whatever
 *  color a given instance is given while the black outline survives untinted (black * anything
 *  stays black) — one shared texture per glyph kind, however many differently-colored/positioned
 *  sprite instances reference it. */

export type StatusIconKind = 'stun' | 'root' | 'slow' | 'mark' | 'bleed' | 'burn';

/** Base tint for each glyph. 'slow' is the mild tier; once slowSeverity() (sim/status.ts) crosses
 *  ROOT_SEVERITY_THRESHOLD the same underlying debuff switches to the 'root' glyph+color instead
 *  — one mechanic (Unit.slowFactor), two readable tiers, matching the design doc's "roots them"
 *  language for Abyssal Grasp/Pinning Shot's heaviest slows without inventing a second mechanic. */
export const STATUS_COLOR: Record<StatusIconKind, number> = {
  stun: 0xfff275,
  root: 0x8a5cf0,
  slow: 0x7fd8ff,
  mark: 0xffb020,
  bleed: 0xe0304a,
  burn: 0xff8a3a,
};

/** slowSeverity() >= this reads as "rooted" (a heavy snare) rather than merely "slowed". Sits
 *  just above Pinning Shot's un-mastered 55-75% tier and below Frost Field/Abyssal Grasp's
 *  heaviest ranks (65-85%), so it's the late-rank control abilities that actually earn the
 *  stronger glyph, not every minor chill. */
export const ROOT_SEVERITY_THRESHOLD = 0.7;

const ICON_SIZE = 64;

function buildTexture(draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Stroke a path in black (wider — the outline) then fill it in white (the tint target, drawn on
 *  top) — the trick described in the file doc comment. */
function outlinedFill(ctx: CanvasRenderingContext2D, path: Path2D): void {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#000';
  ctx.stroke(path);
  ctx.fillStyle = '#fff';
  ctx.fill(path);
}

/** One glyph per status kind, deliberately silhouette-distinct (not just color-distinct) so the
 *  set stays legible for colorblind players and at the distance a horde is usually viewed from. */
const DRAW: Record<StatusIconKind, (ctx: CanvasRenderingContext2D) => void> = {
  // Jagged bolt — the single most decision-relevant status gets the sharpest silhouette.
  stun: (ctx) => {
    const p = new Path2D();
    p.moveTo(-4, -22);
    p.lineTo(8, -4);
    p.lineTo(-1, -4);
    p.lineTo(9, 20);
    p.lineTo(-11, -2);
    p.lineTo(-2, -2);
    p.closePath();
    outlinedFill(ctx, p);
  },
  // Padlock — reads as "locked in place", distinct from the snowflake's "chilled" read.
  root: (ctx) => {
    const p = new Path2D();
    p.rect(-13, -4, 26, 22);
    outlinedFill(ctx, p);
    ctx.lineCap = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.arc(0, -6, 10, Math.PI, 0);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, -6, 10, Math.PI, 0);
    ctx.stroke();
  },
  // Snowflake — six spokes, the classic "chilled" read for a mild-to-moderate slow.
  slow: (ctx) => {
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI) / 3;
      const dx = Math.cos(a) * 20;
      const dy = Math.sin(a) * 20;
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      ctx.moveTo(-dx, -dy);
      ctx.lineTo(dx, dy);
      ctx.stroke();
      ctx.lineWidth = 4.5;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(-dx, -dy);
      ctx.lineTo(dx, dy);
      ctx.stroke();
    }
  },
  // Reticle — a target ring + crosshair ticks, "priority target, extra damage taken".
  mark: (ctx) => {
    ctx.lineCap = 'round';
    for (const [w, c] of [
      [8, '#000'],
      [4.5, '#fff'],
    ] as [number, string][]) {
      ctx.lineWidth = w;
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.stroke();
      for (const a of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 19, Math.sin(a) * 19);
        ctx.lineTo(Math.cos(a) * 24, Math.sin(a) * 24);
        ctx.stroke();
      }
    }
  },
  // Droplet — the classic blood-drop silhouette.
  bleed: (ctx) => {
    const p = new Path2D();
    p.moveTo(0, -20);
    p.bezierCurveTo(12, -2, 15, 8, 15, 12);
    p.bezierCurveTo(15, 21, 8, 22, 0, 22);
    p.bezierCurveTo(-8, 22, -15, 21, -15, 12);
    p.bezierCurveTo(-15, 8, -12, -2, 0, -20);
    p.closePath();
    outlinedFill(ctx, p);
  },
  // Flame — a licking teardrop with an inner notch, unmistakably "fire" even tinted for a
  // non-fire damage-zone source (curses, ally scorch patches — see abilityEffects.ts's
  // isBurning doc comment for why this generic glyph covers all of them).
  burn: (ctx) => {
    const p = new Path2D();
    p.moveTo(0, 22);
    p.bezierCurveTo(-14, 14, -14, -2, -3, -22);
    p.bezierCurveTo(-4, -10, 3, -8, 5, -14);
    p.bezierCurveTo(11, -6, 14, 4, 8, 12);
    p.bezierCurveTo(11, 8, 9, 2, 6, 2);
    p.bezierCurveTo(9, 12, 5, 20, 0, 22);
    p.closePath();
    outlinedFill(ctx, p);
  },
};

const textures = new Map<StatusIconKind, THREE.CanvasTexture>();

/** Lazily built, cached forever — one texture per glyph kind regardless of how many enemies show
 *  it at once. Safe to call every frame; it only allocates the first time each kind is asked for. */
export function statusIconTexture(kind: StatusIconKind): THREE.Texture {
  let tex = textures.get(kind);
  if (!tex) {
    tex = buildTexture(DRAW[kind]);
    textures.set(kind, tex);
  }
  return tex;
}
