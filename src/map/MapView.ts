import { geoPath, geoGraticule, geoInterpolate, type GeoPermissibleObjects } from 'd3-geo';
import { select, pointer, type Selection } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity, zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import 'd3-transition';
import { createProjection, MAP_WIDTH, MAP_HEIGHT, MAP_SCALE, LAT_NORTH, CENTRAL_MERIDIAN, wrapLng } from './projection';
import { guessMarkerMarkup, sealMarkerMarkup } from './ornaments';
import { CellRenderer, type LayerGroups } from './cells';
import type { BaseMap } from './tiles';

export type LngLat = [number, number];
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}


const SVG_NS = 'http://www.w3.org/2000/svg';

/** Palette (kept in sync with the CSS custom properties in main.css). */
export const PALETTE = {
  sea: '#c5d0c7',
  land: '#efe1ba',
  ink: '#33220f',
  river: '#3e4d57',
  graticule: '#5b4128',
};

/**
 * Water-lining: ripple lines ruled parallel to every coast, as on engraved
 * 19th-century sheets. They come from one screen-space SVG filter: the land
 * silhouette is blurred and the blurred alpha is cut into thin bands, giving
 * rings at roughly fixed pixel distances from the shore at any zoom. The cost
 * doesn't depend on coastline detail (wide strokes on the coastline itself
 * were ~50× slower).
 */
const WATERLINE_SIGMA = 10;
const RINGS = [
  { dist: 2.4, alpha: 0.68 },
  { dist: 5.3, alpha: 0.6 },
  { dist: 8.7, alpha: 0.44 },
  { dist: 12.9, alpha: 0.3 },
  { dist: 17.6, alpha: 0.18 },
];
const RING_WIDTH = 0.95;

/** Upper zoom bound in screen pixels per map unit (~1 km per pixel). */
const MAX_PX_PER_UNIT = 40;

/** feFuncA lookup table that turns blurred alpha into thin ring bands. */
function ringTable(sigma: number, rings: { dist: number; alpha: number }[], width: number, inside = false): string {
  const erfc = (x: number) => {
    // Abramowitz & Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y =
      t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp(-x * x);
    return x >= 0 ? y : 2 - y;
  };
  const vals = new Array<number>(256).fill(0);
  for (const { dist, alpha } of rings) {
    const a = 0.5 * erfc(dist / (sigma * Math.SQRT2));
    const level = (inside ? 1 - a : a) * 255;
    const grad = (Math.exp(-0.5 * (dist / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI))) * 255;
    const half = Math.max(0.6, (width * grad) / 2);
    for (let i = 0; i < 256; i++) {
      const dd = Math.abs(i - level);
      const v = dd <= half ? alpha : dd <= half + 1.2 ? alpha * (1 - (dd - half) / 1.2) : 0;
      vals[i] = Math.max(vals[i], v);
    }
  }
  return vals.map((v) => (v ? v.toFixed(3) : '0')).join(' ');
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

/** Records d3-geo path output as polylines in map units. */
class PolylineContext {
  lines: [number, number][][] = [];
  private current: [number, number][] | null = null;
  moveTo(x: number, y: number) {
    this.current = [[x, y]];
    this.lines.push(this.current);
  }
  lineTo(x: number, y: number) {
    this.current?.push([x, y]);
  }
  closePath() {
    if (this.current?.length) this.current.push(this.current[0]);
  }
  arc() {}
}

const mercY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
/** Map-unit x of a longitude on the sheet (unwrapped, west edge = 0). */
const lngToX = (lng: number) => ((lng - (CENTRAL_MERIDIAN - 180)) / 360) * MAP_WIDTH;
const latToY = (lat: number) => MAP_SCALE * (mercY(LAT_NORTH) - mercY(lat));

export class MapView {
  readonly svg: SVGSVGElement;
  private readonly projection = createProjection(0);
  private readonly zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;
  private readonly sel: Selection<SVGSVGElement, unknown, null, undefined>;
  private zoomLayers: SVGGElement[] = [];
  private filters: SVGFilterElement[] = [];
  private screenClipRect!: SVGRectElement;
  private wlBlur!: SVGFEGaussianBlurElement;
  private wlTable!: SVGFEFuncAElement;
  private ringScale = 1;
  private neat!: {
    inner: SVGRectElement;
    outer: SVGRectElement;
    top: SVGGElement;
    bottom: SVGGElement;
    left: SVGGElement;
    right: SVGGElement;
  };
  private strokeEls: { el: SVGElement; base: number }[] = [];
  private lineEl!: SVGPathElement;
  private lineShadowEl!: SVGPathElement;
  private guessEl!: SVGGElement;
  private sealEl!: SVGGElement;
  private crosshairEl!: SVGGElement;
  private cells: CellRenderer | null = null;
  private guess: LngLat | null = null;
  private answer: LngLat | null = null;
  private linePolylines: [number, number][][] = [];
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private width = 0;
  private height = 0;
  private kFit = 1;
  private lastZw = 0;
  private interacting = false;
  private idleTimer = 0;
  private pickHandler: ((p: LngLat) => void) | null = null;
  private pickEnabled = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly tileBaseUrl: string,
  ) {
    this.svg = el('svg', {
      class: 'map-svg',
      tabindex: 0,
      role: 'application',
      'aria-roledescription': 'map',
      'aria-label':
        'World map. Drag or use the arrow keys to pan; scroll, pinch or press plus and minus to zoom. Click or tap to mark your guess, or press Space to mark the centre of the view.',
    });
    container.appendChild(this.svg);
    this.sel = select(this.svg);

    this.zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .clickDistance(6)
      .tapDistance(12)
      .constrain((t) => this.constrain(t))
      .on('zoom', (e: { transform: ZoomTransform }) => this.onZoom(e.transform));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  /** Builds every layer from the base map. */
  render(base: BaseMap): void {
    const svg = this.svg;
    svg.replaceChildren();
    this.strokeEls = [];
    this.zoomLayers = [];
    const path = geoPath(this.projection).digits(2);
    const d = (o: GeoPermissibleObjects) => path(o) ?? '';

    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: 'cm-sheet-clip' }, defs);
    el('rect', { x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT }, clip);

    // Water-lining filter (screen space; its region is sized in resize()).
    const wlFilter = el('filter', { id: 'cm-waterline', filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, defs);
    this.wlBlur = el('feGaussianBlur', { in: 'SourceAlpha', stdDeviation: WATERLINE_SIGMA, result: 'blur' }, wlFilter);
    const wlCt = el('feComponentTransfer', { in: 'blur', result: 'rings' }, wlFilter);
    this.wlTable = el('feFuncA', { type: 'table', tableValues: ringTable(WATERLINE_SIGMA, RINGS, RING_WIDTH) }, wlCt);
    this.ringScale = 1;
    el('feFlood', { 'flood-color': PALETTE.ink, result: 'ink' }, wlFilter);
    el('feComposite', { in: 'ink', in2: 'rings', operator: 'in' }, wlFilter);
    this.filters = [wlFilter];
    const screenClip = el('clipPath', { id: 'cm-sheet-clip-screen' }, defs);
    this.screenClipRect = el('rect', {}, screenClip);

    const zoomGroup = (parent: Element, attrs: Record<string, string | number> = {}) => {
      const g = el('g', { class: 'zoom-layer', ...attrs }, parent);
      this.zoomLayers.push(g);
      return g;
    };
    const sheetClip = { 'clip-path': 'url(#cm-sheet-clip)' };

    // 1. Sea and graticule (map units).
    const sheet0 = zoomGroup(svg, sheetClip);
    el('rect', { class: 'sea', x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT, fill: PALETTE.sea }, sheet0);
    this.buildGraticule(sheet0, d);

    // 2. Water-lining, in screen units, around a transformed land silhouette.
    const wl = el('g', { class: 'waterlines', filter: 'url(#cm-waterline)', 'clip-path': 'url(#cm-sheet-clip-screen)' }, svg);
    const landSilhouette = el('g', { fill: '#000' }, zoomGroup(wl));

    // 3. Land and lake fills (map units).
    const sheet1 = zoomGroup(svg, sheetClip);
    const land = el('g', { class: 'land', fill: PALETTE.land }, sheet1);
    const lakes = el('g', { class: 'lakes', fill: PALETTE.sea }, sheet1);

    // 4. Rivers, lake shores and coast (map units), heaviest last.
    const sheet2 = zoomGroup(svg, sheetClip);
    const line = (cls: string, stroke: string, base: number) => {
      const g = el('g', { class: cls, fill: 'none', stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sheet2);
      this.strokeEls.push({ el: g, base });
      return g;
    };
    const groups: LayerGroups = {
      landSilhouette,
      land,
      lakes,
      r3: line('rivers', PALETTE.river, 0.55),
      r2: line('rivers', PALETTE.river, 0.8),
      r1: line('rivers', PALETTE.river, 1.1),
      shores: line('shores', PALETTE.ink, 0.7),
      coast: line('coast', PALETTE.ink, 1.15),
    };
    this.cells = new CellRenderer(base, this.tileBaseUrl, defs, groups);

    this.buildOverlay();

    this.sel.call(this.zoomBehavior).on('dblclick.zoom', null);
    this.sel.on('click.pick', (event: MouseEvent) => this.handleClick(event));
    this.svg.addEventListener('keydown', (e) => this.handleKey(e));

    this.resize(true);
    this.applyLineWeights(1);
  }

  private buildGraticule(parent: SVGGElement, d: (o: GeoPermissibleObjects) => string): void {
    const common = { fill: 'none', stroke: PALETTE.graticule, 'vector-effect': 'non-scaling-stroke' };
    // Fine unlabelled 15° grid.
    const grat = geoGraticule()
      .step([15, 15])
      .extentMinor([
        [-180, -80],
        [180, 80.001],
      ]);
    const gratEl = el('path', { ...common, class: 'graticule', d: d(grat()), 'stroke-opacity': 0.38 }, parent);
    this.strokeEls.push({ el: gratEl, base: 0.45 });
    // Tropics and polar circles dashed; the equator a touch heavier.
    const parallel = (lat: number) => ({
      type: 'LineString' as const,
      coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]),
    });
    const special = el(
      'path',
      {
        ...common,
        class: 'graticule-special',
        d: [23.44, -23.44, 66.56, -66.56].map((lat) => d(parallel(lat))).join(''),
        'stroke-opacity': 0.55,
        'stroke-dasharray': '5 3',
      },
      parent,
    );
    this.strokeEls.push({ el: special, base: 0.55 });
    const equator = el('path', { ...common, class: 'equator', d: d(parallel(0)), 'stroke-opacity': 0.6 }, parent);
    this.strokeEls.push({ el: equator, base: 0.9 });
  }

  /** Screen-space overlay: neatline, line between guess and answer, markers. */
  private buildOverlay(): void {
    const ov = el('g', { class: 'overlay' }, this.svg);

    // Neatline with an alternating degree band (10° cells, unlabelled).
    const neatG = el('g', { class: 'neatline', 'pointer-events': 'none' }, ov);
    const outer = el('rect', { fill: 'none', stroke: PALETTE.ink, 'stroke-width': 1.4 }, neatG);
    const bands = { top: el('g', {}, neatG), bottom: el('g', {}, neatG), left: el('g', {}, neatG), right: el('g', {}, neatG) };
    const inner = el('rect', { fill: 'none', stroke: PALETTE.ink, 'stroke-width': 0.9 }, neatG);
    const BAND = 5;
    const GAP = 3;
    const cell = { stroke: PALETTE.ink, 'stroke-width': 0.5, 'vector-effect': 'non-scaling-stroke' };
    const xs: number[] = [CENTRAL_MERIDIAN - 180];
    for (let lng = Math.ceil((CENTRAL_MERIDIAN - 180) / 10) * 10; lng < CENTRAL_MERIDIAN + 180; lng += 10) {
      if (lng > xs[xs.length - 1]) xs.push(lng);
    }
    xs.push(CENTRAL_MERIDIAN + 180);
    for (let i = 0; i < xs.length - 1; i++) {
      const fill = Math.floor(xs[i] / 10) % 2 === 0 ? PALETTE.ink : 'none';
      const x = lngToX(xs[i]);
      const w = lngToX(xs[i + 1]) - x;
      el('rect', { ...cell, x, y: -GAP - BAND, width: w, height: BAND, fill }, bands.top);
      el('rect', { ...cell, x, y: GAP, width: w, height: BAND, fill }, bands.bottom);
    }
    const ys = [80, 70, 60, 50, 40, 30, 20, 10, 0, -10, -20, -30, -40, -50, -60, -70, -75];
    for (let i = 0; i < ys.length - 1; i++) {
      const fill = Math.floor(ys[i + 1] / 10) % 2 === 0 ? PALETTE.ink : 'none';
      const y = latToY(ys[i]);
      const h = latToY(ys[i + 1]) - y;
      el('rect', { ...cell, x: -GAP - BAND, y, width: BAND, height: h, fill }, bands.left);
      el('rect', { ...cell, x: GAP, y, width: BAND, height: h, fill }, bands.right);
    }
    this.neat = { inner, outer, ...bands };

    this.lineShadowEl = el('path', { class: 'route-shadow', fill: 'none' }, ov);
    this.lineEl = el('path', { class: 'route', fill: 'none' }, ov);

    this.sealEl = el('g', { class: 'marker seal', visibility: 'hidden' }, ov);
    this.sealEl.innerHTML = `<g class="marker-inner">${sealMarkerMarkup('cm-seal')}</g>`;
    this.guessEl = el('g', { class: 'marker guess', visibility: 'hidden' }, ov);
    this.guessEl.innerHTML = `<g class="marker-inner">${guessMarkerMarkup()}</g>`;

    this.crosshairEl = el('g', { class: 'crosshair', 'pointer-events': 'none' }, ov);
    this.crosshairEl.innerHTML = `
      <circle r="10" fill="none" stroke="${PALETTE.ink}" stroke-width="1"/>
      <path d="M-18,0H-5M5,0H18M0,-18V-5M0,5V18" stroke="${PALETTE.ink}" stroke-width="1.2"/>`;
  }

  // ---------------------------------------------------------------- zoom ---

  get transform(): ZoomTransform {
    return zoomTransform(this.svg);
  }

  setInsets(insets: Partial<Insets>): void {
    this.insets = { ...this.insets, ...insets };
    this.resize();
  }

  /** The part of the map not covered by UI panels, in SVG pixels. */
  private usable() {
    const { top, right, bottom, left } = this.insets;
    return {
      x0: left,
      y0: top,
      x1: Math.max(left + 50, this.width - right),
      y1: Math.max(top + 50, this.height - bottom),
    };
  }

  /** Keeps the sheet in view: centred when smaller than the view, else edge-limited. */
  private constrain(t: ZoomTransform): ZoomTransform {
    const { x0, y0, x1, y1 } = this.usable();
    const margin = 22;
    const fix = (m0: number, m1: number, v0: number, v1: number) => {
      if (m1 - m0 + 2 * margin <= v1 - v0) return (v0 + v1) / 2 - (m0 + m1) / 2;
      if (m0 > v0 + margin) return v0 + margin - m0;
      if (m1 < v1 - margin) return v1 - margin - m1;
      return 0;
    };
    const dx = fix(t.applyX(0), t.applyX(MAP_WIDTH), x0, x1);
    const dy = fix(t.applyY(0), t.applyY(MAP_HEIGHT), y0, y1);
    return dx || dy ? zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k) : t;
  }

  private resize(initial = false): void {
    const rect = this.container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.width = rect.width;
    this.height = rect.height;
    this.svg.setAttribute('width', String(this.width));
    this.svg.setAttribute('height', String(this.height));
    const { x0, y0, x1, y1 } = this.usable();
    const pad = Math.min(30, (x1 - x0) * 0.04);
    this.kFit = Math.max(0.05, Math.min((x1 - x0 - 2 * pad) / MAP_WIDTH, (y1 - y0 - 2 * pad) / MAP_HEIGHT));
    const kMin = this.kFit * 0.92;
    const kMax = Math.max(MAX_PX_PER_UNIT, this.kFit * 8);
    this.zoomBehavior
      .extent([
        [0, 0],
        [this.width, this.height],
      ])
      .scaleExtent([kMin, kMax]);
    for (const f of this.filters) {
      f.setAttribute('x', '0');
      f.setAttribute('y', '0');
      f.setAttribute('width', String(this.width));
      f.setAttribute('height', String(this.height));
    }
    if (!this.zoomLayers.length) return;
    const t = this.transform;
    if (initial || t.k < kMin) {
      this.sel.call(this.zoomBehavior.transform, this.fitTransform());
    } else {
      this.sel.call(this.zoomBehavior.transform, t); // re-apply constraints
    }
  }

  /** Transform that shows the whole sheet in the usable area. */
  fitTransform(): ZoomTransform {
    const { x0, y0, x1, y1 } = this.usable();
    const k = this.kFit;
    return zoomIdentity.translate((x0 + x1) / 2 - (k * MAP_WIDTH) / 2, (y0 + y1) / 2 - (k * MAP_HEIGHT) / 2).scale(k);
  }

  private onZoom(t: ZoomTransform): void {
    const tf = `translate(${t.x},${t.y}) scale(${t.k})`;
    for (const g of this.zoomLayers) g.setAttribute('transform', tf);
    this.updateOverlay(t);
    // Line weight grows gently with zoom, and thins on a small sheet.
    const zw = Math.min(1.8, Math.max(0.65, 1 + 0.16 * Math.log2(t.k / 1.3)));
    if (Math.abs(zw - this.lastZw) > 0.05) this.applyLineWeights(zw);
    // On a small sheet (a phone showing the whole world) the ripples close up
    // so they don't swamp the oceans.
    const rs = Math.round(Math.min(1, Math.max(0.45, t.k / 1.3)) * 20) / 20;
    if (rs !== this.ringScale) this.setRingScale(rs);
    this.cells?.update(t, this.width, this.height);
    this.markInteracting();
  }

  /**
   * While the view is moving, watch the frame rate. If this device can't
   * keep up, the water-lining (the costliest layer) is hidden during
   * gestures from then on and redrawn when the map comes to rest.
   */
  private markInteracting(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.interacting = false;
      this.svg.classList.remove('interacting');
    }, 160);
    if (this.interacting) return;
    this.interacting = true;
    this.svg.classList.add('interacting');
    if (this.svg.classList.contains('low-fi')) return;
    let last = 0;
    let slow = 0;
    const tick = (now: number) => {
      if (!this.interacting) return;
      if (last) {
        slow = now - last > 48 ? slow + 1 : Math.max(0, slow - 1);
        if (slow >= 4) {
          this.svg.classList.add('low-fi');
          return;
        }
      }
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private setRingScale(scale: number): void {
    this.ringScale = scale;
    const sigma = WATERLINE_SIGMA * scale;
    this.wlBlur.setAttribute('stdDeviation', String(sigma));
    this.wlTable.setAttribute(
      'tableValues',
      ringTable(sigma, RINGS.map((r) => ({ dist: r.dist * scale, alpha: r.alpha })), RING_WIDTH * Math.max(0.8, scale)),
    );
  }

  private applyLineWeights(zw: number): void {
    this.lastZw = zw;
    for (const { el: node, base } of this.strokeEls) node.setAttribute('stroke-width', (base * zw).toFixed(2));
  }

  private updateOverlay(t: ZoomTransform): void {
    const x0 = t.applyX(0);
    const y0 = t.applyY(0);
    const w = t.k * MAP_WIDTH;
    const h = t.k * MAP_HEIGHT;
    const n = this.neat;
    const setRect = (r: SVGRectElement, x: number, y: number, rw: number, rh: number) => {
      r.setAttribute('x', x.toFixed(2));
      r.setAttribute('y', y.toFixed(2));
      r.setAttribute('width', rw.toFixed(2));
      r.setAttribute('height', rh.toFixed(2));
    };
    setRect(n.inner, x0, y0, w, h);
    setRect(this.screenClipRect, x0, y0, w, h);
    const o = 11;
    setRect(n.outer, x0 - o, y0 - o, w + 2 * o, h + 2 * o);
    n.top.setAttribute('transform', `translate(${t.x},${y0}) scale(${t.k},1)`);
    n.bottom.setAttribute('transform', `translate(${t.x},${y0 + h}) scale(${t.k},1)`);
    n.left.setAttribute('transform', `translate(${x0},${t.y}) scale(1,${t.k})`);
    n.right.setAttribute('transform', `translate(${x0 + w},${t.y}) scale(1,${t.k})`);

    this.placeMarker(this.guessEl, this.guess, t);
    this.placeMarker(this.sealEl, this.answer, t);
    this.drawLine(t);
    const u = this.usable();
    this.crosshairEl.setAttribute('transform', `translate(${(u.x0 + u.x1) / 2},${(u.y0 + u.y1) / 2})`);
  }

  private project(p: LngLat): [number, number] | null {
    const xy = this.projection(p);
    return xy ? [xy[0], xy[1]] : null;
  }

  private placeMarker(node: SVGGElement, p: LngLat | null, t: ZoomTransform): void {
    const xy = p ? this.project(p) : null;
    if (!xy) {
      node.setAttribute('visibility', 'hidden');
      return;
    }
    node.setAttribute('visibility', 'visible');
    node.setAttribute('transform', `translate(${t.applyX(xy[0]).toFixed(1)},${t.applyY(xy[1]).toFixed(1)})`);
  }

  private drawLine(t: ZoomTransform): void {
    const d = this.linePolylines
      .map((line) => `M${line.map(([x, y]) => `${t.applyX(x).toFixed(1)},${t.applyY(y).toFixed(1)}`).join('L')}`)
      .join('');
    this.lineEl.setAttribute('d', d);
    this.lineShadowEl.setAttribute('d', d);
  }

  // -------------------------------------------------------------- input ---

  onPick(handler: (p: LngLat) => void): void {
    this.pickHandler = handler;
  }

  setPickEnabled(enabled: boolean): void {
    this.pickEnabled = enabled;
    this.svg.classList.toggle('can-pick', enabled);
  }

  private screenToLngLat(sx: number, sy: number): LngLat | null {
    const [mx, my] = this.transform.invert([sx, sy]);
    if (mx < 0 || mx > MAP_WIDTH || my < 0 || my > MAP_HEIGHT) return null;
    const ll = this.projection.invert?.([mx, my]);
    if (!ll) return null;
    return [wrapLng(ll[0]), ll[1]];
  }

  private handleClick(event: MouseEvent): void {
    if (event.defaultPrevented || !this.pickEnabled || !this.pickHandler) return;
    const [sx, sy] = pointer(event, this.svg);
    const ll = this.screenToLngLat(sx, sy);
    if (ll) this.pickHandler(ll);
  }

  private handleKey(e: KeyboardEvent): void {
    const step = 0.18;
    const { x0, y0, x1, y1 } = this.usable();
    const panBy = (dx: number, dy: number) => {
      e.preventDefault();
      this.sel
        .transition()
        .duration(160)
        .call(this.zoomBehavior.translateBy, dx / this.transform.k, dy / this.transform.k);
    };
    switch (e.key) {
      case 'ArrowLeft':
        return panBy((x1 - x0) * step, 0);
      case 'ArrowRight':
        return panBy(-(x1 - x0) * step, 0);
      case 'ArrowUp':
        return panBy(0, (y1 - y0) * step);
      case 'ArrowDown':
        return panBy(0, -(y1 - y0) * step);
      case '+':
      case '=':
        e.preventDefault();
        return this.zoomBy(1.6);
      case '-':
      case '_':
        e.preventDefault();
        return this.zoomBy(1 / 1.6);
      case ' ': {
        if (!this.pickEnabled || !this.pickHandler) return;
        e.preventDefault();
        const ll = this.screenToLngLat((x0 + x1) / 2, (y0 + y1) / 2);
        if (ll) this.pickHandler(ll);
        return;
      }
    }
  }

  zoomBy(factor: number): void {
    const { x0, y0, x1, y1 } = this.usable();
    this.sel
      .transition()
      .duration(280)
      .call(this.zoomBehavior.scaleBy, factor, [(x0 + x1) / 2, (y0 + y1) / 2]);
  }

  resetView(duration = 600): void {
    this.sel.transition().duration(duration).call(this.zoomBehavior.transform, this.fitTransform());
  }

  /** Smoothly frames the given points within the usable area. */
  fitPoints(points: LngLat[], duration = 900, maxZoomFactor = 10): void {
    const xy = points.map((p) => this.project(p)).filter((p): p is [number, number] => !!p);
    if (!xy.length) return;
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    let bx0 = Math.min(...xs);
    let bx1 = Math.max(...xs);
    let by0 = Math.min(...ys);
    let by1 = Math.max(...ys);
    const { x0, y0, x1, y1 } = this.usable();
    const pad = Math.min(70, (x1 - x0) * 0.12);
    // A minimum box so a perfect guess doesn't zoom all the way in.
    const minSpan = 18;
    if (bx1 - bx0 < minSpan) [bx0, bx1] = [(bx0 + bx1) / 2 - minSpan / 2, (bx0 + bx1) / 2 + minSpan / 2];
    if (by1 - by0 < minSpan) [by0, by1] = [(by0 + by1) / 2 - minSpan / 2, (by0 + by1) / 2 + minSpan / 2];
    const k = Math.max(
      this.kFit,
      Math.min(this.kFit * maxZoomFactor, MAX_PX_PER_UNIT, (x1 - x0 - 2 * pad) / (bx1 - bx0), (y1 - y0 - 2 * pad) / (by1 - by0)),
    );
    const t = zoomIdentity.translate((x0 + x1) / 2 - (k * (bx0 + bx1)) / 2, (y0 + y1) / 2 - (k * (by0 + by1)) / 2).scale(k);
    if (duration <= 0) this.sel.call(this.zoomBehavior.transform, t);
    else this.sel.transition().duration(duration).call(this.zoomBehavior.transform, t);
  }

  // ------------------------------------------------------------ markers ---

  setGuess(p: LngLat | null): void {
    const isNew = !this.guess && p;
    this.guess = p;
    this.placeMarker(this.guessEl, p, this.transform);
    if (isNew) this.pop(this.guessEl);
  }

  getGuess(): LngLat | null {
    return this.guess;
  }

  /** Reveals the answer seal and draws the great-circle line to it. */
  showAnswer(answer: LngLat, guess: LngLat | null, animate = true): Promise<void> {
    this.answer = answer;
    this.guess = guess;
    const t = this.transform;
    this.placeMarker(this.guessEl, guess, t);
    this.placeMarker(this.sealEl, answer, t);
    if (animate) this.pop(this.sealEl);
    if (!guess) {
      this.linePolylines = [];
      this.drawLine(t);
      return Promise.resolve();
    }
    const interp = geoInterpolate(guess, answer);
    const build = (u: number) => {
      const n = 96;
      const coords = Array.from({ length: n + 1 }, (_, i) => interp((i / n) * u));
      const ctx = new PolylineContext();
      geoPath(this.projection, ctx as unknown as CanvasRenderingContext2D)({ type: 'LineString', coordinates: coords });
      this.linePolylines = ctx.lines;
      this.drawLine(this.transform);
    };
    if (!animate) {
      build(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const dur = 750;
      const tick = (now: number) => {
        const u = Math.min(1, (now - start) / dur);
        build(Math.max(0.0001, 1 - Math.pow(1 - u, 3)));
        if (u < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  clearMarkers(): void {
    this.guess = null;
    this.answer = null;
    this.linePolylines = [];
    this.updateOverlay(this.transform);
  }

  private pop(node: SVGGElement): void {
    const inner = node.querySelector('.marker-inner');
    if (!inner) return;
    inner.classList.remove('pop');
    void (inner as SVGGElement).getBoundingClientRect();
    inner.classList.add('pop');
  }
}
