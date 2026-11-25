/**
 * Hand-sketched map decorations: mountains, deserts, forests, sea ripples,
 * ships and a couple of sea monsters, drawn as if by a Victorian cartographer
 * with a brown-ink pen.
 *
 * Every glyph is drawn procedurally onto a 2D canvas, so nothing is fetched and
 * the same code can draw a glyph at any size (the specimen page) or bake all of
 * them into a sprite atlas once at load (buildGlyphAtlas, for the globe).
 *
 * Coordinates are in nominal CSS pixels: a glyph's box (w × h) is the size it is
 * meant to appear on the globe at its natural scale. Lines go through a "pen"
 * that wobbles and tapers them with a fixed seed per glyph, so the sketchiness is
 * the same on every load.
 */
import { mulberry32 } from '../game/schedule';

export type GlyphKind = 'mountain' | 'desert' | 'conifer' | 'broadleaf' | 'palm' | 'ripple' | 'ship' | 'serpent' | 'whale';

export interface GlyphSpec {
  kind: GlyphKind;
  variant: number;
  /** Box size in nominal CSS px. */
  w: number;
  h: number;
  /** The point (in the box) that sits on the glyph's latitude/longitude. */
  ax: number;
  ay: number;
  /** Watercolour wash colour, for glyphs that can carry one. */
  wash?: string;
  draw(pen: Pen): void;
}

/** Sketch colours: a warm sepia, lighter than the coastline ink so decoration sits beneath it. */
export const SKETCH = {
  ink: '#4e3218',
  /** Lit faces of mountains and trees: the land colour, so they cover the paper behind. */
  fill: 'rgba(239,223,180,0.9)',
  /** Sails. */
  canvas: '#f6eedb',
  forestWash: '#7d9463',
  desertWash: '#c79d4e',
  seaWash: '#8fa9a0',
};

type Pt = [number, number];

interface StrokeOpts {
  /** Perpendicular wobble amplitude, px. */
  wobble?: number;
  /** Thin both ends like a dipped pen (default true). */
  taper?: boolean;
  /** Smooth the points into a curve (Catmull-Rom) rather than joining them straight. */
  smooth?: boolean;
  colour?: string;
}

/**
 * A sketching pen over a canvas context. Lines are resampled into short
 * segments, each nudged sideways by a low-frequency wobble and drawn with a
 * slightly varying width, which reads as a hand-drawn ink line.
 */
export class Pen {
  readonly rnd: () => number;
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    seed: number,
    readonly ink = SKETCH.ink,
  ) {
    this.rnd = mulberry32(seed);
  }

  /** A random number in [a, b). */
  r(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }

  /** Jitter a point by up to ±j px. */
  j(p: Pt, j = 0.25): Pt {
    return [p[0] + this.r(-j, j), p[1] + this.r(-j, j)];
  }

  stroke(pts: Pt[], width: number, opts: StrokeOpts = {}): void {
    const { wobble = 0.22, taper = true, smooth = false, colour = this.ink } = opts;
    const path = resample(smooth ? catmull(pts) : pts, 0.35);
    if (path.length < 2) return;
    const ctx = this.ctx;
    const n = path.length;
    // Two sine waves of random phase make a wobble that never repeats exactly.
    const f1 = this.r(0.25, 0.45);
    const f2 = this.r(0.8, 1.3);
    const p1 = this.r(0, 6.28);
    const p2 = this.r(0, 6.28);
    const wq = this.r(0.85, 1.1);
    const out: Pt[] = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) s += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      const a = path[Math.max(0, i - 1)];
      const b = path[Math.min(n - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      const off = wobble * (Math.sin(s * f1 + p1) + 0.45 * Math.sin(s * f2 + p2));
      out.push([path[i][0] + nx * off, path[i][1] + ny * off]);
    }
    ctx.strokeStyle = colour;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < n; i++) {
      const t = i / (n - 1);
      const swell = taper ? 0.45 + 0.55 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.6) : 1;
      ctx.lineWidth = Math.max(0.12, width * wq * swell * (0.9 + 0.2 * Math.sin(i * 0.7 + p2)));
      ctx.beginPath();
      ctx.moveTo(out[i - 1][0], out[i - 1][1]);
      ctx.lineTo(out[i][0], out[i][1]);
      ctx.stroke();
    }
  }

  /** A closed shape filled flat (no outline). */
  fill(pts: Pt[], colour: string, smooth = false): void {
    const ctx = this.ctx;
    const path = smooth ? catmull([...pts, pts[0], pts[1]]) : pts;
    ctx.fillStyle = colour;
    ctx.beginPath();
    path.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fill();
  }

  /** An ink dot. */
  dot(x: number, y: number, r: number, colour = this.ink): void {
    const ctx = this.ctx;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.ellipse(x, y, r * this.r(0.85, 1.15), r * this.r(0.8, 1.1), this.r(0, 3.14), 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Parallel hatching inside a polygon: lines at `angle` (radians from the x
   * axis), `gap` px apart, each with its own wobble and a ragged start and end.
   */
  hatch(region: Pt[], angle: number, gap: number, width: number, opts: { ragged?: number; skip?: number } = {}): void {
    const { ragged = 0.25, skip = 0.06 } = opts;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    region.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.clip();
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // Project the region onto the normal to find the span of lines needed.
    const nx = -dy;
    const ny = dx;
    let lo = Infinity;
    let hi = -Infinity;
    let along0 = Infinity;
    let along1 = -Infinity;
    for (const p of region) {
      const d = p[0] * nx + p[1] * ny;
      const a = p[0] * dx + p[1] * dy;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
      along0 = Math.min(along0, a);
      along1 = Math.max(along1, a);
    }
    const span = along1 - along0;
    for (let d = lo + gap * this.r(0.3, 0.8); d < hi; d += gap * this.r(0.85, 1.15)) {
      if (this.rnd() < skip) continue;
      const a0 = along0 + span * this.r(0, ragged);
      const a1 = along1 - span * this.r(0, ragged);
      if (a1 - a0 < gap) continue;
      const p0: Pt = [nx * d + dx * a0, ny * d + dy * a0];
      const p1: Pt = [nx * d + dx * a1, ny * d + dy * a1];
      this.stroke([p0, p1], width, { wobble: 0.12 });
    }
    ctx.restore();
  }

  /** A soft watercolour blob: a few translucent irregular washes with a darker tide-line at the edge. */
  wash(cx: number, cy: number, rx: number, ry: number, colour: string, alpha = 0.22): void {
    const ctx = this.ctx;
    ctx.save();
    for (let k = 0; k < 3; k++) {
      const pts: Pt[] = [];
      const n = 11;
      const ph = this.r(0, 6.28);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const wob = 0.78 + 0.22 * Math.sin(a * 3 + ph) + this.r(-0.08, 0.08);
        pts.push([cx + this.r(-0.06, 0.06) * rx + Math.cos(a) * rx * wob, cy + this.r(-0.06, 0.06) * ry + Math.sin(a) * ry * wob]);
      }
      ctx.globalAlpha = alpha * (k === 0 ? 1 : 0.55);
      this.fill(pts, colour, true);
      if (k === 0) {
        // The pigment gathers at the edge as it dries.
        ctx.globalAlpha = alpha * 0.9;
        const ring = catmull([...pts, pts[0], pts[1]]);
        ctx.strokeStyle = colour;
        ctx.lineWidth = Math.max(0.6, Math.min(rx, ry) * 0.08);
        ctx.beginPath();
        ring.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- geometry ---

/** Catmull-Rom through the points (endpoints held), as a dense polyline. */
function catmull(pts: Pt[], per = 6): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Points every `step` px along a polyline. */
function resample(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    let d = step - carry;
    while (d <= len) {
      out.push([x0 + ((x1 - x0) * d) / len, y0 + ((y1 - y0) * d) / len]);
      d += step;
    }
    carry = len - (d - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

/** A quadratic curve as points. */
function quad(a: Pt, c: Pt, b: Pt, n = 10): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/** An arc of an ellipse as points (angles in radians, y down). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 14): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as Pt;
  });
}

const mirror = (pts: Pt[], w: number): Pt[] => pts.map(([x, y]) => [w - x, y]);

// --------------------------------------------------------------- mountains ---

/**
 * A mountain in profile: an outline from the left foot to the right foot,
 * the summits (indices into the outline) and the valleys between them. Light
 * comes from the upper left, so each summit's right flank, between its ridge
 * and the next valley, is hatched.
 */
interface Massif {
  outline: Pt[];
  summits: number[];
  valleys: number[];
  /** For each summit, where its ridge line meets the foot. */
  ridgeFoot: number[];
  /** Optional snow line under the summits: left unhatched above it. */
  snow?: Pt[];
}

function drawMassif(p: Pen, m: Massif, base: number): void {
  const { outline, summits, valleys } = m;
  const closed: Pt[] = [...outline, [outline[outline.length - 1][0], base + 0.3], [outline[0][0], base + 0.3]];
  p.fill(closed, SKETCH.fill);

  summits.forEach((si, k) => {
    const top = outline[si];
    const nextValley = valleys.find((v) => v > si);
    const end = nextValley ?? outline.length - 1;
    const footX = m.ridgeFoot[k];
    // Ridge: from the summit down and a little right, kinked like a spur.
    const ridge: Pt[] = [top, [top[0] + (footX - top[0]) * 0.35 + p.r(-0.4, 0.4), top[1] + (base - top[1]) * 0.38], [top[0] + (footX - top[0]) * 0.7, top[1] + (base - top[1]) * 0.7], [footX, base]];
    const flank = outline.slice(si, end + 1);
    const valleyFoot: Pt = nextValley !== undefined ? [outline[end][0] + 0.6, base] : [outline[end][0], base];
    const shade: Pt[] = [...flank, valleyFoot, ...ridge.slice().reverse()];
    let region = shade;
    if (m.snow) {
      // Keep the snowfield white: hatch only below the snow line.
      const minY = Math.min(...m.snow.map((q) => q[1]));
      region = shade.map(([x, y]) => [x, Math.max(y, minY + 0.4)] as Pt);
    }
    const steep = Math.atan2(base - top[1], outline[end][0] - top[0]);
    p.hatch(region, Math.min(1.3, steep + 0.3), 1.05, 0.4, { ragged: 0.16, skip: 0.06 });
    // Ridge drawn only part way, as a sketcher would.
    p.stroke(ridge.slice(0, 3), 0.55);
    // A couple of short slope strokes on the lit flank.
    const lit = outline.slice(0, si + 1);
    for (let k = 0; k < 2; k++) {
      const q = lit[Math.floor(lit.length * p.r(0.35, 0.8))];
      if (!q || q[1] > base - 2) continue;
      const len = (base - q[1]) * p.r(0.2, 0.35);
      p.stroke([[q[0] + 1.1, q[1] + 1.2], [q[0] + 1.1 + len * 0.45, q[1] + 1.2 + len]], 0.3);
    }
  });

  // Valley creases: a short line down from each saddle.
  for (const v of valleys) {
    const q = outline[v];
    p.stroke([q, [q[0] + p.r(-0.3, 0.6), q[1] + (base - q[1]) * 0.55]], 0.45);
  }
  if (m.snow) p.stroke(m.snow, 0.45, { wobble: 0.1 });

  // The outline, heavier than everything inside it.
  p.stroke(outline, 0.95, { wobble: 0.3 });
  // A few ground strokes at the foot.
  const x0 = outline[0][0];
  const x1 = outline[outline.length - 1][0];
  p.stroke([[x0 - 1.2, base + 0.2], [x0 + (x1 - x0) * 0.3, base + 0.4]], 0.45);
  p.stroke([[x0 + (x1 - x0) * 0.55, base + 0.5], [x1 + 1, base + 0.2]], 0.45);
}

const MOUNTAINS: Omit<GlyphSpec, 'kind' | 'variant'>[] = [
  // 0: a single sharp peak.
  {
    w: 24, h: 20, ax: 12, ay: 18,
    draw: (p) =>
      drawMassif(p, {
        outline: [[1.5, 18], [4.5, 14.5], [7.5, 10.5], [9.5, 7.2], [11.2, 3.6], [12.3, 1.8], [13.4, 4.2], [15, 6.4], [17.2, 10.6], [19.6, 14], [22.5, 18]],
        summits: [5], valleys: [], ridgeFoot: [14.2],
      }, 18),
  },
  // 1: twin peaks, the right one higher.
  {
    w: 28, h: 20, ax: 14, ay: 18,
    draw: (p) =>
      drawMassif(p, {
        outline: [[1, 18], [3.6, 13.6], [6.4, 8.4], [8.2, 5.2], [9.8, 7.8], [11.4, 9.6], [13.2, 6.4], [15.6, 3.2], [17, 1.6], [18.4, 4], [20.6, 8.2], [23.4, 13.4], [26.8, 18]],
        summits: [3, 8], valleys: [5], ridgeFoot: [9.6, 18.6],
      }, 18),
  },
  // 2: a little range of three.
  {
    w: 32, h: 17, ax: 16, ay: 15.5,
    draw: (p) =>
      drawMassif(p, {
        outline: [[1, 15.5], [3.8, 11], [6.2, 6.6], [7.4, 5.2], [8.8, 7.4], [10.4, 8.6], [12.6, 4.2], [14.4, 1.4], [16, 4.6], [18, 7.6], [19.6, 6.4], [21.8, 3.8], [23.4, 6.2], [26.4, 11.2], [30.8, 15.5]],
        summits: [3, 7, 11], valleys: [5, 9], ridgeFoot: [9, 15.6, 23.2],
      }, 15.5),
  },
  // 3: a crag with a snowfield under the summit.
  {
    w: 24, h: 22, ax: 12, ay: 20,
    draw: (p) =>
      drawMassif(p, {
        outline: [[1.2, 20], [3.6, 16.6], [5.4, 12.4], [7.6, 10.2], [8.6, 6.6], [10.4, 3.6], [11.6, 1.4], [12.6, 2.8], [13.6, 2.2], [15, 5.4], [16.2, 7.2], [17.4, 10.6], [19.6, 14.4], [22.8, 20]],
        summits: [6], valleys: [], ridgeFoot: [13.8],
        snow: [[8.9, 6.8], [9.9, 7.9], [10.8, 6.6], [11.8, 8.2], [12.9, 6.9], [14, 8.4], [15.4, 6.6]],
      }, 20),
  },
  // 4: a broad massif with a foothill before it.
  {
    w: 30, h: 19, ax: 15, ay: 17.5,
    draw: (p) => {
      drawMassif(p, {
        outline: [[4, 17.5], [6.8, 12.2], [9.4, 7.8], [11.6, 4.8], [13.4, 3.2], [15.2, 2.2], [16.4, 3.4], [18.2, 5.2], [20.6, 8.4], [23.4, 12.6], [28.6, 17.5]],
        summits: [5], valleys: [], ridgeFoot: [18.2],
      }, 17.5);
      drawMassif(p, {
        outline: [[0.6, 17.5], [2.6, 15], [4.8, 12.6], [6.6, 11.2], [8.4, 11], [10.2, 12.4], [12.2, 14.6], [14.4, 17.5]],
        summits: [4], valleys: [], ridgeFoot: [10.2],
      }, 17.5);
    },
  },
];

// ----------------------------------------------------------------- deserts ---

/** Stipple: dots scattered in an ellipse, thicker towards the middle. */
function stipple(p: Pen, cx: number, cy: number, rx: number, ry: number, n: number, rMin = 0.2, rMax = 0.36): void {
  for (let i = 0; i < n; i++) {
    // Square-root-ish radius so dots thin towards the edge without a hard rim.
    const a = p.r(0, Math.PI * 2);
    const d = Math.pow(p.rnd(), 0.75);
    p.dot(cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d, p.r(rMin, rMax));
  }
}

/** A dune: a low rounded mound, its lee (right) side stippled in shade. */
function dune(p: Pen, x: number, y: number, w: number, h: number, dots = 10): void {
  const crestX = x + w * 0.06;
  const mound: Pt[] = [[x - w / 2, y], [x - w * 0.3, y - h * 0.62], [crestX, y - h], [x + w * 0.3, y - h * 0.6], [x + w / 2, y]];
  const curve = catmull(mound, 6);
  p.fill([...curve, [x + w / 2, y + 0.2], [x - w / 2, y + 0.2]], SKETCH.fill);
  // Stipple, densest just under the crest on the lee side, thinning to the foot.
  for (let i = 0; i < dots; i++) {
    const u = Math.pow(p.rnd(), 0.8);
    const px = crestX + (x + w * 0.44 - crestX) * u * p.r(0.6, 1);
    const k = curve.reduce((best, q) => (Math.abs(q[0] - px) < Math.abs(best[0] - px) ? q : best));
    p.dot(px, k[1] + p.r(0.5, Math.max(0.7, (y - k[1]) * 0.95)), p.r(0.16, 0.27));
  }
  p.stroke(curve, 0.55, { wobble: 0.12 });
}

const DESERTS: Omit<GlyphSpec, 'kind' | 'variant'>[] = [
  // 0: a patch of stipple.
  {
    w: 26, h: 14, ax: 13, ay: 7, wash: SKETCH.desertWash,
    draw: (p) => {
      stipple(p, 13, 7, 11.5, 5.2, 60);
      stipple(p, 10, 6.2, 4, 2, 14, 0.24, 0.38);
    },
  },
  // 1: two dunes over light stipple.
  {
    w: 26, h: 14, ax: 13, ay: 8, wash: SKETCH.desertWash,
    draw: (p) => {
      stipple(p, 13, 10, 11.5, 3.2, 18, 0.15, 0.26);
      dune(p, 8.6, 8.6, 12, 4.4, 22);
      dune(p, 18.4, 11.4, 10, 3.4, 16);
    },
  },
  // 2: a field of small dune arcs and scattered dots.
  {
    w: 28, h: 15, ax: 14, ay: 8, wash: SKETCH.desertWash,
    draw: (p) => {
      stipple(p, 14, 8, 12.5, 5.6, 22, 0.15, 0.26);
      dune(p, 7, 6.6, 8.4, 2.8, 10);
      dune(p, 17.4, 5.2, 7.6, 2.5, 9);
      dune(p, 12.2, 11.8, 9.4, 3, 11);
      dune(p, 22.6, 10.4, 7, 2.4, 8);
    },
  },
];

// ----------------------------------------------------------------- forests ---

/** A conifer: a trunk and tiers of drooping boughs, shaded on the right. */
function conifer(p: Pen, x: number, base: number, h: number): void {
  const w = h * 0.42;
  const top = base - h;
  const tiers = 4;
  const left: Pt[] = [[x, top]];
  const right: Pt[] = [[x, top]];
  for (let i = 1; i <= tiers; i++) {
    const y = top + (h * 0.82 * i) / tiers;
    const half = (w / 2) * (0.35 + (0.65 * i) / tiers);
    left.push([x - half, y], [x - half * 0.55, y - h * 0.04]);
    right.push([x + half, y], [x + half * 0.55, y - h * 0.04]);
  }
  left.pop();
  right.pop();
  const outline = [...left.slice().reverse(), ...right.slice(1)];
  p.fill(outline, SKETCH.fill);
  p.hatch([[x, top], ...right.slice(1), [x, top + h * 0.82]], 1.2, 0.85, 0.34, { ragged: 0.05, skip: 0 });
  p.stroke(left, 0.6, { wobble: 0.1 });
  p.stroke(right, 0.6, { wobble: 0.1 });
  p.stroke([[x, top + h * 0.78], [x + p.r(-0.15, 0.15), base]], 0.6, { taper: false, wobble: 0.05 });
}

/** A broadleaf tree: a scalloped crown on a forked trunk. */
function broadleaf(p: Pen, x: number, base: number, h: number): void {
  const r = h * 0.34;
  const cy = base - h + r;
  const bumps = 8;
  const crown: Pt[] = [];
  const ph = p.r(0, 6.28);
  for (let i = 0; i <= bumps * 5; i++) {
    const a = (i / (bumps * 5)) * Math.PI * 2 + ph;
    const bump = Math.abs(Math.sin((a - ph) * (bumps / 2)));
    const rr = r * (0.86 + 0.16 * bump);
    crown.push([x + Math.cos(a) * rr * 1.05, cy + Math.sin(a) * rr * 0.92]);
  }
  p.stroke([[x, cy + r * 0.5], [x + p.r(-0.2, 0.2), base]], 0.7, { taper: false, wobble: 0.06 });
  p.fill(crown, SKETCH.fill);
  // Shade the lower right of the crown.
  const shade: Pt[] = crown.filter(([px, py]) => px - x + (py - cy) * 0.9 > -r * 0.15);
  if (shade.length > 2) p.hatch(shade, 0.95, 1.0, 0.28, { ragged: 0.15, skip: 0.05 });
  p.stroke(crown, 0.6, { wobble: 0.08, taper: false });
  p.stroke([[x, cy + r * 0.5], [x - r * 0.35, cy + r * 0.1]], 0.4);
}

/** A palm: a slender curving trunk with ring marks and arching, drooping fronds. */
function palm(p: Pen, x: number, base: number, h: number, lean: number): void {
  const top: Pt = [x + lean, base - h];
  const trunk = quad([x, base], [x + lean * 0.15, base - h * 0.55], top, 8);
  p.stroke(trunk, 0.6, { taper: false, wobble: 0.05 });
  for (let i = 2; i < trunk.length - 1; i += 2) {
    const [tx, ty] = trunk[i];
    p.stroke([[tx - 0.45, ty + 0.15], [tx + 0.45, ty - 0.05]], 0.25, { wobble: 0 });
  }
  const len = h * 0.5;
  // [reach, droop of the tip, rise of the arch], as fractions of the frond length.
  const fronds: [number, number, number][] = [
    [-1, 0.62, 0.22], [-0.8, 0.2, 0.42], [-0.32, -0.32, 0.4], [0.3, -0.3, 0.42], [0.82, 0.18, 0.4], [1, 0.66, 0.2],
  ];
  for (const [reach, droop, rise] of fronds) {
    const r = reach * p.r(0.9, 1.1);
    const tip: Pt = [top[0] + r * len, top[1] + droop * len];
    const ctrl: Pt = [top[0] + r * len * 0.45, top[1] - rise * len];
    const frond = quad(top, ctrl, tip, 10);
    p.stroke(frond, 0.45, { wobble: 0.04 });
    // Leaflets hanging from the outer part of the frond, swept towards its tip.
    for (let k = 3; k < frond.length - 1; k += 1) {
      const [fx, fy] = frond[k];
      const l = 1.1 * (1 - k / frond.length) + 0.4;
      p.stroke([[fx, fy], [fx + Math.sign(r) * l * 0.4, fy + l]], 0.22, { wobble: 0, taper: false });
    }
  }
}

/** Ground strokes under a stand of trees. */
function ground(p: Pen, x0: number, x1: number, y: number): void {
  p.stroke([[x0, y + 0.2], [(x0 + x1) / 2, y + 0.45], [x1, y + 0.1]], 0.45);
}

type Tree = [x: number, base: number, h: number];

function stand(p: Pen, trees: Tree[], draw: (p: Pen, x: number, base: number, h: number) => void): void {
  // Back rows first so nearer trees overlap them.
  for (const [x, base, h] of trees.slice().sort((a, b) => a[1] - b[1])) draw(p, x, base, h);
}

const CONIFERS: Omit<GlyphSpec, 'kind' | 'variant'>[] = [
  { w: 18, h: 16, ax: 9, ay: 14.5, wash: SKETCH.forestWash, draw: (p) => { stand(p, [[5.5, 12.8, 10.5], [10.5, 13.6, 12.4], [14, 14.6, 8.6]], conifer); ground(p, 2, 16, 14.8); } },
  { w: 22, h: 17, ax: 11, ay: 15.5, wash: SKETCH.forestWash, draw: (p) => { stand(p, [[4, 14.4, 9], [8.4, 12.4, 11.4], [13, 13, 12.2], [17.6, 15.2, 9.6], [10.6, 15.6, 8.2]], conifer); ground(p, 1.5, 20.5, 15.8); } },
  { w: 14, h: 16, ax: 7, ay: 14.5, wash: SKETCH.forestWash, draw: (p) => { stand(p, [[5, 13.6, 12.6], [9.6, 14.6, 9.2]], conifer); ground(p, 1.5, 12.5, 14.8); } },
];

const BROADLEAVES: Omit<GlyphSpec, 'kind' | 'variant'>[] = [
  { w: 20, h: 15, ax: 10, ay: 13.5, wash: SKETCH.forestWash, draw: (p) => { stand(p, [[6, 12, 9.4], [13.4, 12.6, 10.4], [9.6, 14, 8]], broadleaf); ground(p, 2, 18, 14.2); } },
  { w: 24, h: 15, ax: 12, ay: 13.5, wash: SKETCH.forestWash, draw: (p) => { stand(p, [[5, 12.6, 8.6], [10.6, 11.6, 10.4], [16.8, 12.4, 9.2], [8, 14.4, 7.8], [14.2, 14.6, 8.4]], broadleaf); ground(p, 1.5, 22.5, 14.6); } },
  { w: 14, h: 14, ax: 7, ay: 12.8, wash: SKETCH.forestWash, draw: (p) => { stand(p, [[5, 12, 10.6], [9.8, 13, 8]], broadleaf); ground(p, 1.5, 12.5, 13.2); } },
];

const PALMS: Omit<GlyphSpec, 'kind' | 'variant'>[] = [
  { w: 24, h: 17, ax: 12, ay: 15.5, wash: SKETCH.forestWash, draw: (p) => { palm(p, 8.6, 15.2, 12.4, -1.6); palm(p, 15, 15.6, 10.2, 2.2); ground(p, 4.6, 20.6, 15.8); } },
  { w: 26, h: 17, ax: 13, ay: 15.5, wash: SKETCH.forestWash, draw: (p) => { palm(p, 6, 15, 10.6, -2.2); palm(p, 12.4, 15.4, 13, 0.8); palm(p, 18.6, 15.8, 9.6, 2.6); ground(p, 2, 23, 16); } },
];

// ------------------------------------------------------------------ ripples ---

function tilde(p: Pen, x: number, y: number, w: number, amp: number, width = 0.6): void {
  const pts: Pt[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    pts.push([x + t * w, y - Math.sin(t * Math.PI * 2) * amp]);
  }
  p.stroke(pts, width, { wobble: 0.08 });
}

const RIPPLES: Omit<GlyphSpec, 'kind' | 'variant'>[] = [
  { w: 10, h: 5, ax: 5, ay: 2.5, draw: (p) => tilde(p, 1, 2.5, 8, 1.1) },
  { w: 13, h: 7, ax: 6.5, ay: 3.5, draw: (p) => { tilde(p, 1, 2.4, 7.4, 0.95); tilde(p, 4.4, 5, 7.2, 0.9, 0.5); } },
  { w: 15, h: 9, ax: 7.5, ay: 4.5, draw: (p) => { tilde(p, 4.6, 2.2, 6.4, 0.8, 0.5); tilde(p, 1, 4.8, 7.2, 0.95); tilde(p, 7, 7, 6.4, 0.8, 0.45); } },
];

// -------------------------------------------------------------------- ships ---

/** A billowing square sail between two yards, bellying towards `dir`. */
function squareSail(p: Pen, x: number, yTop: number, yBot: number, halfTop: number, halfBot: number, dir: 1 | -1): void {
  const belly = (yBot - yTop) * 0.32 * dir;
  const tl: Pt = [x - halfTop, yTop];
  const tr: Pt = [x + halfTop, yTop];
  const bl: Pt = [x - halfBot, yBot];
  const br: Pt = [x + halfBot, yBot];
  const leftEdge = quad(tl, [x - halfTop + belly * 0.6, (yTop + yBot) / 2], bl, 6);
  const rightEdge = quad(br, [x + halfBot + belly * 0.6, (yTop + yBot) / 2], tr, 6);
  const foot = quad(bl, [x + belly * 0.35, yBot + (yBot - yTop) * 0.18], br, 6);
  const shape = [...leftEdge, ...foot.slice(1), ...rightEdge.slice(1)];
  p.fill(shape, SKETCH.canvas);
  // Shade the hollow of the sail, on the side away from the belly.
  const shadeX = dir > 0 ? x - halfBot * 0.2 : x + halfBot * 0.2;
  const shade = shape.filter(([px]) => (dir > 0 ? px < shadeX : px > shadeX));
  if (shade.length > 2) p.hatch(shade, 1.45, 0.75, 0.26, { ragged: 0.1, skip: 0.1 });
  p.stroke(shape, 0.5, { wobble: 0.06, taper: false });
  // The yard.
  p.stroke([[tl[0] - 0.6, yTop], [tr[0] + 0.6, yTop]], 0.55, { wobble: 0.04 });
}

/** A hull in profile, bow to the right, with its side hatched and a wale along it. */
function hull(p: Pen, x0: number, x1: number, deck: number, depth: number, flip?: number): void {
  const len = x1 - x0;
  const wale: Pt[] = [[x0 + len * 0.04, deck + depth * 0.15], [x0 + len * 0.55, deck + depth * 0.32], [x1 - len * 0.06, deck + depth * 0.05]];
  const shape = hullShape(x0, x1, deck, depth);
  inkHull(p, flip ? mirror(shape, flip) : shape, flip ? mirror(wale, flip) : wale);
}

function waterline(p: Pen, x0: number, x1: number, y: number): void {
  tilde(p, x0 - 2.5, y + 0.6, (x1 - x0) * 0.4, 0.45, 0.4);
  tilde(p, x0 + (x1 - x0) * 0.5, y + 1.1, (x1 - x0) * 0.45, 0.45, 0.4);
  tilde(p, x1 - 1, y + 0.2, 4, 0.35, 0.35);
}

function pennant(p: Pen, x: number, y: number, dir: 1 | -1): void {
  p.stroke([[x, y], [x + dir * 1.4, y - 0.3], [x + dir * 2.6, y + 0.2], [x + dir * 3.6, y - 0.2]], 0.45, { smooth: true });
}

/** A three-masted ship heading right, under full sail. */
function fullRigged(p: Pen): void {
  const deck = 19;
  waterline(p, 4, 27, 22.4);
  const masts = [{ x: 9, top: 5.4 }, { x: 15.6, top: 2.6 }, { x: 21.4, top: 4.8 }];
  for (const m of masts) p.stroke([[m.x, deck], [m.x, m.top]], 0.55, { taper: false, wobble: 0.04 });
  // Bowsprit and jib.
  p.stroke([[25.6, deck - 1.4], [31, deck - 4.2]], 0.5, { taper: false, wobble: 0.04 });
  const jib: Pt[] = [[21.6, 6], [30.4, deck - 4], [22, deck - 3.4]];
  p.fill(jib, SKETCH.canvas);
  p.stroke([...jib, jib[0]], 0.45, { taper: false, wobble: 0.05 });
  for (const m of masts) {
    const s = m.x === 15.6 ? 1.15 : 1;
    squareSail(p, m.x, m.top + 2.2, m.top + 6.4, 2.4 * s, 3 * s, 1);
    squareSail(p, m.x, m.top + 6.9, deck - 2.6, 3.2 * s, 3.8 * s, 1);
  }
  // Spanker aft.
  const spanker: Pt[] = [[8.6, 10.4], [4.6, 13.6], [4.4, deck - 2.4], [8.6, deck - 2.4]];
  p.fill(spanker, SKETCH.canvas);
  p.stroke([...spanker], 0.45, { taper: false, wobble: 0.05 });
  hull(p, 3.4, 26, deck, 3.2);
  pennant(p, 15.6, 2.6, -1);
}

/** A two-masted brig heading left. */
function brig(p: Pen): void {
  const W = 26;
  const deck = 17.4;
  waterline(p, 3, 23, 20.6);
  const masts = [{ x: W - 10.4, top: 3 }, { x: W - 17, top: 4.4 }];
  for (const m of masts) p.stroke([[m.x, deck], [m.x, m.top]], 0.55, { taper: false, wobble: 0.04 });
  p.stroke([[3.4, deck - 1.2], [-0.4, deck - 3.8]], 0.5, { taper: false, wobble: 0.04 });
  const jib: Pt[] = [[W - 17.2, 5.6], [0.4, deck - 3.6], [W - 17, deck - 3]];
  p.fill(jib, SKETCH.canvas);
  p.stroke([...jib, jib[0]], 0.45, { taper: false, wobble: 0.05 });
  for (const m of masts) {
    squareSail(p, m.x, m.top + 2, m.top + 6, 2.3, 2.9, -1);
    squareSail(p, m.x, m.top + 6.5, deck - 2.4, 3.1, 3.7, -1);
  }
  hull(p, 1.6, 22, deck, 3, W);
  pennant(p, masts[0].x, masts[0].top, 1);
}

/** A small single-masted gaff cutter heading right. */
function cutter(p: Pen): void {
  const deck = 15.6;
  waterline(p, 4, 17, 18.4);
  p.stroke([[9.4, deck], [9.4, 2]], 0.55, { taper: false, wobble: 0.04 });
  p.stroke([[16.6, deck - 0.8], [21, deck - 2.6]], 0.45, { taper: false, wobble: 0.04 });
  // Gaff mainsail, bellying a little.
  const main: Pt[] = [[9.2, 3.2], [3.4, 6.2], [3.2, deck - 1.6], [9.2, deck - 1.4]];
  const mainCurved = [...quad(main[0], [6.2, 4.2], main[1], 5), ...quad(main[1], [2.4, 9.6], main[2], 5).slice(1), ...quad(main[2], [6.4, deck - 0.6], main[3], 5).slice(1)];
  p.fill(mainCurved, SKETCH.canvas);
  p.hatch(mainCurved.filter(([x]) => x < 6.4), 1.45, 0.75, 0.26, { ragged: 0.1 });
  p.stroke([...mainCurved, main[0]], 0.5, { taper: false, wobble: 0.05 });
  const jib: Pt[] = [[9.6, 3.4], [20.4, deck - 2.4], [10, deck - 2]];
  p.fill(jib, SKETCH.canvas);
  p.stroke([...jib, jib[0]], 0.45, { taper: false, wobble: 0.05 });
  hull(p, 2.6, 17.4, deck, 2.5);
  pennant(p, 9.4, 2, -1);
}

function hullShape(x0: number, x1: number, deck: number, depth: number): Pt[] {
  const len = x1 - x0;
  const sheer: Pt[] = [[x0, deck - depth * 0.45], [x0 + len * 0.18, deck - depth * 0.05], [x0 + len * 0.6, deck + depth * 0.05], [x1, deck - depth * 0.35]];
  const keel: Pt[] = [[x1, deck - depth * 0.35], [x1 - len * 0.12, deck + depth * 0.7], [x0 + len * 0.45, deck + depth], [x0 + len * 0.06, deck + depth * 0.8], [x0, deck - depth * 0.45]];
  return [...catmull(sheer, 4), ...catmull(keel, 4).slice(1)];
}

function inkHull(p: Pen, shape: Pt[], wale: Pt[]): void {
  p.fill(shape, SKETCH.fill);
  p.hatch(shape, 0.06, 0.7, 0.32, { ragged: 0.04, skip: 0 });
  p.stroke(shape, 0.7, { wobble: 0.06, taper: false });
  p.stroke(catmull(wale, 4), 0.4, { wobble: 0.03 });
}

const SHIPS: Omit<GlyphSpec, 'kind' | 'variant'>[] = [
  { w: 32, h: 25, ax: 15, ay: 22.4, draw: fullRigged },
  { w: 26, h: 23, ax: 13, ay: 20.6, draw: brig },
  { w: 22, h: 20, ax: 10.5, ay: 18.4, draw: cutter },
];

// ----------------------------------------------------------- sea creatures ---

/** A sea serpent: a head rearing on the left and coils breaking the water. */
function serpent(p: Pen): void {
  const sea = 15;
  // Coils: arches of a thick body, drawn as two strokes with hatching beneath.
  const coils = [
    { x: 15, w: 6.4, h: 5.6 },
    { x: 23.4, w: 5.6, h: 4.6 },
    { x: 30.6, w: 4.4, h: 3.4 },
  ];
  for (const c of coils) {
    const outer = arc(c.x, sea, c.w / 2, c.h, Math.PI, 2 * Math.PI, 12);
    const inner = arc(c.x, sea, c.w / 2 - 1.4, c.h - 1.4, 2 * Math.PI, Math.PI, 12);
    const body = [...outer, ...inner];
    p.fill(body, SKETCH.fill);
    p.hatch(body.filter(([x]) => x > c.x - 0.5), 1.3, 0.62, 0.28, { ragged: 0.02, skip: 0 });
    p.stroke(outer, 0.6, { smooth: false, wobble: 0.06 });
    p.stroke(inner.slice().reverse(), 0.45, { wobble: 0.05 });
    // Dorsal spines along the top of each coil.
    for (let k = 3; k < outer.length - 3; k += 2) {
      const [sx, sy] = outer[k];
      const a = Math.atan2(sy - sea, sx - c.x);
      p.stroke([[sx, sy], [sx + Math.cos(a) * 0.7 + 0.3, sy + Math.sin(a) * 0.7]], 0.3, { wobble: 0 });
    }
  }
  // The neck rising from the water and the head facing left.
  const neckOuter: Pt[] = [[9.6, sea], [9.4, 10], [8, 6.2], [5.6, 4.2]];
  const neckInner: Pt[] = [[2.6, 6.6], [5.4, 7.6], [7, 10.6], [7.2, sea]];
  const neck = [...catmull(neckOuter, 4), ...catmull(neckInner, 4)];
  p.fill(neck, SKETCH.fill);
  p.hatch(neck.filter(([x, y]) => x > 6.4 || y < 6), 1.2, 0.62, 0.28, { ragged: 0.02, skip: 0 });
  p.stroke(catmull(neckOuter, 4), 0.6, { wobble: 0.05 });
  p.stroke(catmull(neckInner, 4), 0.55, { wobble: 0.05 });
  // Head: an open jaw and a frill.
  const head: Pt[] = [[5.6, 4.2], [3.4, 3.4], [0.6, 3.8], [0.2, 4.6], [2.2, 5], [0.4, 5.8], [1.2, 6.6], [2.6, 6.6]];
  p.fill(head, SKETCH.fill);
  p.stroke(head, 0.55, { wobble: 0.04, taper: false });
  p.dot(3.4, 4.1, 0.38);
  p.stroke([[5.4, 4], [6.2, 2.2], [7.4, 3.2], [8, 1.8], [8.6, 4.6]], 0.4, { wobble: 0.04 });
  // Water at the coils and a little splash.
  tilde(p, 1, sea + 1.2, 6, 0.5, 0.4);
  tilde(p, 10.4, sea + 1.6, 9, 0.5, 0.4);
  tilde(p, 21, sea + 1.2, 8, 0.45, 0.4);
  tilde(p, 29, sea + 1.6, 5, 0.4, 0.35);
}

/** A whale's back breaking the surface, flukes raised, spouting. */
function whale(p: Pen): void {
  const sea = 13.6;
  const back: Pt[] = [[4, sea], [6.4, 9.4], [11.6, 7.6], [17.6, 8.6], [21.4, 11.2], [23.6, sea]];
  const body = [...catmull(back, 5), [4, sea] as Pt];
  p.fill(body, SKETCH.fill);
  p.hatch(body, 0.25, 0.62, 0.3, { ragged: 0.03, skip: 0 });
  p.stroke(catmull(back, 5), 0.75, { wobble: 0.06 });
  p.dot(8.2, 11, 0.4);
  // Flukes.
  const fluke: Pt[] = [[25.4, sea], [26.4, 10.6], [25.6, 7.6], [27.6, 9.6], [29, 8.6], [31.6, 6.8], [30, 10], [27.8, 11.4], [27.4, sea]];
  p.fill(fluke, SKETCH.fill);
  p.hatch(fluke, 1.2, 0.62, 0.28, { ragged: 0.03, skip: 0 });
  p.stroke(fluke, 0.6, { wobble: 0.04, taper: false });
  // Spout: a fountain of curving strokes from the blowhole.
  const hole: Pt = [8.8, 8.6];
  for (const [dx, h] of [[-3.2, 5.2], [-1.4, 6.6], [0.6, 6.8], [2.6, 5.4]] as const) {
    p.stroke(quad(hole, [hole[0] + dx * 0.2, hole[1] - h], [hole[0] + dx, hole[1] - h * 0.55], 8), 0.4, { wobble: 0.03 });
  }
  for (let i = 0; i < 6; i++) p.dot(hole[0] + p.r(-3.6, 3.4), hole[1] - p.r(3, 6), p.r(0.2, 0.32));
  tilde(p, 1, sea + 0.8, 7, 0.45, 0.4);
  tilde(p, 9.6, sea + 1.3, 10, 0.5, 0.4);
  tilde(p, 22, sea + 0.9, 9, 0.45, 0.4);
}

const SERPENTS: Omit<GlyphSpec, 'kind' | 'variant'>[] = [{ w: 36, h: 18, ax: 18, ay: 15, draw: serpent }];
const WHALES: Omit<GlyphSpec, 'kind' | 'variant'>[] = [{ w: 33, h: 16, ax: 16, ay: 13.6, draw: whale }];

// ---------------------------------------------------------------- catalogue ---

function family(kind: GlyphKind, specs: Omit<GlyphSpec, 'kind' | 'variant'>[]): GlyphSpec[] {
  return specs.map((s, variant) => ({ ...s, kind, variant }));
}

/** Every glyph, grouped by kind in a fixed order. */
export const GLYPHS: readonly GlyphSpec[] = [
  ...family('mountain', MOUNTAINS),
  ...family('desert', DESERTS),
  ...family('conifer', CONIFERS),
  ...family('broadleaf', BROADLEAVES),
  ...family('palm', PALMS),
  ...family('ripple', RIPPLES),
  ...family('ship', SHIPS),
  ...family('serpent', SERPENTS),
  ...family('whale', WHALES),
];

export const glyphId = (g: Pick<GlyphSpec, 'kind' | 'variant'>): string => `${g.kind}-${g.variant}`;

/** A stable seed per glyph, so its wobble is the same on every load. */
function seedOf(g: GlyphSpec): number {
  let h = 2166136261;
  for (const ch of glyphId(g)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Draws a glyph with its top-left corner at the current origin of `ctx`,
 * at `scale` device pixels per nominal pixel.
 */
export function drawGlyph(ctx: CanvasRenderingContext2D, g: GlyphSpec, scale: number, opts: { wash?: boolean } = {}): void {
  ctx.save();
  ctx.scale(scale, scale);
  const pen = new Pen(ctx, seedOf(g));
  if (opts.wash && g.wash) {
    const washPen = new Pen(ctx, seedOf(g) ^ 0x5eed);
    washPen.wash(g.w / 2, g.h * 0.6, g.w * 0.5, g.h * 0.42, g.wash);
  }
  g.draw(pen);
  ctx.restore();
}

export interface AtlasCell {
  /** Source rectangle in the atlas, device px. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  /** Device px per nominal px. */
  scale: number;
  /** Cells by glyph id, plus `<id>+wash` for washed versions. */
  cells: Map<string, AtlasCell>;
}

/** Padding round each cell, nominal px, so wobbling strokes are never clipped. */
const PAD = 1.5;

/**
 * Bakes every glyph (and a washed copy of those that take one) into one
 * canvas, packed in shelves. Drawing a glyph on the globe is then a single
 * drawImage from this sheet.
 */
export function buildGlyphAtlas(scale: number, doc: Document = document): GlyphAtlas {
  const entries: { id: string; g: GlyphSpec; wash: boolean }[] = [];
  for (const g of GLYPHS) {
    entries.push({ id: glyphId(g), g, wash: false });
    if (g.wash) entries.push({ id: `${glyphId(g)}+wash`, g, wash: true });
  }
  const maxW = 160; // shelf width, nominal px
  const cells = new Map<string, AtlasCell>();
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 0;
  const placed: { e: (typeof entries)[number]; x: number; y: number }[] = [];
  for (const e of entries) {
    const w = e.g.w + PAD * 2;
    const h = e.g.h + PAD * 2;
    if (x + w > maxW) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    placed.push({ e, x, y });
    x += w;
    shelf = Math.max(shelf, h);
    width = Math.max(width, x);
  }
  const height = y + shelf;
  const canvas = doc.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  for (const { e, x: px, y: py } of placed) {
    ctx.save();
    ctx.translate(Math.round((px + PAD) * scale), Math.round((py + PAD) * scale));
    drawGlyph(ctx, e.g, scale, { wash: e.wash });
    ctx.restore();
    cells.set(e.id, {
      sx: Math.round(px * scale),
      sy: Math.round(py * scale),
      sw: Math.round((e.g.w + PAD * 2) * scale),
      sh: Math.round((e.g.h + PAD * 2) * scale),
    });
  }
  return { canvas, scale, cells };
}

/** Atlas cell padding in nominal px (the anchor inside a cell is at ax + ATLAS_PAD, ay + ATLAS_PAD). */
export const ATLAS_PAD = PAD;
