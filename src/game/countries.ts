/**
 * Which modern country a point is in, for the same-country floor in scoring.
 *
 * The outlines (src/data/countries.topo.json, built by `npm run
 * build:countries` from Natural Earth admin-0) are for scoring only. They are
 * never drawn: nothing in src/map imports this module or its data (a test
 * checks), and a lookup returns a country's code and size, never its shape.
 */
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { LngLat } from './types';

export interface Country {
  /** Natural Earth ADM0_A3 code, e.g. "FRA". Never shown to players. */
  code: string;
  /** Equivalent radius √(area/π) of the whole country, km. */
  radiusKm: number;
}

export interface CountryLookup {
  /** The country at a point, or null at sea (allowing COAST_TOLERANCE_KM of slack). */
  countryAt(point: LngLat): Country | null;
  /** A country by its code, or null if the outlines don't have it. */
  byCode(code: string): Country | null;
}

/**
 * A mark this close to a country still counts as in it, so a click on a beach,
 * or an answer in a harbour or a river, isn't "at sea" just because outlines
 * are generalised.
 */
export const COAST_TOLERANCE_KM = 10;

interface Part {
  country: Country;
  /** Rings as flat [lng, lat, lng, lat, …] arrays; the first is the outer ring. */
  rings: Float64Array[];
  bbox: [number, number, number, number];
}

const RAD = Math.PI / 180;
const cellKey = (lng: number, lat: number) => (Math.floor(lat) + 90) * 400 + (Math.floor(lng) + 180);

/** Point-in-polygon lookups over the country outlines, bucketed on a 1° grid. */
export class CountryIndex implements CountryLookup {
  private readonly grid = new Map<number, Part[]>();
  private readonly codes = new Map<string, Country>();

  constructor(topo: Topology) {
    const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon, { a3: string; r: number }>;
    for (const f of fc.features) {
      if (!f.geometry) continue;
      const country: Country = { code: f.properties.a3, radiusKm: f.properties.r };
      this.codes.set(country.code, country);
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        let x0 = 180;
        let y0 = 90;
        let x1 = -180;
        let y1 = -90;
        for (const [x, y] of poly[0]) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
        const part: Part = { country, rings: poly.map((ring) => Float64Array.from(ring.flat())), bbox: [x0, y0, x1, y1] };
        for (let gy = Math.floor(y0); gy <= Math.floor(y1); gy++) {
          for (let gx = Math.floor(x0); gx <= Math.floor(x1); gx++) {
            const key = cellKey(gx, gy);
            const list = this.grid.get(key);
            if (list) list.push(part);
            else this.grid.set(key, [part]);
          }
        }
      }
    }
  }

  byCode(code: string): Country | null {
    return this.codes.get(code) ?? null;
  }

  countryAt([lng, lat]: LngLat): Country | null {
    const hit = this.exact(lng, lat);
    if (hit) return hit;
    // Probe a ring of points COAST_TOLERANCE_KM away.
    const dLat = COAST_TOLERANCE_KM / 111.2;
    const dLng = dLat / Math.max(0.2, Math.cos(lat * RAD));
    for (const [sx, sy] of PROBES) {
      const found = this.exact(lng + sx * dLng, lat + sy * dLat);
      if (found) return found;
    }
    return null;
  }

  private exact(lng: number, lat: number): Country | null {
    if (lat < -90 || lat > 90) return null;
    const x = ((((lng + 180) % 360) + 360) % 360) - 180;
    for (const part of this.grid.get(cellKey(x, lat)) ?? []) if (inside(part, x, lat)) return part.country;
    return null;
  }
}

const D = Math.SQRT1_2;
const PROBES: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [D, D],
  [-D, -D],
  [D, -D],
  [-D, D],
];

/** Even-odd ray casting in plain lng/lat, as Natural Earth's outlines are drawn. */
function inside(part: Part, x: number, y: number): boolean {
  const [x0, y0, x1, y1] = part.bbox;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  let result = false;
  for (const r of part.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i];
      const yi = r[i + 1];
      const xj = r[j];
      const yj = r[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
    }
  }
  return result;
}
