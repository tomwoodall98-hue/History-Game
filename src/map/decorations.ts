/**
 * Map decorations: where the hand-sketched glyphs (glyphs.ts) sit on the
 * globe. Placement is worked out at build time by
 * scripts/build-decorations.ts and committed as src/data/decorations.json;
 * this module holds the rules both sides share and decodes the file.
 *
 * Level of detail: every glyph belongs to a level. Level 0 is the sparsest
 * set, and each further level adds glyphs in the gaps at half the spacing.
 * Any two glyphs visible together are at least
 *
 *     LEVEL_DEG[max level of the two] × (SPACING[a] + SPACING[b]) / 2
 *
 * degrees apart, so drawing a level only once that spacing is wide enough on
 * screen keeps glyphs from overlapping at any zoom.
 */
import type { GlyphKind } from './glyphs';

/** Glyph kinds in the order the data file numbers them. */
export const DECORATION_KINDS: readonly GlyphKind[] = ['mountain', 'desert', 'conifer', 'broadleaf', 'palm', 'ripple', 'ship', 'serpent', 'whale'];

/** Kinds drawn on land; every other kind is drawn at sea. */
export const LAND_KINDS: ReadonlySet<GlyphKind> = new Set<GlyphKind>(['mountain', 'desert', 'conifer', 'broadleaf', 'palm']);

/** Spacing of each level, in degrees of arc: 8° is about 890 km. */
export const LEVEL_DEG: readonly number[] = [8, 4, 2, 1];

/** How much room each kind keeps around itself, as a multiple of its level's spacing. */
export const SPACING: Readonly<Record<GlyphKind, number>> = {
  mountain: 1,
  desert: 1,
  conifer: 0.85,
  broadleaf: 0.85,
  palm: 0.85,
  ripple: 1.8,
  ship: 4,
  serpent: 3,
  whale: 3,
};

/** Ships keep at least this far from any coast, km. */
export const SHIP_COAST_KM = 200;

/** The minimum distance (degrees) two glyphs keep apart. */
export function minSeparationDeg(a: GlyphKind, levelA: number, b: GlyphKind, levelB: number): number {
  return LEVEL_DEG[Math.max(levelA, levelB)] * ((SPACING[a] + SPACING[b]) / 2);
}

export interface Decoration {
  lat: number;
  lng: number;
  kind: GlyphKind;
  variant: number;
  level: number;
  /** Size relative to the glyph's natural size. */
  scale: number;
}

/**
 * The committed file: parallel columns, sorted by level, so the glyphs shown
 * at a level of detail are always a prefix of the list.
 */
export interface DecorationFile {
  about: string;
  kinds: string[];
  levelDeg: number[];
  /** Latitude and longitude in hundredths of a degree. */
  lat: number[];
  lng: number[];
  /** kind index × 10 + variant. */
  glyph: number[];
  level: number[];
  /** Scale in hundredths. */
  scale: number[];
}

export function encodeDecorations(list: Decoration[], about: string): DecorationFile {
  const sorted = list.slice().sort((a, b) => a.level - b.level || b.lat - a.lat || a.lng - b.lng);
  return {
    about,
    kinds: [...DECORATION_KINDS],
    levelDeg: [...LEVEL_DEG],
    lat: sorted.map((d) => Math.round(d.lat * 100)),
    lng: sorted.map((d) => Math.round(d.lng * 100)),
    glyph: sorted.map((d) => DECORATION_KINDS.indexOf(d.kind) * 10 + d.variant),
    level: sorted.map((d) => d.level),
    scale: sorted.map((d) => Math.round(d.scale * 100)),
  };
}

export function decodeDecorations(file: DecorationFile): Decoration[] {
  const kinds = file.kinds as GlyphKind[];
  return file.lat.map((lat, i) => ({
    lat: lat / 100,
    lng: file.lng[i] / 100,
    kind: kinds[Math.floor(file.glyph[i] / 10)],
    variant: file.glyph[i] % 10,
    level: file.level[i],
    scale: file.scale[i] / 100,
  }));
}
