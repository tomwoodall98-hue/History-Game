/**
 * A fast orthographic projector for drawing the globe. Geometry is turned
 * into unit vectors once; each frame then costs a few multiplications per
 * point, against several times that through d3's general stream pipeline
 * with spherical clipping (checked pixel for pixel against d3 over 150
 * random views; d3 still projects the markers and the route).
 *
 * Matches d3.geoOrthographic().rotate([λ, φ]).scale(R).translate([cx, cy])
 * (no roll). Lines are cut where they pass over the rim, at the exact
 * crossing. Polygons that cross the rim are closed along it by pressing
 * their hidden points onto the rim, which traces the visible part exactly.
 * One case needs care: a polygon that wraps round the point directly behind
 * the globe (the antipode of the view centre) winds once round the whole rim
 * when pressed, so it gets a reversed rim circle that cancels everything but
 * its visible part.
 */
import { geoContains, type GeoPermissibleObjects } from 'd3-geo';
import type { Geometry, Polygon, Position } from 'geojson';

/** Points as unit vectors [x, y, z, x, y, z, …] for λ = 0. */
export type Prepared = Float64Array[];

/** A polygon's rings as unit vectors, with its coordinates for the antipode test. */
export interface PreparedPolygon {
  rings: Float64Array[];
  geometry: Polygon;
}

export interface FastView {
  cl: number;
  sl: number;
  cp: number;
  sp: number;
  R: number;
  cx: number;
  cy: number;
}

/** The subset of CanvasRenderingContext2D / Path2D used for drawing. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

const RAD = Math.PI / 180;

export function fastView(rotation: [number, number], R: number, cx: number, cy: number): FastView {
  const l = rotation[0] * RAD;
  const p = rotation[1] * RAD;
  return { cl: Math.cos(l), sl: Math.sin(l), cp: Math.cos(p), sp: Math.sin(p), R, cx, cy };
}

function toVectors(coords: Position[]): Float64Array {
  const out = new Float64Array(coords.length * 3);
  coords.forEach(([lng, lat], i) => {
    const cl = Math.cos(lat * RAD);
    out[i * 3] = cl * Math.cos(lng * RAD);
    out[i * 3 + 1] = cl * Math.sin(lng * RAD);
    out[i * 3 + 2] = Math.sin(lat * RAD);
  });
  return out;
}

function geometries(o: GeoPermissibleObjects): Geometry[] {
  const any = o as { type: string; features?: { geometry: Geometry | null }[]; geometry?: Geometry | null; geometries?: Geometry[] };
  if (any.type === 'FeatureCollection') return (any.features ?? []).flatMap((f) => (f.geometry ? geometries(f.geometry) : []));
  if (any.type === 'Feature') return any.geometry ? geometries(any.geometry) : [];
  if (any.type === 'GeometryCollection') return (any.geometries ?? []).flatMap(geometries);
  return [o as Geometry];
}

/** Every line and ring in a GeoJSON object, as unit vectors. */
export function prepare(o: GeoPermissibleObjects): Prepared {
  const out: Prepared = [];
  for (const g of geometries(o)) {
    if (g.type === 'LineString') out.push(toVectors(g.coordinates));
    else if (g.type === 'MultiLineString' || g.type === 'Polygon') for (const l of g.coordinates) out.push(toVectors(l));
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates) for (const r of p) out.push(toVectors(r));
  }
  return out;
}

/** Every polygon in a GeoJSON object, ready for fast filling. */
export function preparePolygons(o: GeoPermissibleObjects): PreparedPolygon[] {
  const out: PreparedPolygon[] = [];
  for (const g of geometries(o)) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const coordinates of polys) out.push({ rings: coordinates.map(toVectors), geometry: { type: 'Polygon', coordinates } });
  }
  return out;
}

/**
 * Projects one point. Returns screen x, y and the depth d (> 0 on the side
 * facing the viewer), written into `out`.
 */
export function projectInto(v: FastView, a: Float64Array, i: number, out: Float64Array): void {
  const x0 = a[i];
  const y0 = a[i + 1];
  const z = a[i + 2];
  const x = x0 * v.cl - y0 * v.sl;
  const y = x0 * v.sl + y0 * v.cl;
  out[0] = v.cx + v.R * y;
  out[1] = v.cy - v.R * (z * v.cp + x * v.sp);
  out[2] = x * v.cp - z * v.sp;
}

const P = new Float64Array(3);
const Q = new Float64Array(3);

/** Where the segment from P to Q crosses the rim (P and Q on opposite sides). */
function rimCrossing(v: FastView, p: Float64Array, q: Float64Array): [number, number] {
  const t = p[2] / (p[2] - q[2]);
  const x = p[0] + (q[0] - p[0]) * t - v.cx;
  const y = p[1] + (q[1] - p[1]) * t - v.cy;
  const k = v.R / (Math.hypot(x, y) || 1);
  return [v.cx + x * k, v.cy + y * k];
}

/** Traces lines, cut at the rim. */
export function traceLines(sink: PathSink, lines: Prepared, v: FastView): void {
  for (const a of lines) {
    let open = false;
    for (let i = 0; i < a.length; i += 3) {
      projectInto(v, a, i, Q);
      if (Q[2] > 0) {
        if (!open) {
          if (i > 0 && P[2] <= 0) {
            const [x, y] = rimCrossing(v, P, Q);
            sink.moveTo(x, y);
            sink.lineTo(Q[0], Q[1]);
          } else sink.moveTo(Q[0], Q[1]);
          open = true;
        } else sink.lineTo(Q[0], Q[1]);
      } else if (open) {
        const [x, y] = rimCrossing(v, P, Q);
        sink.lineTo(x, y);
        open = false;
      }
      P.set(Q);
    }
  }
}

/**
 * Traces polygons for filling (nonzero rule). Rings wholly on the far side
 * are skipped; rings that cross the rim have their hidden stretch pressed
 * onto it, stepping round the rim where that stretch sweeps a long way.
 * `antipode` is the [lng, lat] directly behind the view centre.
 */
export function tracePolygons(sink: PathSink & { arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void }, polys: PreparedPolygon[], v: FastView, antipode: [number, number]): void {
  for (const poly of polys) {
    let winding = 0;
    poly.rings.forEach((a, ringIndex) => {
      const n = a.length / 3;
      let visible = 0;
      for (let i = 0; i < a.length; i += 3) if (a[i] * v.cl * v.cp - a[i + 1] * v.sl * v.cp - a[i + 2] * v.sp > 0) visible++;
      if (!visible) return;
      let lastRim = NaN;
      let lastAngle = NaN;
      let turn = 0;
      for (let k = 0; k < n; k++) {
        projectInto(v, a, k * 3, Q);
        let x = Q[0];
        let y = Q[1];
        const ang = Math.atan2(y - v.cy, x - v.cx);
        if (Q[2] <= 0 && visible < n) {
          if (!Number.isNaN(lastRim)) {
            const d = wrapAngle(ang - lastRim);
            const steps = Math.floor(Math.abs(d) / 0.15);
            for (let s = 1; s <= steps; s++) {
              const t = lastRim + (d * s) / (steps + 1);
              sink.lineTo(v.cx + Math.cos(t) * v.R, v.cy + Math.sin(t) * v.R);
            }
          }
          x = v.cx + Math.cos(ang) * v.R;
          y = v.cy + Math.sin(ang) * v.R;
          lastRim = ang;
        } else lastRim = NaN;
        if (ringIndex === 0 && !Number.isNaN(lastAngle)) turn += wrapAngle(ang - lastAngle);
        lastAngle = ang;
        if (k === 0) sink.moveTo(x, y);
        else sink.lineTo(x, y);
      }
      sink.closePath();
      if (ringIndex === 0) winding = Math.round(turn / (2 * Math.PI));
    });
    // Wound once round the rim: the polygon holds either the view centre
    // (drawn right as it is) or the antipode (cancel all but its visible part).
    if (winding !== 0 && geoContains(poly.geometry, antipode)) {
      sink.moveTo(v.cx + v.R, v.cy);
      sink.arc(v.cx, v.cy, v.R, 0, winding > 0 ? -2 * Math.PI : 2 * Math.PI, winding > 0);
      sink.closePath();
    }
  }
}

function wrapAngle(d: number): number {
  if (d > Math.PI) return d - 2 * Math.PI;
  if (d < -Math.PI) return d + 2 * Math.PI;
  return d;
}
