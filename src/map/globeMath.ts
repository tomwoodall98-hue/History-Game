/**
 * The globe's geometry and gesture rules, kept free of the DOM so they can
 * be tested: screen points to longitude/latitude, tap versus drag, how a drag
 * or a zoom turns the globe, inertia, and the view that frames some points.
 *
 * Rotation follows d3's convention: [λ, φ] puts the point (−λ, −φ) at the
 * centre of the view. The globe never rolls, so north stays up.
 */
import { geoDistance, geoInterpolate, type GeoProjection } from 'd3-geo';

export type LngLat = [number, number];
export type Rotation = [number, number];

const DEG = 180 / Math.PI;

/** The point at the centre of the view for a rotation. */
export const centreOf = (r: Rotation): LngLat => [wrapLng(-r[0]), -r[1]];
/** The rotation that puts a point at the centre of the view. */
export const rotationFor = (p: LngLat): Rotation => [-p[0], -p[1]];

export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * The longitude/latitude under a screen point, or null when the point is off
 * the globe (beyond its rim). `projection` is an orthographic projection
 * clipped at 90°.
 */
export function screenToLngLat(projection: GeoProjection, point: [number, number]): LngLat | null {
  const [cx, cy] = projection.translate();
  const r = projection.scale();
  const dx = point[0] - cx;
  const dy = point[1] - cy;
  if (!(r > 0) || dx * dx + dy * dy > r * r) return null;
  const ll = projection.invert?.(point);
  if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
  return [wrapLng(ll[0]), Math.max(-90, Math.min(90, ll[1]))];
}

/** True when a point is on the side of the globe facing the viewer. */
export function isFacing(rotation: Rotation, p: LngLat, margin = 0): boolean {
  return geoDistance(centreOf(rotation), p) < Math.PI / 2 - margin;
}

// ------------------------------------------------------------- gestures ---

/** How far (CSS px) a press may travel and still count as a tap. */
export const TAP_SLOP = { mouse: 5, pen: 8, touch: 10 } as const;
export type PointerKind = keyof typeof TAP_SLOP;

/**
 * Follows one press from pointer-down to pointer-up and says whether it was
 * a tap (place a mark) or not. A press is never a tap if it moved further
 * than the slop for its pointer type, if a second finger came down (a pinch),
 * or if it landed on a spinning globe (that press just stops the spin).
 */
export class PressTracker {
  private startX = 0;
  private startY = 0;
  private kind: PointerKind = 'mouse';
  private moved = 0;
  private active = false;
  private disqualified = false;
  pointers = 0;

  down(x: number, y: number, kind: string, spinning = false): void {
    this.pointers++;
    if (this.pointers > 1) {
      this.disqualified = true; // a second finger: a pinch
      return;
    }
    this.active = true;
    this.disqualified = spinning;
    this.kind = kind === 'touch' || kind === 'pen' ? kind : 'mouse';
    this.startX = x;
    this.startY = y;
    this.moved = 0;
  }

  /** Records movement; returns true once the press has become a drag. */
  move(x: number, y: number): boolean {
    if (!this.active) return false;
    this.moved = Math.max(this.moved, Math.hypot(x - this.startX, y - this.startY));
    return this.isDrag;
  }

  get isDrag(): boolean {
    return this.moved > TAP_SLOP[this.kind];
  }

  /** On pointer-up: true if the press was a tap. */
  up(x: number, y: number): boolean {
    this.move(x, y);
    this.pointers = Math.max(0, this.pointers - 1);
    const tap = this.active && !this.disqualified && !this.isDrag && this.pointers === 0;
    if (this.pointers === 0) this.active = false;
    return tap;
  }

  cancel(): void {
    this.pointers = Math.max(0, this.pointers - 1);
    this.disqualified = true;
    if (this.pointers === 0) this.active = false;
  }
}

// ------------------------------------------------------------- movement ---

/** Degrees of longitude per screen pixel at the centre, allowing for latitude. */
const lngPerPx = (r: Rotation, scale: number) => DEG / (scale * Math.max(0.25, Math.cos(r[1] / DEG)));

/**
 * The rotation after dragging by (dx, dy) screen pixels: the point under the
 * finger stays under it (exactly at the centre, closely elsewhere), and the
 * poles stop the globe tipping over.
 */
export function dragRotation(r: Rotation, dx: number, dy: number, scale: number): Rotation {
  return [r[0] + dx * lngPerPx(r, scale), clampLat(r[1] - (dy * DEG) / scale)];
}

/**
 * The rotation that keeps the point under (dx, dy) — measured from the view
 * centre — in place while the scale changes from `from` to `to`.
 */
export function zoomRotation(r: Rotation, dx: number, dy: number, from: number, to: number): Rotation {
  const k = 1 - from / to; // the fraction of the offset the centre moves by
  return [r[0] - dx * k * lngPerPx(r, from), clampLat(r[1] + (dy * k * DEG) / from)];
}

const clampLat = (phi: number) => Math.max(-90, Math.min(90, phi));

/** Inertia: velocity after `dt` ms of friction (time constant `tau` ms). */
export function decay(velocity: number, dt: number, tau = 320): number {
  return velocity * Math.exp(-dt / tau);
}

// ---------------------------------------------------------------- views ---

export interface View {
  rotation: Rotation;
  scale: number;
}

/** The point midway along the great circle(s) through some points: their mean direction. */
export function centreOfPoints(points: LngLat[]): LngLat {
  if (points.length === 1) return points[0];
  if (points.length === 2) return geoInterpolate(points[0], points[1])(0.5) as LngLat;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [lng, lat] of points) {
    const l = lng / DEG;
    const p = lat / DEG;
    x += Math.cos(p) * Math.cos(l);
    y += Math.cos(p) * Math.sin(l);
    z += Math.sin(p);
  }
  const n = Math.hypot(x, y, z);
  if (n < 1e-9) return points[0];
  return [Math.atan2(y, x) * DEG, Math.asin(z / n) * DEG];
}

/**
 * The view that shows all the points inside a circle of `radius` px, turned
 * to face their centre: as close as `maxScale` allows, never smaller than
 * `minScale` (the whole globe). `pad` keeps markers clear of the rim (radians).
 */
export function viewForPoints(points: LngLat[], radius: number, minScale: number, maxScale: number, pad = 0.12): View {
  const centre = centreOfPoints(points);
  const spread = Math.max(0, ...points.map((p) => geoDistance(centre, p)));
  const angle = Math.min(Math.PI / 2, spread + pad);
  const scale = Math.max(minScale, Math.min(maxScale, radius / Math.sin(angle)));
  return { rotation: rotationFor(centre), scale };
}
