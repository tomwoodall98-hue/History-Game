/**
 * The playing surface: a Victorian library globe, drawn on a <canvas> with
 * d3's orthographic projection and turned by hand.
 *
 *   - Geometry is plain longitude/latitude (globeData.ts), projected afresh
 *     each frame. While the globe moves it draws lighter geometry and skips
 *     the costly effects (water-lining, rivers, craquelure), then redraws in
 *     full once it settles.
 *   - Markers, the route and the keyboard crosshair live in an SVG overlay,
 *     repositioned every frame and hidden when they turn to the far side.
 *   - The brass meridian ring and the wooden horizon ring and stand are drawn
 *     around the globe; they scale with zoom but never rotate.
 *
 * Gestures, screen-to-globe conversion and view fitting are in globeMath.ts.
 */
import { geoGraticule, geoInterpolate, geoOrthographic, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { Feature, FeatureCollection, MultiLineString } from 'geojson';
import { guessMarkerMarkup, sealMarkerMarkup } from './ornaments';
import { mulberry32 } from '../game/schedule';
import { fastView, prepare, preparePolygons, traceLines, tracePolygons, type Prepared, type PreparedPolygon } from './fastOrtho';
import { CELL_COLS, CELL_DEG, CELL_ROWS, cellBounds, cellId, type GlobeBase } from './globeData';
import {
  PressTracker,
  centreOf,
  decay,
  dragRotation,
  isFacing,
  rotationFor,
  screenToLngLat,
  viewForPoints,
  zoomRotation,
  type LngLat,
  type Rotation,
  type View,
} from './globeMath';

export type { LngLat };
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Colours of the printed gores (kept in step with main.css). */
export const PALETTE = {
  sea: '#bccbc0',
  land: '#efdfb4',
  ink: '#33220f',
  river: '#46606a',
  graticule: '#5b4128',
};

/** Deepest zoom: about 100 m per CSS pixel at the centre of the view. */
const MAX_SCALE_PX = 60_000;
/** Above this scale (px) the 1:10m detail tiles take over from the base. */
const DETAIL_SCALE = 2_400;
/** Below this many times the whole-globe scale, frames drawn in motion use the coarse land. */
const COARSE_BELOW_ZOOM = 3;
/** Gap and width of the brass meridian ring around the globe, px. */
const RING_GAP = 6;
const RING_WIDTH = 11;
/** Water-lining: ripple lines at these distances (px) offshore. */
const RIPPLES = [
  { dist: 2.4, alpha: 0.62 },
  { dist: 5.2, alpha: 0.48 },
  { dist: 8.5, alpha: 0.32 },
  { dist: 12.3, alpha: 0.18 },
];

interface Layers {
  /** Everything as unit vectors for the fast projector (see fastOrtho.ts). */
  fast: {
    land: PreparedPolygon[];
    lakes: PreparedPolygon[];
    coast: Prepared;
    shores: Prepared;
    /** Rivers by weight: major, middling, minor. */
    rivers: Prepared[];
  };
}

function decodeLayers(topo: Topology, names: { land: string; coast: string; lakes?: string; shores?: string; rivers?: string }): Layers {
  const fc = (name?: string) =>
    name && topo.objects[name] ? (feature(topo as never, topo.objects[name] as never) as unknown as FeatureCollection) : null;
  const one = (name?: string): GeoPermissibleObjects => fc(name) ?? { type: 'FeatureCollection', features: [] };
  const riversFc = fc(names.rivers);
  const rivers = [1, 2, 3].map(
    (r): GeoPermissibleObjects => ({
      type: 'FeatureCollection',
      features: (riversFc?.features ?? []).filter((f: Feature) => f.properties?.r === r),
    }),
  );
  const land = one(names.land);
  const lakes = one(names.lakes);
  return {
    fast: { land: preparePolygons(land), lakes: preparePolygons(lakes), coast: prepare(one(names.coast)), shores: prepare(one(names.shores)), rivers: rivers.map(prepare) },
  };
}

/** Hairline cracks in the varnish, as short random walks on the sphere (fixed seed). */
function craquelure(): MultiLineString {
  const rand = mulberry32(1851);
  const lines: [number, number][][] = [];
  for (let i = 0; i < 700; i++) {
    let lng = rand() * 360 - 180;
    let lat = (Math.asin(rand() * 2 - 1) * 180) / Math.PI;
    let heading = rand() * Math.PI * 2;
    const line: [number, number][] = [[lng, lat]];
    const steps = 3 + Math.floor(rand() * 6);
    for (let s = 0; s < steps; s++) {
      heading += (rand() - 0.5) * 1.4;
      const len = 0.5 + rand() * 1.3;
      lat = Math.max(-89, Math.min(89, lat + Math.sin(heading) * len));
      lng += (Math.cos(heading) * len) / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      line.push([lng, lat]);
    }
    lines.push(line);
  }
  return { type: 'MultiLineString', coordinates: lines };
}

/** Gore seams every 30° between the polar calottes, and the calottes' edges at ±70°. */
function goreSeams(): MultiLineString {
  const seams: [number, number][][] = [];
  for (let lng = -180; lng < 180; lng += 30) seams.push(Array.from({ length: 29 }, (_, i) => [lng, -70 + i * 5] as [number, number]));
  for (const lat of [70, -70]) seams.push(Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat] as [number, number]));
  return { type: 'MultiLineString', coordinates: seams };
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface Flight {
  from: View;
  to: View;
  start: number;
  duration: number;
  resolve: () => void;
}

interface Tile {
  layers: Layers | null;
  loading: boolean;
  failed: boolean;
}

export class GlobeView {
  /** The focusable element that holds the globe. */
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly overlay: SVGSVGElement;
  private readonly projection = geoOrthographic().clipAngle(90).precision(0);
  private readonly path = geoPath(this.projection);

  private base: Layers | null = null;
  private coarse: Layers | null = null;
  private grid: GlobeBase['grid'] | null = null;
  private readonly tiles = new Map<string, Tile>();
  private readonly graticule = prepare(geoGraticule().step([15, 15]).precision(3).extentMinor([[-180, -75], [180, 75.001]])());
  private readonly seams = prepare(goreSeams());
  private readonly cracks = prepare(craquelure());

  private width = 0;
  private height = 0;
  private dpr = 1;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Whole-globe scale and centre for the current insets. */
  private fit = { scale: 100, cx: 0, cy: 0 };
  private rotation: Rotation = [-15, -22];
  private scale = 100;

  // Motion.
  private flight: Flight | null = null;
  private flightDone: Promise<void> = Promise.resolve();
  private velocity: [number, number] = [0, 0];
  private samples: { t: number; r: Rotation }[] = [];
  private moving = false;
  private restTimer = 0;
  private loopRunning = false;
  private frameQueued = false;

  // Input.
  private readonly press = new PressTracker();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; scale: number; mid: [number, number] } | null = null;
  private pickHandler: ((p: LngLat) => void) | null = null;
  private pickEnabled = false;

  // Markers.
  private guess: LngLat | null = null;
  private answer: LngLat | null = null;
  private route: { from: LngLat; to: LngLat; u: number } | null = null;
  private guessEl!: SVGGElement;
  private sealEl!: SVGGElement;
  private routeEl!: SVGPathElement;
  private routeShadowEl!: SVGPathElement;
  private crosshairEl!: SVGGElement;
  private reviewG!: SVGGElement;
  private review: { guess: LngLat | null; answer: LngLat; g: SVGGElement }[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly tileBaseUrl: string,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'globe';
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'application');
    this.element.setAttribute('aria-roledescription', 'globe');
    this.element.setAttribute(
      'aria-label',
      'Globe. Drag or use the arrow keys to turn it; scroll, pinch or press plus and minus to zoom. Click or tap to mark your guess, or press Space to mark the centre of the view.',
    );
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'globe-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.overlay = el('svg', { class: 'globe-overlay', 'aria-hidden': 'true' });
    this.element.append(this.canvas, this.overlay);
    container.appendChild(this.element);
    this.buildOverlay();

    new ResizeObserver(() => this.resize()).observe(container);
    this.element.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.element.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.element.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.element.addEventListener('pointercancel', (e) => this.onPointerCancel(e));
    this.element.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.element.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Decodes the base map and draws the globe. */
  render(base: GlobeBase): void {
    this.grid = base.grid;
    this.coarse = decodeLayers(base, { land: 'coarseLand', coast: 'coarseCoast' });
    this.base = decodeLayers(base, { land: 'land', coast: 'coast', lakes: 'lakes', shores: 'shores', rivers: 'rivers' });
    this.resize();
  }

  // ------------------------------------------------------------ layout ---

  setInsets(insets: Partial<Insets>): void {
    const next = { ...this.insets, ...insets };
    if ((Object.keys(next) as (keyof Insets)[]).every((k) => Math.abs(next[k] - this.insets[k]) < 0.5)) return;
    this.insets = next;
    this.layout();
  }

  /** Whole-globe scale and centre for some insets: the globe and its brass ring fill the free area. */
  private fitFor(insets: Insets): { scale: number; cx: number; cy: number } {
    const x0 = insets.left;
    const y0 = insets.top;
    const x1 = Math.max(x0 + 80, this.width - insets.right);
    const y1 = Math.max(y0 + 80, this.height - insets.bottom);
    const margin = RING_GAP + RING_WIDTH + Math.min(14, (x1 - x0) * 0.03);
    return { scale: Math.max(40, Math.min(x1 - x0, y1 - y0) / 2 - margin), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  /** Where the whole-globe view (with its ring) would sit for some insets, in page coordinates. */
  fitRectFor(insets: Partial<Insets>): { left: number; top: number; right: number; bottom: number } {
    const f = this.fitFor({ ...this.insets, ...insets });
    const r = this.element.getBoundingClientRect();
    const R = f.scale + RING_GAP + RING_WIDTH;
    return { left: r.left + f.cx - R, top: r.top + f.cy - R, right: r.left + f.cx + R, bottom: r.top + f.cy + R };
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.overlay.setAttribute('width', String(this.width));
    this.overlay.setAttribute('height', String(this.height));
    this.layout();
  }

  /** Recentres the globe for the current size and insets, keeping the zoom level. */
  private layout(): void {
    if (!this.width) return;
    const zoom = this.scale / this.fit.scale;
    this.fit = this.fitFor(this.insets);
    if (!this.flight) this.scale = this.clampScale(this.fit.scale * (Number.isFinite(zoom) ? zoom : 1));
    this.invalidate();
  }

  private clampScale(s: number): number {
    return Math.max(this.fit.scale, Math.min(MAX_SCALE_PX, s));
  }

  private applyProjection(): void {
    this.projection
      .rotate(this.rotation)
      .scale(this.scale)
      .translate([this.fit.cx, this.fit.cy])
      .clipExtent([
        [-4, -4],
        [this.width + 4, this.height + 4],
      ]);
  }

  // ------------------------------------------------------------ drawing ---

  /** Draws on the next animation frame (once, however often it is asked). */
  private invalidate(): void {
    if (this.loopRunning || this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      this.draw();
    });
  }

  /** Marks the globe as moving: light frames now, a full redraw shortly after it stops. */
  private markMoving(): void {
    this.moving = true;
    window.clearTimeout(this.restTimer);
    this.restTimer = window.setTimeout(() => {
      if (this.flight || this.speed() > 0) return this.markMoving();
      this.moving = false;
      this.invalidate();
    }, 140);
  }

  private draw(): void {
    if (!this.base || !this.width) return;
    this.applyProjection();
    const ctx = this.ctx;
    const { cx, cy } = this.fit;
    const R = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const decorated = R < Math.hypot(this.width, this.height); // rings still in view

    if (decorated) this.drawStand(ctx, cx, cy, R, 'back');

    // The sphere: everything below is clipped to it.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.clip();
    ctx.fillStyle = PALETTE.sea;
    ctx.fillRect(0, 0, this.width, this.height);

    const layers = this.pickLayers();
    const full = !this.moving;
    const v = fastView(this.rotation, R, cx, cy);
    const centre = centreOf(this.rotation);
    const antipode: LngLat = [centre[0] + 180, -centre[1]];
    const fill = (pick: (l: Layers) => PreparedPolygon[]) => {
      ctx.beginPath();
      for (const l of layers) tracePolygons(ctx, pick(l), v, antipode);
      ctx.fill();
    };
    const lines = (pick: (l: Layers) => Prepared) => {
      ctx.beginPath();
      for (const l of layers) traceLines(ctx, pick(l), v);
      ctx.stroke();
    };
    const coast = new Path2D();
    for (const l of layers) traceLines(coast, l.fast.coast, v);

    // Water-lining: ripples ruled offshore, drawn as wide coast strokes cut
    // back with sea colour, outermost first; the land fill then covers the
    // inland half of each.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (full) {
      const k = Math.max(0.45, Math.min(1, R / 380));
      for (let i = RIPPLES.length - 1; i >= 0; i--) {
        const { dist, alpha } = RIPPLES[i];
        const d = dist * k;
        ctx.strokeStyle = `rgba(51,34,15,${alpha})`;
        ctx.lineWidth = 2 * d + 0.9;
        ctx.stroke(coast);
        ctx.strokeStyle = PALETTE.sea;
        ctx.lineWidth = Math.max(0.1, 2 * d - 0.9);
        ctx.stroke(coast);
      }
    }

    ctx.fillStyle = PALETTE.land;
    fill((l) => l.fast.land);
    ctx.fillStyle = PALETTE.sea;
    fill((l) => l.fast.lakes);

    // Unlabelled graticule, then the gore seams of the printed paper.
    ctx.strokeStyle = 'rgba(91,65,40,0.32)';
    ctx.lineWidth = 0.6;
    ctx.setLineDash([2, 2.5]);
    ctx.beginPath();
    traceLines(ctx, this.graticule, v);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(91,65,40,0.38)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    traceLines(ctx, this.seams, v);
    ctx.stroke();

    if (full) {
      ctx.strokeStyle = PALETTE.river;
      [1.05, 0.75, 0.5].forEach((w, i) => {
        ctx.lineWidth = w;
        lines((l) => l.fast.rivers[i]);
      });
      ctx.strokeStyle = PALETTE.ink;
      ctx.lineWidth = 0.6;
      lines((l) => l.fast.shores);
    }
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = R > 2000 ? 1.4 : 1.1;
    ctx.stroke(coast);

    if (full) {
      // Craquelure in the varnish: it turns with the globe.
      ctx.strokeStyle = 'rgba(70,45,20,0.16)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      traceLines(ctx, this.cracks, v);
      ctx.stroke();
    }

    this.drawShading(ctx, cx, cy, R);
    ctx.restore();

    // The limb, in ink.
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();

    if (decorated) {
      this.drawMeridianRing(ctx, cx, cy, R);
      this.drawStand(ctx, cx, cy, R, 'front');
    }
    this.updateOverlay();
  }

  /** Which geometry to draw: coarse in motion when zoomed out, detail tiles when zoomed in. */
  private pickLayers(): Layers[] {
    const zoom = this.scale / this.fit.scale;
    if (this.scale >= DETAIL_SCALE && this.grid) {
      const ids = this.visibleCells();
      const ready = ids.map((id) => this.tile(id));
      if (ready.every((t) => t === null || t.layers || t.failed)) {
        return ready.flatMap((t) => (t?.layers ? [t.layers] : []));
      }
    }
    if (this.moving && zoom < COARSE_BELOW_ZOOM && this.coarse) return [this.coarse];
    return [this.base!];
  }

  /** Detail cells that may be in view. */
  private visibleCells(): string[] {
    const centre = centreOf(this.rotation);
    // Angular radius of the view: half its diagonal, as an angle on the sphere.
    const half = Math.hypot(this.width, this.height) / 2;
    const view = Math.asin(Math.min(1, half / this.scale)) * (180 / Math.PI);
    const reach = view + CELL_DEG * 0.75;
    const ids: string[] = [];
    for (let row = 0; row < CELL_ROWS; row++) {
      for (let col = 0; col < CELL_COLS; col++) {
        const [[w, s], [e, n]] = cellBounds(col, row);
        const c: LngLat = [(w + e) / 2, (s + n) / 2];
        if (angularDegrees(centre, c) <= reach) ids.push(cellId(col, row));
      }
    }
    return ids;
  }

  /** A detail tile, fetched on first use; null for cells with no land. */
  private tile(id: string): Tile | null {
    if (!this.grid?.detail.includes(id)) return null;
    let t = this.tiles.get(id);
    if (!t) {
      t = { layers: null, loading: true, failed: false };
      this.tiles.set(id, t);
      const tile = t;
      fetch(`${this.tileBaseUrl}${id}.json?v=${this.grid.detailVersion}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((topo: Topology) => {
          tile.layers = decodeLayers(topo, { land: 'land', coast: 'coast', lakes: 'lakes', shores: 'shores', rivers: 'rivers' });
        })
        .catch(() => {
          tile.failed = true;
        })
        .finally(() => {
          tile.loading = false;
          this.invalidate();
        });
    }
    return t;
  }

  /** Varnish, tea-stained toning towards the rim, and the light on a ball. */
  private drawShading(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const hx = cx - R * 0.38;
    const hy = cy - R * 0.42;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(226,196,128,0.32)'; // yellowed varnish
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    const tone = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    tone.addColorStop(0, 'rgba(160,110,50,0)');
    tone.addColorStop(0.75, 'rgba(160,110,50,0.18)');
    tone.addColorStop(1, 'rgba(120,75,30,0.55)');
    ctx.fillStyle = tone;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    const shade = ctx.createRadialGradient(hx, hy, R * 0.2, cx + R * 0.1, cy + R * 0.12, R * 1.15);
    shade.addColorStop(0, 'rgba(60,40,20,0)');
    shade.addColorStop(0.7, 'rgba(60,40,20,0.12)');
    shade.addColorStop(1, 'rgba(40,25,10,0.42)');
    ctx.fillStyle = shade;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.globalCompositeOperation = 'source-over';
    const light = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.85);
    light.addColorStop(0, 'rgba(255,250,235,0.42)');
    light.addColorStop(0.45, 'rgba(255,248,230,0.12)');
    light.addColorStop(1, 'rgba(255,248,230,0)');
    ctx.fillStyle = light;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  }

  /** The brass meridian ring, engraved with degree marks. */
  private drawMeridianRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const r0 = R + RING_GAP;
    const r1 = r0 + RING_WIDTH;
    const brass = ctx.createLinearGradient(cx - r1, cy - r1, cx + r1, cy + r1);
    brass.addColorStop(0, '#f6dc96');
    brass.addColorStop(0.35, '#c99a3c');
    brass.addColorStop(0.6, '#9a6e22');
    brass.addColorStop(0.8, '#d6aa52');
    brass.addColorStop(1, '#6b4812');
    ctx.beginPath();
    ctx.arc(cx, cy, r1, 0, 2 * Math.PI);
    ctx.arc(cx, cy, r0, 0, 2 * Math.PI, true);
    ctx.fillStyle = brass;
    ctx.fill('evenodd');
    ctx.strokeStyle = '#4a320f';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, r1, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r0, 0, 2 * Math.PI);
    ctx.stroke();
    // Degree marks: every 5°, longer every 10°.
    ctx.strokeStyle = 'rgba(60,38,10,0.75)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let deg = 0; deg < 360; deg += 5) {
      const a = (deg * Math.PI) / 180;
      const inner = r0 + (deg % 10 === 0 ? 1.5 : 4);
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * (r1 - 1.5), cy + Math.sin(a) * (r1 - 1.5));
    }
    ctx.stroke();
    // Pivot at the north pole.
    ctx.fillStyle = '#7a5418';
    ctx.beginPath();
    ctx.arc(cx, cy - r0 - RING_WIDTH / 2, 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  /**
   * The wooden horizon ring the globe sits in, and its turned stand. The
   * ring's far half is drawn behind the globe, its near half in front.
   */
  private drawStand(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, part: 'back' | 'front'): void {
    const ey = cy + R * 0.97;
    const rx = R + RING_GAP + RING_WIDTH + R * 0.1;
    const ry = R * 0.17;
    const band = Math.max(8, R * 0.09);
    const iry = ry - band * 0.5;
    const wood = ctx.createLinearGradient(cx - rx, ey - ry, cx + rx, ey + ry);
    wood.addColorStop(0, '#9a6532');
    wood.addColorStop(0.5, '#6b3f1a');
    wood.addColorStop(1, '#4a2a10');
    if (part === 'back') {
      // Stand below: a turned baluster on a round foot.
      const top = ey + ry;
      const foot = top + R * 0.42;
      const s = ctx.createLinearGradient(cx - R * 0.3, 0, cx + R * 0.3, 0);
      s.addColorStop(0, '#4a2a10');
      s.addColorStop(0.35, '#8c5a2c');
      s.addColorStop(0.6, '#6b3f1a');
      s.addColorStop(1, '#3d220c');
      ctx.fillStyle = s;
      ctx.strokeStyle = '#2e1a08';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - R * 0.07, top - 2);
      ctx.bezierCurveTo(cx - R * 0.07, top + R * 0.12, cx - R * 0.2, top + R * 0.18, cx - R * 0.1, top + R * 0.3);
      ctx.lineTo(cx - R * 0.32, foot);
      ctx.lineTo(cx + R * 0.32, foot);
      ctx.lineTo(cx + R * 0.1, top + R * 0.3);
      ctx.bezierCurveTo(cx + R * 0.2, top + R * 0.18, cx + R * 0.07, top + R * 0.12, cx + R * 0.07, top - 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx, foot, R * 0.4, R * 0.06, 0, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      // Far half of the horizon ring.
      ctx.beginPath();
      ctx.ellipse(cx, ey, rx, ry, 0, Math.PI, 2 * Math.PI);
      ctx.ellipse(cx, ey, rx - band, iry, 0, 2 * Math.PI, Math.PI, true);
      ctx.closePath();
      ctx.fillStyle = wood;
      ctx.fill();
      ctx.stroke();
      return;
    }
    // Near half of the horizon ring, with its engraved calendar band.
    ctx.beginPath();
    ctx.ellipse(cx, ey, rx, ry, 0, 0, Math.PI);
    ctx.ellipse(cx, ey, rx - band, iry, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fillStyle = wood;
    ctx.fill();
    ctx.strokeStyle = '#2e1a08';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(240,215,160,0.55)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.ellipse(cx, ey, rx - band / 2, (ry + iry) / 2, 0, 0.08, Math.PI - 0.08);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 1; i < 36; i++) {
      const a = (i / 36) * Math.PI;
      const x = cx + Math.cos(a) * (rx - band / 2);
      const y = ey + Math.sin(a) * ((ry + iry) / 2);
      ctx.moveTo(x, y - band * 0.18);
      ctx.lineTo(x, y + band * 0.18);
    }
    ctx.stroke();
  }

  // ----------------------------------------------------------- overlay ---

  private buildOverlay(): void {
    const ov = this.overlay;
    this.reviewG = el('g', { class: 'review' }, ov);
    this.routeShadowEl = el('path', { class: 'route-shadow', fill: 'none' }, ov);
    this.routeEl = el('path', { class: 'route', fill: 'none' }, ov);
    this.sealEl = el('g', { class: 'marker seal', visibility: 'hidden' }, ov);
    this.sealEl.innerHTML = `<g class="marker-inner">${sealMarkerMarkup('cm-seal')}</g>`;
    this.guessEl = el('g', { class: 'marker guess', visibility: 'hidden' }, ov);
    this.guessEl.innerHTML = `<g class="marker-inner">${guessMarkerMarkup()}</g>`;
    this.crosshairEl = el('g', { class: 'crosshair' }, ov);
    this.crosshairEl.innerHTML = `
      <circle r="10" fill="none" stroke="${PALETTE.ink}" stroke-width="1"/>
      <path d="M-18,0H-5M5,0H18M0,-18V-5M0,5V18" stroke="${PALETTE.ink}" stroke-width="1.2"/>`;
  }

  private updateOverlay(): void {
    this.placeMarker(this.guessEl, this.guess);
    this.placeMarker(this.sealEl, this.answer);
    const d = this.route ? this.routePath(this.route.from, this.route.to, this.route.u) : '';
    this.routeEl.setAttribute('d', d);
    this.routeShadowEl.setAttribute('d', d);
    for (const r of this.review) {
      const [shadow, route, gm, sm] = Array.from(r.g.children) as SVGGraphicsElement[];
      const rd = r.guess ? this.routePath(r.guess, r.answer, 1) : '';
      shadow.setAttribute('d', rd);
      route.setAttribute('d', rd);
      this.placeMarker(gm as SVGGElement, r.guess);
      this.placeMarker(sm as SVGGElement, r.answer);
    }
    this.crosshairEl.setAttribute('transform', `translate(${this.fit.cx},${this.fit.cy})`);
  }

  /** The great-circle route (fraction u of the way), as an SVG path on the visible side. */
  private routePath(a: LngLat, b: LngLat, u: number): string {
    const interp = geoInterpolate(a, b);
    const n = 96;
    const coordinates = Array.from({ length: n + 1 }, (_, i) => interp((i / n) * u));
    return this.path({ type: 'LineString', coordinates }) ?? '';
  }

  private placeMarker(node: SVGGElement, p: LngLat | null): void {
    const xy = p && isFacing(this.rotation, p, 0.004) ? this.projection(p) : null;
    if (!xy) {
      node.setAttribute('visibility', 'hidden');
      return;
    }
    node.setAttribute('visibility', 'visible');
    node.setAttribute('transform', `translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`);
  }

  /** Page coordinates of a point on the globe, or null on the far side (for tests and tooling). */
  screenPoint(p: LngLat): [number, number] | null {
    this.applyProjection();
    if (!isFacing(this.rotation, p)) return null;
    const xy = this.projection(p);
    if (!xy) return null;
    const r = this.element.getBoundingClientRect();
    return [r.left + xy[0], r.top + xy[1]];
  }

  // ---------------------------------------------------------- movement ---

  private speed(): number {
    return Math.hypot(this.velocity[0], this.velocity[1]);
  }

  /** Runs animations and inertia frame by frame until both have finished. */
  private startLoop(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      let active = false;
      if (this.flight) active = this.stepFlight(now) || active;
      if (this.speed() > 0) active = this.stepInertia(dt) || active;
      this.draw();
      if (active) requestAnimationFrame(step);
      else this.loopRunning = false;
    };
    requestAnimationFrame(step);
  }

  private stepFlight(now: number): boolean {
    const f = this.flight!;
    const t = f.duration > 0 ? Math.min(1, (now - f.start) / f.duration) : 1;
    const e = easeInOut(t);
    const centre = geoInterpolate(centreOf(f.from.rotation), centreOf(f.to.rotation))(e) as LngLat;
    this.rotation = rotationFor(centre);
    this.scale = Math.exp(Math.log(f.from.scale) + (Math.log(f.to.scale) - Math.log(f.from.scale)) * e);
    this.markMoving();
    if (t < 1) return true;
    this.rotation = f.to.rotation;
    this.scale = f.to.scale;
    this.flight = null;
    f.resolve();
    return false;
  }

  private stepInertia(dt: number): boolean {
    this.rotation = [this.rotation[0] + this.velocity[0] * dt, Math.max(-90, Math.min(90, this.rotation[1] + this.velocity[1] * dt))];
    this.velocity = [decay(this.velocity[0], dt), decay(this.velocity[1], dt)];
    if (this.speed() < 0.004) this.velocity = [0, 0];
    this.markMoving();
    return this.speed() > 0;
  }

  /** Turns and zooms smoothly to a view; resolves when it arrives. */
  private flyTo(to: View, duration: number): Promise<void> {
    this.velocity = [0, 0];
    this.flight?.resolve();
    const target: View = { rotation: to.rotation, scale: this.clampScale(to.scale) };
    if (reducedMotion() || duration <= 0) {
      this.flight = null;
      this.rotation = target.rotation;
      this.scale = target.scale;
      this.markMoving();
      this.invalidate();
      return (this.flightDone = Promise.resolve());
    }
    this.flightDone = new Promise((resolve) => {
      this.flight = { from: { rotation: this.rotation, scale: this.scale }, to: target, start: performance.now(), duration, resolve };
    });
    this.startLoop();
    return this.flightDone;
  }

  private stopMotion(): void {
    if (this.flight) {
      this.flight.resolve();
      this.flight = null;
    }
    this.velocity = [0, 0];
  }

  zoomBy(factor: number): void {
    this.flyTo({ rotation: this.rotation, scale: this.scale * factor }, 280);
  }

  /** Back to the whole globe, keeping the side that faces the player. */
  resetView(duration = 600): void {
    this.flyTo({ rotation: [this.rotation[0], Math.max(-30, Math.min(-10, this.rotation[1]))], scale: this.fit.scale }, duration);
  }

  /** Turns and zooms the globe so all the points are in view. */
  fitPoints(points: LngLat[], duration = 900, maxZoomFactor = 10): Promise<void> {
    if (!points.length) return Promise.resolve();
    const radius = this.fit.scale * 0.9;
    const view = viewForPoints(points, radius, this.fit.scale, this.fit.scale * maxZoomFactor);
    return this.flyTo(view, duration);
  }

  // -------------------------------------------------------------- input ---

  onPick(handler: (p: LngLat) => void): void {
    this.pickHandler = handler;
  }

  setPickEnabled(enabled: boolean): void {
    this.pickEnabled = enabled;
    this.element.classList.toggle('can-pick', enabled);
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.element.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const spinning = this.speed() > 0.02 || !!this.flight;
    this.stopMotion();
    this.element.setPointerCapture?.(e.pointerId);
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    this.press.down(x, y, e.pointerType, spinning);
    this.samples = [{ t: e.timeStamp, r: this.rotation }];
    if (this.pointers.size === 2) this.startPinch();
    this.element.classList.add('dragging');
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  }

  private onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      // Pan with the midpoint, zoom about it.
      this.rotation = dragRotation(this.rotation, mid[0] - this.pinch.mid[0], mid[1] - this.pinch.mid[1], this.scale);
      this.zoomAt(this.pinch.scale * (dist / this.pinch.dist), mid);
      this.pinch.mid = mid;
      this.markMoving();
      this.invalidate();
      return;
    }
    if (!this.press.move(x, y)) return; // still within the tap slop
    this.rotation = dragRotation(this.rotation, x - prev.x, y - prev.y, this.scale);
    this.samples.push({ t: e.timeStamp, r: this.rotation });
    while (this.samples.length > 2 && e.timeStamp - this.samples[0].t > 100) this.samples.shift();
    this.markMoving();
    this.invalidate();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const [x, y] = this.local(e);
    this.pointers.delete(e.pointerId);
    const tap = this.press.up(x, y);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 1) {
      // A pinch became a one-finger drag: carry on from here.
      this.samples = [{ t: e.timeStamp, r: this.rotation }];
      return;
    }
    if (this.pointers.size) return;
    this.element.classList.remove('dragging');
    if (tap) {
      this.pick([x, y]);
      return;
    }
    this.fling(e.timeStamp);
  }

  private onPointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.press.cancel();
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) this.element.classList.remove('dragging');
  }

  /** Lets go with the drag's recent velocity, unless the finger had paused. */
  private fling(now: number): void {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last === first || now - last.t > 60 || reducedMotion()) return;
    const dt = Math.max(16, last.t - first.t);
    this.velocity = [(last.r[0] - first.r[0]) / dt, (last.r[1] - first.r[1]) / dt];
    const max = 1.2 * (this.fit.scale / this.scale); // degrees per ms
    const s = this.speed();
    if (s > max) this.velocity = [(this.velocity[0] * max) / s, (this.velocity[1] * max) / s];
    if (this.speed() > 0.01) this.startLoop();
    else this.velocity = [0, 0];
  }

  private pick(point: [number, number]): void {
    if (!this.pickEnabled || !this.pickHandler) return;
    this.applyProjection();
    const ll = screenToLngLat(this.projection, point);
    if (ll) this.pickHandler(ll);
  }

  /** Sets the scale, keeping the point under `at` (screen px) in place. */
  private zoomAt(scale: number, at: [number, number]): void {
    const to = this.clampScale(scale);
    this.rotation = zoomRotation(this.rotation, at[0] - this.fit.cx, at[1] - this.fit.cy, this.scale, to);
    this.scale = to;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.stopMotion();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0022));
    this.zoomAt(this.scale * factor, this.local(e));
    this.markMoving();
    this.invalidate();
  }

  private onKey(e: KeyboardEvent): void {
    const step = Math.min(this.width, this.height) * 0.18;
    const turn = (dx: number, dy: number) => {
      e.preventDefault();
      this.flyTo({ rotation: dragRotation(this.rotation, dx, dy, this.scale), scale: this.scale }, 160);
    };
    switch (e.key) {
      case 'ArrowLeft':
        return turn(step, 0);
      case 'ArrowRight':
        return turn(-step, 0);
      case 'ArrowUp':
        return turn(0, step);
      case 'ArrowDown':
        return turn(0, -step);
      case '+':
      case '=':
        e.preventDefault();
        return this.zoomBy(1.6);
      case '-':
      case '_':
        e.preventDefault();
        return this.zoomBy(1 / 1.6);
      case ' ':
        if (!this.pickEnabled) return;
        e.preventDefault();
        this.pick([this.fit.cx, this.fit.cy]);
        return;
    }
  }

  // ------------------------------------------------------------ markers ---

  setGuess(p: LngLat | null): void {
    const isNew = !this.guess && p;
    this.guess = p;
    this.invalidate();
    if (isNew) this.pop(this.guessEl);
  }

  getGuess(): LngLat | null {
    return this.guess;
  }

  /**
   * Reveals the answer: waits for the globe to finish turning to show both
   * points (fitPoints), drops the seal and draws the great-circle route.
   */
  async showAnswer(answer: LngLat, guess: LngLat | null, animate = true): Promise<void> {
    this.guess = guess;
    this.route = null;
    if (animate) await this.flightDone;
    this.answer = answer;
    this.invalidate();
    if (animate) this.pop(this.sealEl);
    if (!guess) return;
    if (!animate || reducedMotion()) {
      this.route = { from: guess, to: answer, u: 1 };
      this.invalidate();
      return;
    }
    const route = { from: guess, to: answer, u: 0 };
    this.route = route;
    await new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = (now: number) => {
        if (this.route !== route) return resolve();
        const t = Math.min(1, (now - start) / 750);
        route.u = Math.max(0.0001, 1 - Math.pow(1 - t, 3));
        this.updateOverlay();
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  clearMarkers(): void {
    this.guess = null;
    this.answer = null;
    this.route = null;
    this.invalidate();
  }

  /** Shows every round's guess and answer at once (results review). */
  showReview(items: { guess: LngLat | null; answer: LngLat }[]): void {
    this.clearMarkers();
    this.reviewG.replaceChildren();
    this.review = items.map((it, i) => {
      const g = el('g', { class: 'review-item', 'data-index': i }, this.reviewG);
      el('path', { class: 'route-shadow', fill: 'none' }, g);
      el('path', { class: 'route', fill: 'none' }, g);
      el('g', { class: 'marker guess' }, g).innerHTML = guessMarkerMarkup();
      el('g', { class: 'marker seal' }, g).innerHTML = sealMarkerMarkup(`cm-rseal-${i}`);
      return { guess: it.guess, answer: it.answer, g };
    });
    this.invalidate();
  }

  /** Dims all but one review item and turns to it; null shows them all. */
  highlightReview(index: number | null): void {
    this.review.forEach((r, i) => r.g.classList.toggle('dim', index != null && i !== index));
    const items = index == null ? this.review : this.review[index] ? [this.review[index]] : [];
    const pts = items.flatMap((r) => (r.guess ? [r.guess, r.answer] : [r.answer]));
    if (pts.length) void this.fitPoints(pts, 800, index == null ? 4 : 12);
  }

  clearReview(): void {
    this.review = [];
    this.reviewG.replaceChildren();
    this.invalidate();
  }

  private pop(node: SVGGElement): void {
    const inner = node.querySelector('.marker-inner');
    if (!inner) return;
    inner.classList.remove('pop');
    void (inner as SVGGElement).getBoundingClientRect();
    inner.classList.add('pop');
  }
}

function angularDegrees(a: LngLat, b: LngLat): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / r;
}
