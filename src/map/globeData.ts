/**
 * The globe's map data, shared by the geodata build script, the globe view
 * and the question validator. Everything is in plain longitude/latitude
 * (no projection): the globe projects it afresh as it turns.
 *
 *   src/data/globe.topo.json      base level, shipped with the page:
 *                                 coarse land and coast (1:110m, drawn while
 *                                 the globe moves) and the full-detail base
 *                                 (land, coast, lakes, rivers) for rest
 *   public/geo/globe/<c>-<r>.json detail tiles (1:10m) for deep zoom, one per
 *                                 CELL_DEG × CELL_DEG cell
 */
import type { Topology } from 'topojson-specification';

/** Detail tiles are cut on a grid of this many degrees. */
export const CELL_DEG = 15;
export const CELL_COLS = 360 / CELL_DEG;
export const CELL_ROWS = 180 / CELL_DEG;

/** Objects in the base topology. */
export const BASE_OBJECTS = ['coarseLand', 'coarseCoast', 'land', 'coast', 'lakes', 'shores', 'rivers'] as const;
/** Objects in each detail tile. */
export const TILE_OBJECTS = ['land', 'coast', 'lakes', 'shores', 'rivers'] as const;

export interface GlobeGrid {
  cellDeg: number;
  /** Changes whenever detail tiles change; appended to tile URLs. */
  detailVersion: string;
  /** Cell ids ("col-row") that have a detail tile. */
  detail: string[];
}

/** The committed base topology, with the detail grid as a foreign member. */
export interface GlobeBase extends Topology {
  grid: GlobeGrid;
}

export const cellId = (col: number, row: number) => `${col}-${row}`;

/** The cell containing a point. Column 0 starts at 180°W, row 0 at 90°N. */
export function cellOf(lng: number, lat: number): { col: number; row: number } {
  const col = Math.min(CELL_COLS - 1, Math.max(0, Math.floor((lng + 180) / CELL_DEG)));
  const row = Math.min(CELL_ROWS - 1, Math.max(0, Math.floor((90 - lat) / CELL_DEG)));
  return { col, row };
}

/** A cell's bounds: [[west, south], [east, north]]. */
export function cellBounds(col: number, row: number): [[number, number], [number, number]] {
  const west = -180 + col * CELL_DEG;
  const north = 90 - row * CELL_DEG;
  return [
    [west, north - CELL_DEG],
    [west + CELL_DEG, north],
  ];
}
