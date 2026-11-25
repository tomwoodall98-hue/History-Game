import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { geoBounds, geoContains, geoDistance, geoInterpolate } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { FeatureCollection, Geometry, MultiLineString, MultiPolygon, Polygon } from 'geojson';
import { GLYPHS } from '../src/map/glyphs.ts';
import { DECORATION_KINDS, LAND_KINDS, LEVEL_DEG, SHIP_COAST_KM, decodeDecorations, minSeparationDeg, type DecorationFile } from '../src/map/decorations.ts';
import { DECOR_SPACING_PX, levelOfDetail } from '../src/map/decorLayer.ts';

const file = JSON.parse(readFileSync(new URL('../src/data/decorations.json', import.meta.url), 'utf8')) as DecorationFile;
const glyphs = decodeDecorations(file);
const topo = JSON.parse(readFileSync(new URL('../src/data/globe.topo.json', import.meta.url), 'utf8')) as Topology;
const fc = <T extends Geometry>(name: string) => feature(topo as never, topo.objects[name] as never) as unknown as FeatureCollection<T>;

/**
 * The globe's polygons one by one, each with its bounds, tested on the
 * sphere with d3 (the build uses its own planar test, so this checks it).
 */
function polygons(name: string) {
  return fc<Polygon | MultiPolygon>(name).features.flatMap((f) =>
    (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((coordinates) => {
      const poly: Polygon = { type: 'Polygon', coordinates };
      return { poly, bounds: geoBounds(poly) };
    }),
  );
}
function unitOf(lng: number, lat: number): [number, number, number] {
  const l = (lng * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

const inAny = (polys: ReturnType<typeof polygons>, lng: number, lat: number) =>
  polys.some(({ poly, bounds: [[w, s], [e, n]] }) => {
    if (lat < s - 0.01 || lat > n + 0.01) return false;
    // Bounds that cross the antimeridian have west > east.
    const inLng = w <= e ? lng >= w - 0.01 && lng <= e + 0.01 : lng >= w - 0.01 || lng <= e + 0.01;
    return inLng && geoContains(poly, [lng, lat]);
  });

test('decorations decode to known glyphs, sorted by level of detail', () => {
  assert.ok(glyphs.length > 1000, 'there are decorations');
  assert.deepEqual(file.kinds, [...DECORATION_KINDS]);
  assert.deepEqual(file.levelDeg, [...LEVEL_DEG]);
  for (const g of glyphs) {
    assert.ok(GLYPHS.some((s) => s.kind === g.kind && s.variant === g.variant), `${g.kind} ${g.variant} exists`);
    assert.ok(g.level >= 0 && g.level < LEVEL_DEG.length && g.scale > 0.5 && g.scale < 1.5, `${g.kind} at ${g.lng},${g.lat}`);
  }
  for (let i = 1; i < glyphs.length; i++) assert.ok(glyphs[i].level >= glyphs[i - 1].level, 'sorted by level, so each level of detail is a prefix');
  for (const kind of DECORATION_KINDS) assert.ok(glyphs.some((g) => g.kind === kind), `some ${kind} placed`);
});

test('no glyph is placed in the wrong medium: land glyphs on land (not in lakes), sea glyphs at sea', () => {
  const land = polygons('land');
  const lakes = polygons('lakes');
  const wrong: string[] = [];
  for (const g of glyphs) {
    const onLand = inAny(land, g.lng, g.lat);
    if (LAND_KINDS.has(g.kind)) {
      if (!onLand) wrong.push(`${g.kind} at sea at ${g.lng},${g.lat}`);
      else if (inAny(lakes, g.lng, g.lat)) wrong.push(`${g.kind} in a lake at ${g.lng},${g.lat}`);
    } else if (onLand) {
      wrong.push(`${g.kind} on land at ${g.lng},${g.lat}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test(`ships keep at least ${SHIP_COAST_KM} km from any coast`, () => {
  // Coastlines as unit vectors every ~5 km.
  const coast: number[] = [];
  const push = ([lng, lat]: [number, number]) => coast.push(...unitOf(lng, lat));
  for (const f of fc<MultiLineString>('coast').features)
    for (const line of f.geometry.coordinates) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i] as [number, number];
        const b = line[i + 1] as [number, number];
        const n = Math.max(1, Math.ceil((geoDistance(a, b) * 6371) / 5));
        const lerp = geoInterpolate(a, b);
        for (let k = 0; k < n; k++) push(lerp(k / n));
      }
      push(line[line.length - 1] as [number, number]);
    }
  const ships = glyphs.filter((g) => g.kind === 'ship');
  assert.ok(ships.length >= 10, 'there are ships');
  for (const s of ships) {
    const [x, y, z] = unitOf(s.lng, s.lat);
    let best = -1;
    for (let i = 0; i < coast.length; i += 3) best = Math.max(best, x * coast[i] + y * coast[i + 1] + z * coast[i + 2]);
    const km = Math.acos(Math.min(1, best)) * 6371;
    assert.ok(km >= SHIP_COAST_KM, `ship at ${s.lng},${s.lat} is ${km.toFixed(0)} km from the coast`);
  }
});

test('no two glyphs shown together are closer than their spacing', () => {
  const v = glyphs.map((g) => unitOf(g.lng, g.lat));
  // The widest spacing among everything but ships and monsters, with a margin.
  const widest = Math.max(...DECORATION_KINDS.filter((k) => k !== 'ship' && k !== 'serpent' && k !== 'whale').map((k) => minSeparationDeg(k, 0, k, 0)));
  const NEAR = Math.cos(((widest + 1) * Math.PI) / 180);
  const tooClose: string[] = [];
  for (let i = 0; i < glyphs.length; i++) {
    for (let j = i + 1; j < glyphs.length; j++) {
      const dot = v[i][0] * v[j][0] + v[i][1] * v[j][1] + v[i][2] * v[j][2];
      if (dot < NEAR) continue; // further apart than any spacing but a ship's or a monster's
      const a = glyphs[i];
      const b = glyphs[j];
      const deg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
      if (deg < minSeparationDeg(a.kind, a.level, b.kind, b.level) - 0.01) tooClose.push(`${a.kind} ${a.lng},${a.lat} – ${b.kind} ${b.lng},${b.lat}`);
    }
  }
  // Ships and sea monsters keep wider berths than 8°: check them against everything.
  for (let i = 0; i < glyphs.length; i++) {
    const a = glyphs[i];
    if (a.kind !== 'ship' && a.kind !== 'serpent' && a.kind !== 'whale') continue;
    for (let j = 0; j < glyphs.length; j++) {
      if (i === j) continue;
      const b = glyphs[j];
      const deg = (geoDistance([a.lng, a.lat], [b.lng, b.lat]) * 180) / Math.PI;
      if (deg < minSeparationDeg(a.kind, a.level, b.kind, b.level) - 0.01) tooClose.push(`${a.kind} ${a.lng},${a.lat} – ${b.kind} ${b.lng},${b.lat}`);
    }
  }
  assert.deepEqual(tooClose, []);
});

test('levels of detail open up only once glyphs have room, more of them the closer you zoom', () => {
  let shown = 0;
  for (let R = 60; R <= 60000; R *= 1.07) {
    const { size, alpha } = levelOfDetail(R);
    assert.ok(size > 0 && size <= 1.2, `size ${size} at R ${R.toFixed(0)}`);
    assert.equal(alpha[0], 1, 'the sparsest level is always drawn');
    for (let level = 0; level < LEVEL_DEG.length; level++) {
      if (level > 0) assert.ok(alpha[level] <= alpha[level - 1], 'finer levels never show before coarser ones');
      // Any level drawn keeps one spacing apart at least DECOR_SPACING_PX × size on screen.
      if (alpha[level] > 0) assert.ok(LEVEL_DEG[level] * (Math.PI / 180) * R >= DECOR_SPACING_PX * size - 1e-9, `level ${level} too tight at R ${R.toFixed(0)}`);
    }
    const n = alpha.filter((a) => a > 0).length;
    assert.ok(n >= shown, 'zooming in never takes levels away');
    shown = n;
  }
  assert.equal(shown, LEVEL_DEG.length, 'every level shows when zoomed in far enough');
  assert.equal(levelOfDetail(160).alpha.filter((a) => a > 0).length, 1, 'a phone-sized whole globe shows only the sparsest level');
});
