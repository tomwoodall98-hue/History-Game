import { geoPath } from 'd3-geo';
import type { ZoomTransform } from 'd3-zoom';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { FeatureCollection } from 'geojson';
import { LAYER_KEYS, type BaseMap, type GridInfo, type LayerKey } from './tiles';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Drawing layers, bottom to top, and which stored layer each one draws. */
export const DRAW_LAYERS = [
  ['landSilhouette', 'land'],
  ['land', 'land'],
  ['lakes', 'lakes'],
  ['r3', 'r3'],
  ['r2', 'r2'],
  ['r1', 'r1'],
  ['shores', 'shores'],
  ['coast', 'coast'],
] as const;
export type DrawLayer = (typeof DRAW_LAYERS)[number][0];
export type LayerGroups = Record<DrawLayer, SVGGElement>;

type Level = 'b' | 'd';

interface CellNodes {
  b: SVGElement[];
  d: SVGElement[];
  mode: Level;
}

/**
 * Renders the map, cell by cell, at two levels of detail.
 *
 * The base level ships with the app. Above a zoom threshold, the detail tile
 * for each visible cell is fetched and swapped in for that cell alone, so
 * there's never a moment where part of the view has no coastline at all.
 */
export class CellRenderer {
  /** Detail kicks in at this many screen pixels per map unit. */
  static readonly THRESHOLD = 4.2;
  private readonly grid: GridInfo;
  private readonly hasDetail: Set<string>;
  private readonly cells = new Map<string, CellNodes>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly path = geoPath().digits(3);
  private last: { t: ZoomTransform; w: number; h: number } | null = null;

  constructor(
    base: BaseMap,
    private readonly tileBaseUrl: string,
    private readonly defs: SVGDefsElement,
    private readonly groups: LayerGroups,
  ) {
    this.grid = base.grid;
    this.hasDetail = new Set(base.grid.detail);
    for (const id of Object.keys(base.objects)) this.renderCell(id, 'b', base, id);
  }

  /** Creates <path> defs for one cell at one level, and <use>s in each layer. */
  private renderCell(id: string, level: Level, topo: Topology, objectName: string): void {
    const fc = feature(topo as never, topo.objects[objectName] as never) as unknown as FeatureCollection;
    const d = new Map<LayerKey, string>();
    for (const f of fc.features) {
      const key = f.id as LayerKey;
      if (!LAYER_KEYS.includes(key)) continue;
      const s = this.path(f);
      if (s) d.set(key, s);
    }
    let nodes = this.cells.get(id);
    if (!nodes) {
      nodes = { b: [], d: [], mode: 'b' };
      this.cells.set(id, nodes);
    }
    for (const [key, value] of d) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('id', `${level}-${id}-${key}`);
      p.setAttribute('d', value);
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      if (key === 'land' || key === 'lakes') p.setAttribute('fill-rule', 'evenodd');
      this.defs.appendChild(p);
    }
    const hidden = level !== nodes.mode;
    for (const [layer, key] of DRAW_LAYERS) {
      if (!d.has(key)) continue;
      const u = document.createElementNS(SVG_NS, 'use');
      u.setAttribute('href', `#${level}-${id}-${key}`);
      if (hidden) u.setAttribute('display', 'none');
      this.groups[layer].appendChild(u);
      nodes[level].push(u);
    }
  }

  private setMode(id: string, mode: Level): void {
    const nodes = this.cells.get(id);
    if (!nodes || nodes.mode === mode) return;
    if (mode === 'd' && !nodes.d.length) return;
    nodes.mode = mode;
    for (const n of nodes.b) n.setAttribute('display', mode === 'b' ? 'inline' : 'none');
    for (const n of nodes.d) n.setAttribute('display', mode === 'd' ? 'inline' : 'none');
  }

  private cellsInView(t: ZoomTransform, w: number, h: number, margin: number): string[] {
    const cw = this.grid.mapWidth / this.grid.cols;
    const ch = this.grid.mapHeight / this.grid.rows;
    const c0 = Math.max(0, Math.floor(t.invertX(0) / cw - margin));
    const c1 = Math.min(this.grid.cols - 1, Math.floor(t.invertX(w) / cw + margin));
    const r0 = Math.max(0, Math.floor(t.invertY(0) / ch - margin));
    const r1 = Math.min(this.grid.rows - 1, Math.floor(t.invertY(h) / ch + margin));
    const ids: string[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) ids.push(`${c}-${r}`);
    return ids;
  }

  /** Call after every zoom/pan; cheap unless new tiles are needed. */
  update(t: ZoomTransform, w: number, h: number): void {
    this.last = { t, w, h };
    if (t.k < CellRenderer.THRESHOLD) {
      for (const id of this.cells.keys()) this.setMode(id, 'b');
      return;
    }
    for (const id of this.cellsInView(t, w, h, 0.5)) {
      if (this.hasDetail.has(id)) this.request(id);
    }
    for (const id of this.cellsInView(t, w, h, 0)) {
      const nodes = this.cells.get(id);
      if (nodes?.d.length) this.setMode(id, 'd');
    }
  }

  private request(id: string): void {
    const nodes = this.cells.get(id);
    if (nodes?.d.length || this.pending.has(id) || this.failed.has(id)) return;
    this.pending.add(id);
    const url = new URL(`${id}.json?v=${this.grid.detailVersion}`, this.tileBaseUrl).href;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`tile ${id}: HTTP ${r.status}`);
        return r.json() as Promise<Topology>;
      })
      .then((topo) => {
        this.renderCell(id, 'd', topo, 'cell');
        if (this.last) this.update(this.last.t, this.last.w, this.last.h);
      })
      .catch((err) => {
        console.warn('Detail tile failed to load', err);
        this.failed.add(id);
      })
      .finally(() => this.pending.delete(id));
  }
}
