/**
 * Draws the map decorations (glyphs.ts, placed by decorations.ts) on the
 * globe's canvas.
 *
 *   - Every glyph is baked once into a sprite atlas; each one on the globe is
 *     then a single drawImage.
 *   - A glyph is drawn through the projection's local east and north axes at
 *     its point, so it is printed ON the sphere: its top points north and it
 *     is foreshortened towards the rim like the land around it.
 *   - Level of detail: a level is drawn only once its spacing on screen is
 *     wide enough for its glyphs (so they never overlap), fading in as it
 *     opens up. While the globe moves, fading levels are left out.
 *   - Glyphs on the far side are culled, and fade out just before the rim.
 */
import { ATLAS_PAD, GLYPHS, buildGlyphAtlas, glyphId, type AtlasCell, type GlyphAtlas, type GlyphSpec } from './glyphs';
import { LEVEL_DEG, type Decoration } from './decorations';
import type { FastView } from './fastOrtho';

/** A level of detail is drawn once glyphs one spacing apart are at least this many px apart (at natural size). */
export const DECOR_SPACING_PX = 24;
/**
 * Glyphs are drawn at their natural size on a globe of this radius (px),
 * smaller on a whole globe (about ¾ size on a desktop, so the second level of
 * detail fits in full) and a little larger when zoomed in.
 */
const NATURAL_RADIUS = 420;
const SIZE_EXPONENT = 0.6;
const MIN_SIZE = 0.6;
const MAX_SIZE = 1.15;
/** A level fades in as its spacing grows from 1× to this many times what it needs. */
const FADE_SPAN = 1.3;
/** Depth below which a glyph is not drawn, and above which it is fully inked. */
const DEPTH_CULL = 0.06;
const DEPTH_FULL = 0.25;
/** Overall strength of the decoration ink, so it sits beneath the coastlines. */
const INK_ALPHA = 0.92;

const RAD = Math.PI / 180;
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface Lod {
  /** Size of the glyphs relative to their natural size. */
  size: number;
  /** Opacity of each level of detail (0 for levels not drawn). */
  alpha: number[];
}

/**
 * Which levels of detail to draw on a globe of radius `R` px, and how large.
 * Any level drawn has its spacing on screen at least DECOR_SPACING_PX × size.
 */
export function levelOfDetail(R: number): Lod {
  const spacing = (level: number) => LEVEL_DEG[level] * RAD * R;
  let size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.pow(R / NATURAL_RADIUS, SIZE_EXPONENT)));
  // On a very small globe even the sparsest level is tight: shrink the glyphs to fit.
  size = Math.min(size, spacing(0) / DECOR_SPACING_PX);
  const alpha = LEVEL_DEG.map((_, level) => {
    if (level === 0) return 1;
    const ratio = spacing(level) / (DECOR_SPACING_PX * size);
    return smooth((ratio - 1) / (FADE_SPAN - 1));
  });
  return { size, alpha };
}

interface Item {
  glyph: GlyphSpec;
  id: string;
  level: number;
  scale: number;
  /** The point, its local east and its local north, as unit vectors. */
  p: [number, number, number];
  e: [number, number, number];
  n: [number, number, number];
}

export class DecorLayer {
  private readonly items: Item[];
  private atlas: GlyphAtlas | null = null;

  constructor(list: Decoration[]) {
    const byId = new Map(GLYPHS.map((g) => [glyphId(g), g]));
    this.items = list.flatMap((d) => {
      const glyph = byId.get(glyphId(d));
      if (!glyph) return [];
      // Keep clear of the poles, where east is undefined.
      const lat = Math.max(-89.5, Math.min(89.5, d.lat)) * RAD;
      const lng = d.lng * RAD;
      const cl = Math.cos(lng);
      const sl = Math.sin(lng);
      const cp = Math.cos(lat);
      const sp = Math.sin(lat);
      return [
        {
          glyph,
          id: glyphId(d),
          level: d.level,
          scale: d.scale,
          p: [cp * cl, cp * sl, sp],
          e: [-sl, cl, 0],
          n: [-sp * cl, -sp * sl, cp],
        },
      ];
    });
    // Coarse levels first, so each level of detail is a prefix.
    this.items.sort((a, b) => a.level - b.level);
  }

  /** The atlas, baked on first use at the resolution the canvas needs. */
  private atlasFor(dpr: number): GlyphAtlas {
    const scale = Math.min(4, Math.ceil(dpr * MAX_SIZE * 1.1 * 4) / 4);
    if (!this.atlas || this.atlas.scale !== scale) this.atlas = buildGlyphAtlas(scale);
    return this.atlas;
  }

  /**
   * Draws the decorations in view. The context's transform is device pixels
   * scaled by `dpr`; it is restored afterwards.
   */
  draw(ctx: CanvasRenderingContext2D, v: FastView, dpr: number, width: number, height: number, moving: boolean): void {
    const lod = levelOfDetail(v.R);
    const atlas = this.atlasFor(dpr);
    const k = lod.size / v.R;
    const margin = 48 * lod.size;
    const { cl, sl, cp, sp, R, cx, cy } = v;
    ctx.save();
    for (const it of this.items) {
      const levelAlpha = lod.alpha[it.level];
      if (levelAlpha <= 0) break; // sorted by level: nothing further is drawn either
      if (moving && levelAlpha < 1) break;
      // Rotate into view (as fastOrtho.projectInto) and test the depth first.
      const [px, py, pz] = it.p;
      const x = px * cl - py * sl;
      const y = px * sl + py * cl;
      const depth = x * cp - pz * sp;
      if (depth <= DEPTH_CULL) continue;
      const X = cx + R * y;
      const Y = cy - R * (pz * cp + x * sp);
      if (X < -margin || X > width + margin || Y < -margin || Y > height + margin) continue;
      // Screen vectors of one unit east and one unit south at this point.
      const [ex, ey, ez] = it.e;
      const [nx, ny, nz] = it.n;
      const exr = ex * cl - ey * sl;
      const eyr = ex * sl + ey * cl;
      const nxr = nx * cl - ny * sl;
      const nyr = nx * sl + ny * cl;
      const s = k * it.scale * dpr;
      const a = R * eyr * s;
      const b = -R * (ez * cp + exr * sp) * s;
      const c = -R * nyr * s;
      const d = R * (nz * cp + nxr * sp) * s;
      const cell = atlas.cells.get(it.id) as AtlasCell;
      const g = it.glyph;
      ctx.globalAlpha = INK_ALPHA * (moving ? 1 : levelAlpha * smooth((depth - DEPTH_CULL) / (DEPTH_FULL - DEPTH_CULL)));
      ctx.setTransform(a, b, c, d, X * dpr, Y * dpr);
      ctx.drawImage(atlas.canvas, cell.sx, cell.sy, cell.sw, cell.sh, -(g.ax + ATLAS_PAD), -(g.ay + ATLAS_PAD), cell.sw / atlas.scale, cell.sh / atlas.scale);
    }
    ctx.restore();
  }
}
