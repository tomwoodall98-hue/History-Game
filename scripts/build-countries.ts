/**
 * Builds the country outlines that scoring uses for the same-country floor.
 *
 *   npm run build:countries
 *
 * Output (committed, so `npm run build` never needs the network):
 *
 *   src/data/countries.topo.json   Natural Earth 1:50m admin-0 countries as
 *                                  TopoJSON in plain lng/lat, simplified so
 *                                  that 99.9% of points still fall in the same
 *                                  country as at full resolution (~130 KB
 *                                  gzipped). Each country keeps two
 *                                  properties: "a3", its ADM0_A3 code, and
 *                                  "r", the equivalent radius √(area/π) in km
 *                                  of the whole country, worked out before
 *                                  simplifying.
 *
 * These outlines are for scoring only and are never drawn (see
 * src/game/countries.ts). The source is the same pinned Natural Earth release
 * as the map, downloaded once into .cache/natural-earth/.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { geoArea } from 'd3-geo';
import { topology } from 'topojson-server';
import { presimplify, simplify, filter, filterWeight } from 'topojson-simplify';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import { EARTH_RADIUS_KM } from '../src/game/scoring.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, '.cache/natural-earth');
const OUT = resolve(ROOT, 'src/data/countries.topo.json');
const NAME = 'ne_50m_admin_0_countries';
const SOURCE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/${NAME}.geojson`;

/** Visvalingam effective area below which a vertex is dropped, km². */
const MIN_TRIANGLE_KM2 = 30;
/** Islands smaller than this are dropped, km². */
const MIN_RING_KM2 = 2;
const QUANTIZATION = 1e5;

const KM_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_KM;

/** Plane coordinates in km around a latitude, good enough for small areas. */
const local = ([lng, lat]: number[], lat0: number): [number, number] => [lng * KM_PER_DEG * Math.cos((lat0 * Math.PI) / 180), lat * KM_PER_DEG];

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

/** Spherical area of a polygon in km², whichever way its rings wind. */
function polygonKm2(coordinates: Polygon['coordinates']): number {
  let a = geoArea({ type: 'Polygon', coordinates });
  if (a > 2 * Math.PI) a = 4 * Math.PI - a;
  return a * EARTH_RADIUS_KM ** 2;
}

async function load(): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  const path = resolve(CACHE, `${NAME}.geojson`);
  try {
    await access(path);
  } catch {
    console.log(`Downloading ${SOURCE_URL}`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`Failed to download ${SOURCE_URL}: ${res.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const source = await load();
  const seen = new Set<string>();
  const features: Feature<Polygon | MultiPolygon, { a3: string; r: number }>[] = [];
  for (const f of source.features) {
    const a3 = String(f.properties?.ADM0_A3 ?? '');
    if (!/^[A-Z0-9]{3}$/.test(a3)) throw new Error(`Unexpected ADM0_A3 ${JSON.stringify(a3)}`);
    if (seen.has(a3)) throw new Error(`Duplicate ADM0_A3 ${a3}`);
    seen.add(a3);
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const km2 = polys.reduce((s, p) => s + polygonKm2(p), 0);
    features.push({ type: 'Feature', properties: { a3, r: Math.round(Math.sqrt(km2 / Math.PI)) }, geometry: f.geometry });
  }
  features.sort((a, b) => a.properties.a3.localeCompare(b.properties.a3));

  let t = topology({ countries: { type: 'FeatureCollection', features } } as never) as unknown as Topology;
  t = presimplify(t as never, triangleKm2 as never) as unknown as Topology;
  t = simplify(t as never, MIN_TRIANGLE_KM2) as unknown as Topology;
  t = filter(t as never, filterWeight(t as never, MIN_RING_KM2, ringKm2 as never)) as unknown as Topology;
  for (const arc of t.arcs) for (const p of arc) p.length = 2;

  const simplified = feature(t as never, (t.objects as never)['countries']) as unknown as FeatureCollection;
  const out = topology({ countries: simplified } as never, QUANTIZATION) as unknown as Topology;
  delete (out as { bbox?: unknown }).bbox;
  const json = JSON.stringify(out);
  await writeFile(OUT, json);
  const points = out.arcs.reduce((s, a) => s + a.length, 0);
  console.log(
    `${features.length} countries, ${points} points → ${OUT}\n  ${(json.length / 1024).toFixed(0)} KB (gzip ${(gzipSync(json).length / 1024).toFixed(0)} KB)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
