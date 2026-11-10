/**
 * Builds the globe's map data from Natural Earth (public domain).
 *
 *   npm run build:geodata
 *
 * Outputs (committed, so `npm run build` never needs the network):
 *
 *   src/data/globe.topo.json        Base level, loaded on start-up and used by
 *                                   the question validator:
 *                                     coarseLand, coarseCoast  1:110m, drawn
 *                                       while the globe is moving
 *                                     land, coast, lakes, shores, rivers  for
 *                                       the globe at rest
 *   public/geo/globe/<c>-<r>.json   1:10m detail tiles, one per 15° cell,
 *                                   fetched only when the player zooms in.
 *
 * Everything is plain longitude/latitude TopoJSON; the globe projects it as
 * it turns. Only physical layers are kept (land, coast, lakes, rivers): no
 * borders, no names. Reservoirs are left out as anachronisms.
 *
 * Two details matter for a globe:
 *   - d3 draws a polygon as everything on the sphere to the right of its
 *     rings, so every polygon is checked and, if it would cover more than a
 *     hemisphere, its rings are reversed.
 *   - Natural Earth cuts land at the antimeridian and along the South Pole.
 *     Coastlines are drawn from separate line layers with those artificial
 *     edges taken out, so no seam is ever inked.
 *
 * Source GeoJSON is downloaded once from the pinned release into
 * .cache/natural-earth/.
 */
import { mkdir, readFile, writeFile, access, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, FeatureCollection, Geometry, MultiLineString, MultiPolygon, Position } from 'geojson';
import { geoArea, geoIdentity, geoStream } from 'd3-geo';
import { topology } from 'topojson-server';
import { presimplify, simplify, filter, filterWeight } from 'topojson-simplify';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import { CELL_COLS, CELL_DEG, CELL_ROWS, cellBounds, cellId, type GlobeGrid } from '../src/map/globeData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, '.cache/natural-earth');
const BASE_OUT = resolve(ROOT, 'src/data/globe.topo.json');
const TILE_DIR = resolve(ROOT, 'public/geo/globe');
const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/';

interface Level {
  land: string;
  lakes: string;
  rivers: string;
  maxRiverRank: number;
  maxLakeRank: number;
  /** Visvalingam effective area below which a vertex is dropped, km². */
  minTriangleKm2: number;
  /** Islands smaller than this are dropped, km². */
  minRingKm2: number;
  /** Lakes smaller than this are dropped, km². */
  minLakeKm2: number;
  quantization: number;
}

/** Base level: good down to about 4 km per pixel. */
const BASE: Level = {
  land: 'ne_10m_land',
  lakes: 'ne_50m_lakes',
  rivers: 'ne_50m_rivers_lake_centerlines',
  maxRiverRank: 6,
  maxLakeRank: Infinity,
  minTriangleKm2: 120,
  minRingKm2: 60,
  minLakeKm2: 80,
  quantization: 1e5,
};

/** Detail level: good to the deepest zoom (~100 m per pixel). */
const DETAIL: Level = {
  land: 'ne_10m_land',
  lakes: 'ne_10m_lakes',
  rivers: 'ne_10m_rivers_lake_centerlines',
  maxRiverRank: 7,
  maxLakeRank: 7,
  minTriangleKm2: 1.5,
  minRingKm2: 1.5,
  minLakeKm2: 10,
  quantization: 1e4,
};

type Pt = [number, number];
const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_KM;

/** Local plane in km around a latitude: good enough for small areas. */
const local = ([lng, lat]: number[], lat0: number): Pt => [lng * KM_PER_DEG * Math.cos((lat0 * Math.PI) / 180), lat * KM_PER_DEG];

function triangleKm2(t: number[][]): number {
  const lat0 = (t[0][1] + t[1][1] + t[2][1]) / 3;
  const [a, b, c] = t.map((p) => local(p, lat0));
  return Math.abs((a[0] - c[0]) * (b[1] - a[1]) - (a[0] - b[0]) * (c[1] - a[1])) / 2;
}

function ringKm2(ring: number[][]): number {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  let sum = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const [xj, yj] = local(ring[j], lat0);
    const [xi, yi] = local(ring[i], lat0);
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum) / 2;
}

/** Rings reversed if, as d3 reads them, the polygon would cover more than a hemisphere. */
function d3Winding(rings: Position[][]): Position[][] {
  return geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI ? rings.map((r) => [...r].reverse()) : rings;
}

function polygonsOf(g: Geometry | null): Position[][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/** Artificial edges: along the antimeridian, or along the South Pole. */
const EPS = 1e-6;
const artificial = (a: Position, b: Position) =>
  (Math.abs(Math.abs(a[0]) - 180) < EPS && Math.abs(Math.abs(b[0]) - 180) < EPS) || (a[1] < -89.99 && b[1] < -89.99);

/** A polygon layer's outlines as lines, without the artificial edges. */
function outlines(polys: Position[][][]): Position[][] {
  const out: Position[][] = [];
  for (const poly of polys) {
    for (const ring of poly) {
      let cur: Position[] = [];
      for (let i = 0; i < ring.length; i++) {
        if (i > 0 && artificial(ring[i - 1], ring[i])) {
          if (cur.length > 1) out.push(cur);
          cur = [ring[i]];
        } else cur.push(ring[i]);
      }
      if (cur.length > 1) out.push(cur);
    }
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function load(name: string): Promise<FeatureCollection> {
  const path = resolve(CACHE, `${name}.geojson`);
  if (!(await exists(path))) {
    const url = `${NE_BASE}${name}.geojson`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(await readFile(path, 'utf8')) as FeatureCollection;
}

const multiPolygon = (coordinates: Position[][][]): Feature<MultiPolygon> => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates } });
const multiLine = (coordinates: Position[][], properties: Record<string, number> = {}): Feature<MultiLineString> => ({
  type: 'Feature',
  properties,
  geometry: { type: 'MultiLineString', coordinates },
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

interface Layers {
  land: Position[][][];
  coast: Position[][];
  lakes: Position[][][];
  shores: Position[][];
  /** Rivers by weight class: 1 major (rank < 4), 2 middling (4–5), 3 minor (6+). */
  rivers: Position[][][];
}

/** Loads, filters and simplifies one level; returns plain coordinates. */
async function buildLevel(cfg: Level): Promise<Layers> {
  const [land, lakes, rivers] = await Promise.all([load(cfg.land), load(cfg.lakes), load(cfg.rivers)]);
  const landPolys = land.features.flatMap((f) => polygonsOf(f.geometry)).filter((p) => ringKm2(p[0]) >= cfg.minRingKm2);
  const lakePolys = lakes.features
    .filter((f) => f.properties?.featurecla !== 'Reservoir' && Number(f.properties?.scalerank ?? 0) <= cfg.maxLakeRank)
    .flatMap((f) => polygonsOf(f.geometry))
    .filter((p) => ringKm2(p[0]) >= cfg.minLakeKm2);
  const riverLines = [1, 2, 3].map((cls) =>
    rivers.features
      .filter((f) => f.properties?.featurecla === 'River' && f.geometry)
      .filter((f) => {
        const rank = Number(f.properties?.scalerank ?? 99);
        return rank <= cfg.maxRiverRank && (cls === 1 ? rank < 4 : cls === 2 ? rank >= 4 && rank < 6 : rank >= 6);
      })
      .flatMap((f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [])),
  );

  // One topology, so land and its coast share arcs and simplify together.
  let t = topology({
    land: fc([multiPolygon(landPolys)]),
    coast: fc([multiLine(outlines(landPolys))]),
    lakes: fc([multiPolygon(lakePolys)]),
    shores: fc([multiLine(outlines(lakePolys))]),
    rivers: fc(riverLines.map((lines, i) => multiLine(lines, { r: i + 1 }))),
  } as never) as unknown as Topology;
  t = presimplify(t as never, triangleKm2 as never) as unknown as Topology;
  t = simplify(t as never, cfg.minTriangleKm2) as unknown as Topology;
  t = filter(t as never, filterWeight(t as never, cfg.minRingKm2, ringKm2 as never)) as unknown as Topology;
  for (const arc of t.arcs) for (const p of arc) p.length = 2;

  const geo = (name: string) => feature(t as never, (t.objects as never)[name]) as unknown as FeatureCollection;
  const polys = (name: string) => geo(name).features.flatMap((f) => polygonsOf(f.geometry)).map(d3Winding);
  const lines = (name: string) => geo(name).features.flatMap((f) => (f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates : []));
  const riverFc = geo('rivers');
  return {
    land: polys('land'),
    coast: lines('coast').filter((l) => l.length > 1),
    lakes: polys('lakes'),
    shores: lines('shores').filter((l) => l.length > 1),
    rivers: [1, 2, 3].map((cls) => riverFc.features.filter((f) => f.properties?.r === cls).flatMap((f) => (f.geometry as MultiLineString).coordinates)),
  };
}

/** Coarse 1:110m land and coast for frames drawn while the globe moves. */
async function buildCoarse(): Promise<{ land: Position[][][]; coast: Position[][] }> {
  const land = await load('ne_110m_land');
  const polys = land.features.flatMap((f) => polygonsOf(f.geometry)).map(d3Winding);
  return { land: polys, coast: outlines(polys) };
}

// ---------------------------------------------------------- clipping ---

/** d3 stream sink that records polygons (keeping ring structure) and lines. */
class Recorder {
  polygons: Pt[][][] = [];
  lines: Pt[][] = [];
  private poly: Pt[][] | null = null;
  private ring: Pt[] | null = null;
  polygonStart() {
    this.poly = [];
  }
  polygonEnd() {
    if (this.poly?.length) this.polygons.push(this.poly);
    this.poly = null;
  }
  lineStart() {
    this.ring = [];
  }
  lineEnd() {
    const ring = this.ring;
    this.ring = null;
    if (!ring || ring.length < 2) return;
    if (this.poly) this.poly.push(ring);
    else this.lines.push(ring);
  }
  point(x: number, y: number) {
    this.ring?.push([x, y]);
  }
  sphere() {}
}

/**
 * Inserts points every `step` degrees along long edges. A cell boundary
 * along a parallel is a single long edge after clipping, and the globe draws
 * edges as great circles, so without this, neighbouring tiles would not meet.
 */
function densify(ring: Pt[], step = 0.5): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    out.push(a);
    const b = ring[(i + 1) % ring.length];
    if (i === ring.length - 1) break;
    const n = Math.floor(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function clipPolygons(polys: Position[][][], rect: [[number, number], [number, number]]): Position[][][] {
  const rec = new Recorder();
  geoStream({ type: 'MultiPolygon', coordinates: polys } as never, geoIdentity().clipExtent(rect).stream(rec as never));
  // GeoJSON rings are closed; d3 streams omit the closing point.
  return rec.polygons.map((p) => d3Winding(p.map((ring) => densify([...ring, ring[0]]))));
}

function clipLines(lines: Position[][], rect: [[number, number], [number, number]]): Position[][] {
  const rec = new Recorder();
  geoStream({ type: 'MultiLineString', coordinates: lines } as never, geoIdentity().clipExtent(rect).stream(rec as never));
  return rec.lines;
}

const bboxOverlaps = (coords: Position[], [[w, s], [e, n]]: [[number, number], [number, number]]) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of coords) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return x0 <= e && x1 >= w && y0 <= n && y1 >= s;
};

/** One detail tile, or null if the cell is empty sea. */
function cutCell(d: Layers, col: number, row: number) {
  const rect = cellBounds(col, row);
  const polys = (ps: Position[][][]) => clipPolygons(ps.filter((p) => bboxOverlaps(p[0], rect)), rect);
  const lines = (ls: Position[][]) => clipLines(ls.filter((l) => bboxOverlaps(l, rect)), rect);
  const tile = {
    land: polys(d.land),
    coast: lines(d.coast),
    lakes: polys(d.lakes),
    shores: lines(d.shores),
    rivers: d.rivers.map(lines),
  };
  return tile.land.length || tile.coast.length ? tile : null;
}

const size = (s: string) => `${(s.length / 1024).toFixed(0)} KB (gzip ${(gzipSync(s).length / 1024).toFixed(0)} KB)`;
const points = (t: Topology) => t.arcs.reduce((s, a) => s + a.length, 0);

async function main() {
  const [coarse, base, detail] = await Promise.all([buildCoarse(), buildLevel(BASE), buildLevel(DETAIL)]);

  // Detail tiles. Stale files are removed one by one (deleting the folder
  // upsets a running Vite dev server's file watcher).
  await mkdir(TILE_DIR, { recursive: true });
  const tiles = new Map<string, string>();
  for (let row = 0; row < CELL_ROWS; row++) {
    for (let col = 0; col < CELL_COLS; col++) {
      const tile = cutCell(detail, col, row);
      if (!tile) continue;
      const topo = topology(
        {
          land: fc([multiPolygon(tile.land)]),
          coast: fc([multiLine(tile.coast)]),
          lakes: fc([multiPolygon(tile.lakes)]),
          shores: fc([multiLine(tile.shores)]),
          rivers: fc(tile.rivers.map((lines, i) => multiLine(lines, { r: i + 1 }))),
        } as never,
        DETAIL.quantization,
      ) as unknown as Topology;
      delete (topo as { bbox?: unknown }).bbox;
      tiles.set(cellId(col, row), JSON.stringify(topo));
    }
  }
  for (const name of await readdir(TILE_DIR)) if (!tiles.has(name.replace(/\.json$/, ''))) await rm(resolve(TILE_DIR, name));
  const hash = createHash('sha1');
  let raw = 0;
  let gz = 0;
  for (const [id, json] of tiles) {
    await writeFile(resolve(TILE_DIR, `${id}.json`), json);
    hash.update(id).update(json);
    raw += json.length;
    gz += gzipSync(json).length;
  }
  console.log(`Detail: ${tiles.size} tiles in ${TILE_DIR}, ${(raw / 1024).toFixed(0)} KB (gzip ${(gz / 1024).toFixed(0)} KB)`);

  // Base, with the detail grid as a foreign member.
  const topo = topology(
    {
      coarseLand: fc([multiPolygon(coarse.land)]),
      coarseCoast: fc([multiLine(coarse.coast)]),
      land: fc([multiPolygon(base.land)]),
      coast: fc([multiLine(base.coast)]),
      lakes: fc([multiPolygon(base.lakes)]),
      shores: fc([multiLine(base.shores)]),
      rivers: fc(base.rivers.map((lines, i) => multiLine(lines, { r: i + 1 }))),
    } as never,
    BASE.quantization,
  ) as unknown as Topology;
  delete (topo as { bbox?: unknown }).bbox;
  const grid: GlobeGrid = { cellDeg: CELL_DEG, detailVersion: hash.digest('hex').slice(0, 10), detail: [...tiles.keys()] };
  (topo as unknown as { grid: GlobeGrid }).grid = grid;
  const json = JSON.stringify(topo);
  await mkdir(dirname(BASE_OUT), { recursive: true });
  await writeFile(BASE_OUT, json);
  console.log(`Base: ${BASE_OUT}\n  points ${points(topo)}, ${size(json)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
