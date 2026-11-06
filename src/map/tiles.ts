/**
 * The grid both map levels are cut into, shared by the geodata build script,
 * the map view and the question validator. Cells are cut in map units (see
 * projection.ts), not degrees, so every cell has the same screen footprint.
 */
import type { Topology } from 'topojson-specification';

export const TILE_COLS = 16;
export const TILE_ROWS = 12;

/** Layers stored per cell. land/lakes are polygons, the rest lines. */
export const LAYER_KEYS = ['land', 'coast', 'lakes', 'shores', 'r1', 'r2', 'r3'] as const;
export type LayerKey = (typeof LAYER_KEYS)[number];

export interface GridInfo {
  cols: number;
  rows: number;
  mapWidth: number;
  mapHeight: number;
  /** Changes whenever detail tiles change; appended to tile URLs. */
  detailVersion: string;
  /** Cell ids ("col-row") that have a detail tile. */
  detail: string[];
}

/** The committed base map: one TopoJSON object per cell, plus grid info. */
export interface BaseMap extends Topology {
  grid: GridInfo;
}

export const cellId = (col: number, row: number) => `${col}-${row}`;
