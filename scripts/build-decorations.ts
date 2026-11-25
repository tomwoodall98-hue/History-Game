/**
 * Places the hand-sketched map decorations: works out where every mountain,
 * desert, forest, sea ripple, ship and sea monster glyph sits on the globe.
 *
 *   npm run build:decorations
 *
 * Output (committed, so `npm run build` never needs the network):
 *
 *   src/data/decorations.json   lat, lng, glyph (kind and variant), level of
 *                               detail and scale of every glyph; format in
 *                               src/map/decorations.ts
 *
 * Inputs:
 *   - src/data/globe.topo.json: the globe's own land and lakes, so glyphs
 *     agree with the map as drawn.
 *   - Natural Earth 1:50m geography region polygons (v5.1.2, downloaded once
 *     into .cache/natural-earth/): the "Range/mtn" class for mountains and
 *     the "Desert" class for deserts (less two mislabelled regions).
 *   - data/decorations/forests.json: rough hand-drawn outlines of the major
 *     present-day forests (Natural Earth has none).
 *   - data/decorations/sea-routes.json: hand-drawn sailing routes for ships.
 *
 * Method: deterministic multi-level Poisson-disc sampling on the sphere.
 * Level 0 throws darts at a jittered equal-area grid in a seeded random
 * order and keeps each one that lands in the right medium and region and
 * is far enough from every glyph already kept (minSeparationDeg). Each
 * further level brings the spacing √2 closer and fills the gaps. A glyph also keeps
 * its own footprint clear of the coast at the zoom where its level first
 * appears, so coarse levels stay well inland or well offshore. Ships are
 * placed first along the routes, at least 200 km from any coast; the two
 * sea monsters are fixed in the remotest ocean.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon, Position } from 'geojson';
import { geoDistance, geoInterpolate } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import { mulberry32 } from '../src/game/schedule.ts';
import { GLYPHS, type GlyphKind } from '../src/map/glyphs.ts';
import { LEVEL_DEG, SHIP_COAST_KM, SPACING, encodeDecorations, minSeparationDeg, type Decoration } from '../src/map/decorations.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, '.cache/natural-earth');
const OUT = resolve(ROOT, 'src/data/decorations.json');
const REGIONS = 'ne_50m_geography_regions_polys';
const NE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/${REGIONS}.geojson`;

const R_KM = 6371;
const KM_PER_DEG = (Math.PI / 180) * R_KM;
const SEED = 1884; // the year the Greenwich meridian was agreed

/** Natural Earth "Desert" regions that are not deserts. */
const NOT_DESERTS = new Set(['PUNJAB', 'CAATINGAS']);

/** Half the drawn size of each kind, relative to a 24 px mountain: how far its ink reaches from its anchor. */
const FOOTPRINT: Record<GlyphKind, number> = {
  mountain: 1,
  desert: 1,
  conifer: 0.8,
  broadleaf: 0.8,
  palm: 0.8,
  ripple: 0.5,
  ship: 1.3,
  serpent: 1.4,
  whale: 1.3,
};
/** Distance from the coast (or a lake shore) each kind always keeps, km. */
const MIN_COAST_KM: Record<GlyphKind, number> = {
  mountain: 30,
  desert: 30,
  conifer: 30,
  broadleaf: 30,
  palm: 25,
  ripple: 250,
  ship: SHIP_COAST_KM + 15,
  serpent: 900,
  whale: 900,
};
/** Ripples stay out of the ice-bound polar seas. */
const RIPPLE_MAX_LAT = 66;
/**
 * Ripples gather in patches with calm water between, as an engraver would
 * scatter them: they go only where a smooth random field over the sphere
 * (a few waves a few thousand km long) is above this value, about half the sea.
 */
const RIPPLE_FIELD_MIN = 0;
/** Ships sail only at the coarsest levels: they are occasional. */
const SHIP_LEVELS = 3;
/** Fixed easter eggs: a serpent at the oceanic pole of inaccessibility, a whale in the far southern Indian Ocean. */
const MONSTERS: { kind: GlyphKind; lng: number; lat: number; level: number }[] = [
  { kind: 'serpent', lng: -123.4, lat: -48.9, level: 1 },
  { kind: 'whale', lng: 95, lat: -42, level: 1 },
];

type Ring = Position[];

const round2 = (v: number) => Math.round(v * 100) / 100;

// ------------------------------------------------------------- geometry ---

/**
 * Point-in-polygon over many rings by the even-odd rule in plain lng/lat,
 * as the validator and the globe's fill treat land. Edges are bucketed by
 * latitude band so a test only looks at the edges near the point.
 */
class RingIndex {
  private readonly bands = new Map<number, number[]>();
  private readonly edges: number[] = [];
  private static readonly BAND = 0.25;

  constructor(rings: Ring[]) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[i + 1];
        if (y0 === y1) continue;
        const e = this.edges.length / 4;
        this.edges.push(x0, y0, x1, y1);
        const b0 = Math.floor(Math.min(y0, y1) / RingIndex.BAND);
        const b1 = Math.floor(Math.max(y0, y1) / RingIndex.BAND);
        for (let b = b0; b <= b1; b++) {
          const list = this.bands.get(b);
          if (list) list.push(e);
          else this.bands.set(b, [e]);
        }
      }
    }
  }

  contains(lng: number, lat: number): boolean {
    const list = this.bands.get(Math.floor(lat / RingIndex.BAND));
    if (!list) return false;
    let inside = false;
    const E = this.edges;
    for (const e of list) {
      const x0 = E[e * 4];
      const y0 = E[e * 4 + 1];
      const x1 = E[e * 4 + 2];
      const y1 = E[e * 4 + 3];
      if (y0 > lat !== y1 > lat && lng < x0 + ((lat - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside;
    }
    return inside;
  }
}

/** A region polygon with its bounding box, tested on its own (regions may overlap). */
interface Region {
  name: string;
  bbox: [number, number, number, number];
  index: RingIndex;
  glyphs?: Partial<Record<GlyphKind, number>>;
}

function ringsOf(geometry: Polygon | MultiPolygon): Ring[] {
  return geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
}

function region(f: Feature<Polygon | MultiPolygon>, name: string, glyphs?: Region['glyphs']): Region {
  const rings = ringsOf(f.geometry);
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  return { name, bbox: [w, s, e, n], index: new RingIndex(rings), glyphs };
}

const hit = (regions: Region[], lng: number, lat: number) =>
  regions.find((r) => lng >= r.bbox[0] && lng <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3] && r.index.contains(lng, lat));

function unit(lng: number, lat: number): [number, number, number] {
  const l = (lng * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

/**
 * The land's edge (coasts and lake shores) as points every few km, bucketed
 * by 1° cell, for "how far to the nearest shore?" queries.
 */
class ShoreIndex {
  private readonly cells = new Map<number, number[]>();
  count = 0;

  constructor(rings: Ring[], stepKm = 8) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        // Natural Earth cuts land along the antimeridian and the South Pole: not real shores.
        if (Math.abs(a[0]) > 179.99 && Math.abs(b[0]) > 179.99 && Math.sign(a[0]) === Math.sign(b[0])) continue;
        if (a[1] < -89.9 && b[1] < -89.9) continue;
        const km = geoDistance(a as [number, number], b as [number, number]) * R_KM;
        const n = Math.max(1, Math.ceil(km / stepKm));
        const lerp = geoInterpolate(a as [number, number], b as [number, number]);
        for (let k = 0; k < n; k++) this.add(lerp(k / n) as [number, number]);
      }
    }
  }

  private add([lng, lat]: [number, number]): void {
    const key = this.key(Math.floor(lat), Math.floor(lng));
    const [x, y, z] = unit(lng, lat);
    const list = this.cells.get(key);
    if (list) list.push(x, y, z);
    else this.cells.set(key, [x, y, z]);
    this.count++;
  }

  private key(row: number, col: number): number {
    return (row + 90) * 360 + (((col + 180) % 360) + 360) % 360;
  }

  /** Distance to the nearest shore point, km, or Infinity if none is within `limitKm`. */
  distanceKm(lng: number, lat: number, limitKm: number): number {
    const [x, y, z] = unit(lng, lat);
    const dLat = limitKm / KM_PER_DEG + 1;
    const r0 = Math.max(-90, Math.floor(lat - dLat));
    const r1 = Math.min(89, Math.floor(lat + dLat));
    const maxAbs = Math.min(89.9, Math.max(Math.abs(r0), Math.abs(r1 + 1)));
    const dLng = limitKm / (KM_PER_DEG * Math.cos((maxAbs * Math.PI) / 180)) + 1;
    const span = dLng >= 180 ? 180 : Math.ceil(dLng);
    const c0 = Math.floor(lng) - span;
    const c1 = span === 180 ? c0 + 359 : Math.floor(lng) + span;
    let best = -2;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.cells.get(this.key(r, c));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const d = x * list[i] + y * list[i + 1] + z * list[i + 2];
          if (d > best) best = d;
        }
      }
    }
    if (best < -1) return Infinity;
    const km = Math.acos(Math.min(1, best)) * R_KM;
    return km <= limitKm ? km : Infinity;
  }
}

/** A smooth deterministic field on the sphere in about [-1, 1]: a sum of plane waves in random directions. */
function smoothField(seed: number, waves = 7): (lng: number, lat: number) => number {
  const rnd = mulberry32(seed);
  const terms = Array.from({ length: waves }, () => {
    const z = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return { d: [r * Math.cos(a), r * Math.sin(a), z], k: 2 + rnd() * 4, phase: rnd() * Math.PI * 2 };
  });
  return (lng, lat) => {
    const v = unit(lng, lat);
    let sum = 0;
    for (const t of terms) sum += Math.sin(t.k * Math.PI * (v[0] * t.d[0] + v[1] * t.d[1] + v[2] * t.d[2]) + t.phase);
    return sum / Math.sqrt(waves / 2);
  };
}

const rippleField = smoothField(SEED + 1);

/** Accepted glyphs, bucketed in 3D cells on the unit sphere for neighbour queries. */
class Placed {
  readonly all: (Decoration & { v: [number, number, number] })[] = [];
  private cells = new Map<string, number[]>();
  private size = 1;

  /** Re-bucket with cells at least `maxDeg` of arc across. */
  rebucket(maxDeg: number): void {
    this.size = 2 * Math.sin((Math.min(180, maxDeg) * Math.PI) / 360) || 1;
    this.cells = new Map();
    for (let i = 0; i < this.all.length; i++) this.bucket(i);
  }

  private keyOf(v: [number, number, number], dx = 0, dy = 0, dz = 0): string {
    return `${Math.floor(v[0] / this.size) + dx},${Math.floor(v[1] / this.size) + dy},${Math.floor(v[2] / this.size) + dz}`;
  }

  private bucket(i: number): void {
    const k = this.keyOf(this.all[i].v);
    const list = this.cells.get(k);
    if (list) list.push(i);
    else this.cells.set(k, [i]);
  }

  add(d: Decoration): void {
    this.all.push({ ...d, v: unit(d.lng, d.lat) });
    this.bucket(this.all.length - 1);
  }

  /** Is `kind` at `level` far enough from every glyph already placed? */
  fits(lng: number, lat: number, kind: GlyphKind, level: number): boolean {
    const v = unit(lng, lat);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(this.keyOf(v, dx, dy, dz));
          if (!list) continue;
          for (const i of list) {
            const o = this.all[i];
            const need = (minSeparationDeg(kind, level, o.kind, o.level) * Math.PI) / 180;
            const dot = v[0] * o.v[0] + v[1] * o.v[1] + v[2] * o.v[2];
            if (Math.acos(Math.min(1, dot)) < need) return false;
          }
        }
    return true;
  }
}

// ----------------------------------------------------------------- data ---

async function regionsSource(): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  const path = resolve(CACHE, `${REGIONS}.geojson`);
  if (!existsSync(path)) {
    console.log(`Downloading ${NE_URL}`);
    const res = await fetch(NE_URL);
    if (!res.ok) throw new Error(`${NE_URL}: ${res.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, await res.text());
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJson<T>(rel: string): Promise<T> {
  return JSON.parse(await readFile(resolve(ROOT, rel), 'utf8')) as T;
}

/** Shuffle in place with a seeded generator. */
function shuffle<T>(xs: T[], rnd: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** A jittered grid of points roughly `step` degrees apart, of equal area across the sphere. */
function jitteredGrid(step: number, rnd: () => number): [number, number][] {
  const out: [number, number][] = [];
  for (let lat0 = -90; lat0 < 90; lat0 += step) {
    const mid = lat0 + step / 2;
    const cols = Math.max(1, Math.round(360 / (step / Math.max(0.05, Math.cos((mid * Math.PI) / 180)))));
    const w = 360 / cols;
    for (let c = 0; c < cols; c++) {
      const lng = -180 + (c + rnd()) * w;
      // Uniform in area within the row: sample sin(lat) uniformly.
      const s0 = Math.sin((lat0 * Math.PI) / 180);
      const s1 = Math.sin((Math.min(90, lat0 + step) * Math.PI) / 180);
      const lat = (Math.asin(s0 + (s1 - s0) * rnd()) * 180) / Math.PI;
      out.push([round2(lng), round2(lat)]);
    }
  }
  return out;
}

function variantCount(kind: GlyphKind): number {
  return GLYPHS.filter((g) => g.kind === kind).length;
}

function pickWeighted(weights: Partial<Record<GlyphKind, number>>, rnd: () => number): GlyphKind {
  const entries = Object.entries(weights) as [GlyphKind, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

// ----------------------------------------------------------------- main ---

async function main(): Promise<void> {
  const topo = await readJson<Topology>('src/data/globe.topo.json');
  const polys = (name: string): Ring[] =>
    (feature(topo as never, topo.objects[name] as never) as unknown as FeatureCollection<Polygon | MultiPolygon>).features.flatMap((f) => ringsOf(f.geometry));
  const landRings = polys('land');
  const lakeRings = polys('lakes');
  const land = new RingIndex(landRings);
  const lakes = new RingIndex(lakeRings);
  const shores = new ShoreIndex([...landRings, ...lakeRings]);
  console.log(`Shore points: ${shores.count.toLocaleString()}`);

  const ne = await regionsSource();
  const mountains = ne.features.filter((f) => f.properties?.FEATURECLA === 'Range/mtn').map((f) => region(f, String(f.properties?.NAME)));
  const deserts = ne.features
    .filter((f) => f.properties?.FEATURECLA === 'Desert' && !NOT_DESERTS.has(String(f.properties?.NAME)))
    .map((f) => region(f, String(f.properties?.NAME)));
  const forestsFc = await readJson<FeatureCollection<Polygon, { name: string; glyphs: Partial<Record<GlyphKind, number>> }>>('data/decorations/forests.json');
  const forests = forestsFc.features.map((f) => region(f, f.properties.name, f.properties.glyphs));
  const routes = await readJson<FeatureCollection<LineString, { name: string }>>('data/decorations/sea-routes.json');
  console.log(`Regions: ${mountains.length} mountain ranges, ${deserts.length} deserts, ${forests.length} forests; ${routes.features.length} sea routes`);

  const rnd = mulberry32(SEED);
  const placed = new Placed();
  const counts = new Map<string, number>();
  const keep = (d: Decoration) => {
    placed.add(d);
    counts.set(`${d.level} ${d.kind}`, (counts.get(`${d.level} ${d.kind}`) ?? 0) + 1);
  };
  const coastNeed = (kind: GlyphKind, level: number) => Math.max(MIN_COAST_KM[kind], 0.45 * LEVEL_DEG[level] * KM_PER_DEG * FOOTPRINT[kind]);
  const clearOfShore = (lng: number, lat: number, kind: GlyphKind, level: number) => {
    const need = coastNeed(kind, level);
    return shores.distanceKm(lng, lat, need) === Infinity;
  };
  const scale = (lo = 0.88, hi = 1.08) => round2(lo + (hi - lo) * rnd());

  // Sea monsters first: fixed spots, checked rather than searched for.
  placed.rebucket(LEVEL_DEG[0] * 4);
  for (const m of MONSTERS) {
    if (land.contains(m.lng, m.lat) || !clearOfShore(m.lng, m.lat, m.kind, m.level)) throw new Error(`${m.kind} at ${m.lng},${m.lat} is too near land`);
    keep({ lng: m.lng, lat: m.lat, kind: m.kind, variant: 0, level: m.level, scale: 1 });
  }

  // Ship stations every ~150 km along each route, facing the way it runs.
  const stations: { lng: number; lat: number; east: boolean }[] = [];
  for (const r of routes.features) {
    const pts = r.geometry.coordinates as [number, number][];
    for (let i = 0; i < pts.length - 1; i++) {
      const km = geoDistance(pts[i], pts[i + 1]) * R_KM;
      const n = Math.max(1, Math.round(km / 150));
      const lerp = geoInterpolate(pts[i], pts[i + 1]);
      for (let k = 0; k < n; k++) {
        const [lng, lat] = lerp(k / n);
        const [lng2] = lerp(Math.min(1, (k + 0.5) / n));
        const dLng = ((lng2 - lng + 540) % 360) - 180;
        stations.push({ lng: round2(lng), lat: round2(lat), east: dLng >= 0 });
      }
    }
  }

  for (let level = 0; level < LEVEL_DEG.length; level++) {
    placed.rebucket(LEVEL_DEG[level] * Math.max(...Object.values(SPACING)));

    if (level < SHIP_LEVELS) {
      for (const s of shuffle(stations.slice(), rnd)) {
        if (land.contains(s.lng, s.lat) || !clearOfShore(s.lng, s.lat, 'ship', level) || !placed.fits(s.lng, s.lat, 'ship', level)) continue;
        // ship-0 and ship-2 sail east (right), ship-1 west.
        const variant = s.east ? (rnd() < 0.5 ? 0 : 2) : 1;
        keep({ lng: s.lng, lat: s.lat, kind: 'ship', variant, level, scale: scale(0.95, 1.05) });
      }
    }

    for (const [lng, lat] of shuffle(jitteredGrid(LEVEL_DEG[level] / 2, rnd), rnd)) {
      let kind: GlyphKind | null = null;
      if (land.contains(lng, lat)) {
        if (lakes.contains(lng, lat)) continue;
        if (hit(mountains, lng, lat)) kind = 'mountain';
        else if (hit(deserts, lng, lat)) kind = 'desert';
        else {
          const forest = hit(forests, lng, lat);
          if (!forest?.glyphs) continue;
          const weights = { ...forest.glyphs };
          // Palms crowd the coasts and thin out inland.
          if (weights.palm) weights.palm *= shores.distanceKm(lng, lat, 400) === Infinity ? 0.4 : 2.5;
          kind = pickWeighted(weights, rnd);
        }
      } else if (Math.abs(lat) <= RIPPLE_MAX_LAT && rippleField(lng, lat) > RIPPLE_FIELD_MIN) {
        kind = 'ripple';
      }
      if (!kind || !placed.fits(lng, lat, kind, level) || !clearOfShore(lng, lat, kind, level)) continue;
      keep({ lng, lat, kind, variant: Math.floor(rnd() * variantCount(kind)), level, scale: kind === 'ripple' ? scale(0.85, 1.1) : scale() });
    }
  }

  const list: Decoration[] = placed.all.map(({ v: _v, ...d }) => d);
  const about =
    'Map decoration glyphs for the globe, placed by scripts/build-decorations.ts (deterministic; rerun with npm run build:decorations). Format: src/map/decorations.ts.';
  const json = JSON.stringify(encodeDecorations(list, about));
  await writeFile(OUT, `${json}\n`);

  const kinds = [...new Set(list.map((d) => d.kind))];
  console.log(`\nGlyphs by level:`);
  for (let level = 0; level < LEVEL_DEG.length; level++) {
    console.log(`  ${level} (${LEVEL_DEG[level]}°): ` + kinds.map((k) => `${k} ${counts.get(`${level} ${k}`) ?? 0}`).join(', '));
  }
  console.log(`\nWrote ${list.length.toLocaleString()} glyphs to src/data/decorations.json (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
