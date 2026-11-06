/**
 * Builds the map data from Natural Earth (public domain).
 *
 *   npm run build:geodata
 *
 * Outputs (both committed, so `npm run build` never needs the network):
 *
 *   src/data/basemap.topo.json     Base map for the whole world, moderately
 *                                  simplified. Loaded on start-up; also used by
 *                                  the question validator.
 *   public/geo/tiles/<c>-<r>.json  Detail tiles with finer coastlines, rivers and
 *                                  lakes, fetched only when the player zooms in.
 *
 * Both levels are TopoJSON, pre-projected with the game's own d3.geoMercator
 * (src/map/projection.ts) into "map units", and cut into the same grid of
 * cells (src/map/tiles.ts). Cutting matters for speed: the browser rasterises
 * in tiles and skips any SVG path whose bounds miss the tile, so a world cut
 * into cells redraws a fraction of the vertices a single world path would.
 *
 * Source GeoJSON is downloaded once from the pinned Natural Earth release on
 * GitHub into .cache/natural-earth/. Only physical layers are kept (land,
 * coast, lakes, rivers): no borders, no names, no attributes.
 */
import { mkdir, readFile, writeFile, access, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { geoIdentity, geoStream } from 'd3-geo';
import { topology } from 'topojson-server';
import { presimplify, simplify, filter, filterWeight } from 'topojson-simplify';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import { createProjection, MAP_WIDTH, MAP_HEIGHT } from '../src/map/projection.ts';
import { TILE_COLS, TILE_ROWS, LAYER_KEYS, type LayerKey } from '../src/map/tiles.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, '.cache/natural-earth');
const BASE_OUT = resolve(ROOT, 'src/data/basemap.topo.json');
const TILE_DIR = resolve(ROOT, 'public/geo/tiles');
const NE_TAG = 'v5.1.2';
const NE_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_TAG}/geojson/`;

interface LevelConfig {
  land: string;
  lakes: string;
  rivers: string;
  maxRiverRank: number;
  maxLakeRank: number;
  /** Visvalingam effective-area threshold (squared Mercator radians). */
  minWeight: number;
  /** Islands smaller than this are dropped. */
  minRingArea: number;
  /** Lakes smaller than this are dropped. */
  minLakeArea: number;
  /** Overlap between neighbouring cells, in map units, so fills don't seam. */
  margin: number;
  quantization: number;
}

/** Base level: good up to the detail threshold (see src/map/detail.ts). */
const BASE: LevelConfig = {
  land: 'ne_10m_land',
  lakes: 'ne_50m_lakes',
  rivers: 'ne_50m_rivers_lake_centerlines',
  maxRiverRank: 6,
  maxLakeRank: Infinity,
  minWeight: 6e-6,
  minRingArea: 1e-6,
  minLakeArea: 2e-6,
  margin: 0.25,
  quantization: 4e4,
};

/** Detail level: good to the maximum zoom (~1 km per pixel). */
const DETAIL: LevelConfig = {
  land: 'ne_10m_land',
  lakes: 'ne_10m_lakes',
  rivers: 'ne_10m_rivers_lake_centerlines',
  maxRiverRank: 7,
  maxLakeRank: 7,
  minWeight: 8e-8,
  minRingArea: 4e-8,
  minLakeArea: 2.5e-7,
  margin: 0.12,
  quantization: 1e4,
};

type Pt = [number, number];
type Rect = [[number, number], [number, number]];
type CellGeometry = Record<LayerKey, Pt[][] | Pt[][][]>;

const RAD = Math.PI / 180;
const LAT_CLAMP = 85;

/** Plain (unrotated) Mercator in radians, used only for simplification weights. */
function merc([lng, lat]: number[]): Pt {
  const phi = Math.max(-LAT_CLAMP, Math.min(LAT_CLAMP, lat)) * RAD;
  return [lng * RAD, Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

function triangleArea(t: number[][]): number {
  const [a, b, c] = t.map(merc);
  return Math.abs((a[0] - c[0]) * (b[1] - a[1]) - (a[0] - b[0]) * (c[1] - a[1])) / 2;
}

function ringArea(ring: number[][]): number {
  let sum = 0;
  const pts = ring.map(merc);
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
    sum += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return Math.abs(sum) / 2;
}

function polygonArea(geometry: Geometry): number {
  if (geometry.type === 'Polygon') return ringArea(geometry.coordinates[0]);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.reduce((s, p) => s + ringArea(p[0]), 0);
  return 0;
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

function collection(features: Feature[], props: (f: Feature) => Record<string, number> | null = () => null) {
  return {
    type: 'FeatureCollection' as const,
    features: features.map((f) => ({ type: 'Feature' as const, properties: props(f), geometry: f.geometry })),
  };
}

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

/** Projects GeoJSON into map units with the game's projection. */
function projectFeatures(fc: FeatureCollection): Recorder {
  const rec = new Recorder();
  geoStream(fc as never, createProjection(0).stream(rec as never));
  return rec;
}

const EPS = 1e-6;
const onSheetEdge = (p: Pt) =>
  Math.abs(p[0]) < EPS || Math.abs(p[0] - MAP_WIDTH) < EPS || Math.abs(p[1]) < EPS || Math.abs(p[1] - MAP_HEIGHT) < EPS;

/**
 * Outline linework from projected polygon rings, without the artificial
 * edges where the projection clipped land at the sheet boundary.
 */
function outlineLines(polygons: Pt[][][]): Pt[][] {
  const out: Pt[][] = [];
  for (const poly of polygons) {
    for (const ring of poly) {
      const closed = [...ring, ring[0]];
      let cur: Pt[] = [];
      for (let i = 0; i < closed.length; i++) {
        const p = closed[i];
        if (i > 0 && onSheetEdge(p) && onSheetEdge(closed[i - 1])) {
          if (cur.length > 1) out.push(cur);
          cur = [p];
        } else cur.push(p);
      }
      if (cur.length > 1) out.push(cur);
    }
  }
  return out;
}

function bboxOf(rings: Pt[][]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rings) {
    for (const [x, y] of r) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return [
    [x0, y0],
    [x1, y1],
  ];
}

const overlaps = (a: Rect, b: Rect) =>
  a[0][0] <= b[1][0] && a[1][0] >= b[0][0] && a[0][1] <= b[1][1] && a[1][1] >= b[0][1];

function clipPolygons(polys: { rings: Pt[][]; box: Rect }[], rect: Rect): Pt[][][] {
  const rec = new Recorder();
  const stream = geoIdentity().clipExtent(rect).stream(rec as never);
  for (const { rings, box } of polys) {
    if (!overlaps(box, rect)) continue;
    stream.polygonStart();
    for (const ring of rings) {
      stream.lineStart();
      for (const [x, y] of ring) stream.point(x, y);
      stream.lineEnd();
    }
    stream.polygonEnd();
  }
  // GeoJSON rings are closed; d3 streams omit the closing point.
  return rec.polygons.map((p) => p.map((ring) => [...ring, ring[0]]));
}

function clipLines(lines: { line: Pt[]; box: Rect }[], rect: Rect): Pt[][] {
  const rec = new Recorder();
  const stream = geoIdentity().clipExtent(rect).stream(rec as never);
  for (const { line, box } of lines) {
    if (!overlaps(box, rect)) continue;
    stream.lineStart();
    for (const [x, y] of line) stream.point(x, y);
    stream.lineEnd();
  }
  return rec.lines;
}

/** Simplifies, projects and cuts one level of detail into grid cells. */
async function buildLevel(cfg: LevelConfig): Promise<Map<string, CellGeometry>> {
  const [land, lakes, rivers] = await Promise.all([load(cfg.land), load(cfg.lakes), load(cfg.rivers)]);
  const lakeOk = (f: Feature) =>
    !!f.geometry &&
    f.properties?.featurecla !== 'Reservoir' && // modern reservoirs have no place on a Victorian sheet
    Number(f.properties?.scalerank ?? 0) <= cfg.maxLakeRank &&
    polygonArea(f.geometry) >= cfg.minLakeArea;
  const riverOk = (f: Feature) =>
    !!f.geometry && f.properties?.featurecla === 'River' && Number(f.properties?.scalerank ?? 99) <= cfg.maxRiverRank;

  let t = topology({
    land: collection(land.features.filter((f) => f.geometry)),
    lakes: collection(lakes.features.filter(lakeOk)),
    rivers: collection(rivers.features.filter(riverOk), (f) => ({ r: Number(f.properties?.scalerank ?? 6) })),
  }) as unknown as Topology;
  t = presimplify(t as never, triangleArea as never) as unknown as Topology;
  t = simplify(t as never, cfg.minWeight) as unknown as Topology;
  t = filter(t as never, filterWeight(t as never, cfg.minRingArea, ringArea as never)) as unknown as Topology;
  for (const arc of t.arcs) for (const p of arc) p.length = 2;

  const geo = (name: string) => feature(t as never, (t.objects as never)[name]) as unknown as FeatureCollection;
  const riversFc = geo('rivers');
  const byRank = (lo: number, hi: number): FeatureCollection => ({
    ...riversFc,
    features: riversFc.features.filter((f) => Number(f.properties?.r) >= lo && Number(f.properties?.r) < hi),
  });
  const landP = projectFeatures(geo('land'));
  const lakeP = projectFeatures(geo('lakes'));
  const withBox = (polys: Pt[][][]) => polys.map((rings) => ({ rings, box: bboxOf(rings) }));
  const linesBox = (lines: Pt[][]) => lines.map((line) => ({ line, box: bboxOf([line]) }));
  const landPolys = withBox(landP.polygons);
  const lakePolys = withBox(lakeP.polygons);
  const coast = linesBox(outlineLines(landP.polygons));
  const shores = linesBox(outlineLines(lakeP.polygons));
  // Three river weights: major (rank < 4), middling (4–5), minor (6+).
  const r1 = linesBox(projectFeatures(byRank(0, 4)).lines);
  const r2 = linesBox(projectFeatures(byRank(4, 6)).lines);
  const r3 = linesBox(projectFeatures(byRank(6, 99)).lines);

  const cells = new Map<string, CellGeometry>();
  const cw = MAP_WIDTH / TILE_COLS;
  const ch = MAP_HEIGHT / TILE_ROWS;
  const m = cfg.margin;
  for (let r = 0; r < TILE_ROWS; r++) {
    for (let c = 0; c < TILE_COLS; c++) {
      const rect: Rect = [
        [c * cw - m, r * ch - m],
        [(c + 1) * cw + m, (r + 1) * ch + m],
      ];
      const geom: CellGeometry = {
        land: clipPolygons(landPolys, rect),
        coast: clipLines(coast, rect),
        lakes: clipPolygons(lakePolys, rect),
        shores: clipLines(shores, rect),
        r1: clipLines(r1, rect),
        r2: clipLines(r2, rect),
        r3: clipLines(r3, rect),
      };
      if (geom.land.length || geom.coast.length) cells.set(`${c}-${r}`, geom);
    }
  }
  return cells;
}

/** GeoJSON FeatureCollection for one cell: one feature per non-empty layer. */
function cellFeatures(g: CellGeometry) {
  return {
    type: 'FeatureCollection' as const,
    features: LAYER_KEYS.filter((k) => g[k].length).map((k) => ({
      type: 'Feature' as const,
      id: k,
      properties: null,
      geometry:
        k === 'land' || k === 'lakes'
          ? { type: 'MultiPolygon' as const, coordinates: g[k] as Pt[][][] }
          : { type: 'MultiLineString' as const, coordinates: g[k] as Pt[][] },
    })),
  };
}

function countPoints(t: Topology): number {
  return t.arcs.reduce((s, a) => s + a.length, 0);
}

const size = (s: string) => `${(s.length / 1024).toFixed(0)} KB (gzip ${(gzipSync(s).length / 1024).toFixed(0)} KB)`;

async function main() {
  const [base, detail] = await Promise.all([buildLevel(BASE), buildLevel(DETAIL)]);

  // Detail tiles, one file per cell. Stale files are removed one by one
  // (deleting the folder upsets a running Vite dev server's file watcher).
  await mkdir(TILE_DIR, { recursive: true });
  for (const name of await readdir(TILE_DIR)) {
    if (!detail.has(name.replace(/\.json$/, ''))) await rm(resolve(TILE_DIR, name));
  }
  const hash = createHash('sha1');
  let raw = 0;
  let gz = 0;
  let maxGz = 0;
  let detailPoints = 0;
  for (const [id, g] of detail) {
    const topo = topology({ cell: cellFeatures(g) } as never, DETAIL.quantization) as unknown as Topology;
    delete (topo as { bbox?: unknown }).bbox;
    const json = JSON.stringify(topo);
    await writeFile(resolve(TILE_DIR, `${id}.json`), json);
    hash.update(id).update(json);
    detailPoints += countPoints(topo);
    const z = gzipSync(json).length;
    raw += json.length;
    gz += z;
    maxGz = Math.max(maxGz, z);
  }
  console.log(
    `Detail: ${detail.size} tiles in ${TILE_DIR}\n  points ${detailPoints}, ` +
      `${(raw / 1024).toFixed(0)} KB (gzip ${(gz / 1024).toFixed(0)} KB), largest tile gzip ${(maxGz / 1024).toFixed(1)} KB`,
  );

  // Base map, all cells in one topology.
  const objects = Object.fromEntries([...base].map(([id, g]) => [id, cellFeatures(g)]));
  const topo = topology(objects as never, BASE.quantization) as unknown as Topology;
  delete (topo as { bbox?: unknown }).bbox;
  // Foreign member describing the grid and which detail tiles exist.
  (topo as unknown as { grid: unknown }).grid = {
    cols: TILE_COLS,
    rows: TILE_ROWS,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    detailVersion: hash.digest('hex').slice(0, 10),
    detail: [...detail.keys()],
  };
  const json = JSON.stringify(topo);
  await mkdir(dirname(BASE_OUT), { recursive: true });
  await writeFile(BASE_OUT, json);
  console.log(`Base: ${base.size} cells in ${BASE_OUT}\n  points ${countPoints(topo)}, ${size(json)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
