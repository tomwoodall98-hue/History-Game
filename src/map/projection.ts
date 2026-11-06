import { geoMercator, type GeoProjection } from 'd3-geo';

/**
 * Shared map geometry. The base map lives in a fixed coordinate space
 * (MAP_WIDTH × MAP_HEIGHT "map units"); pan/zoom is applied as a transform
 * on top of it, so geometry is projected exactly once.
 */
export const MAP_WIDTH = 1000;
/** Northern and southern clip latitudes. */
export const LAT_NORTH = 80;
export const LAT_SOUTH = -75;
/**
 * Central meridian. 11°E puts the map's cut at 169°W, through the Bering
 * Strait, so no continent is split (a Greenwich-centred sheet would slice
 * Chukotka and Fiji).
 */
export const CENTRAL_MERIDIAN = 11;

const mercY = (latDeg: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));

export const MAP_SCALE = MAP_WIDTH / (2 * Math.PI);
export const MAP_HEIGHT = MAP_SCALE * (mercY(LAT_NORTH) - mercY(LAT_SOUTH));

/**
 * Mercator projection into map units, clipped to LAT_SOUTH..LAT_NORTH.
 * `precision` controls d3's adaptive resampling; 0 disables it, which is fine
 * for dense coastline data whose segments are already short.
 */
export function createProjection(precision = 0): GeoProjection {
  return geoMercator()
    .rotate([-CENTRAL_MERIDIAN, 0])
    .scale(MAP_SCALE)
    .translate([MAP_WIDTH / 2, MAP_SCALE * mercY(LAT_NORTH)])
    .clipExtent([
      [0, 0],
      [MAP_WIDTH, MAP_HEIGHT],
    ])
    .precision(precision);
}

/** Normalise a longitude into [-180, 180). */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}
