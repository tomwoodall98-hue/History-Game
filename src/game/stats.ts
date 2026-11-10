/**
 * Anonymous daily stats: the shape the server returns, and the arithmetic
 * behind what the results screen shows. No DOM here, so it is easy to test.
 */
import { MAX_ROUND_SCORE, MAX_SCORE, ROUNDS } from './scoring';

/** Width of a histogram band, in points. */
export const BAND = 500;
/** Bands from 0–499 up to 6,500–7,000 (a perfect 7,000 counts in the last). */
export const BANDS = MAX_SCORE / BAND;
/** Below this many players, the numbers come with an "early days" note. */
export const EARLY_DAYS_PLAYERS = 5;

/** Aggregates for one puzzle day, as daily_stats() returns them. */
export interface DayStats {
  date: string;
  players: number;
  /** Average total, or null with no players. */
  average: number | null;
  /** Players per band of BAND points, BANDS entries. */
  histogram: number[];
  /** Average score for each question, Q1 … Q7 (null with no players). */
  questionAverages: (number | null)[];
  /** Share of players (0–100) who scored less than the score asked about. */
  percentile: number | null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNumOrNull = (v: unknown, max: number): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max);

/** Checks a server reply; anything malformed is treated as "stats unavailable". */
export function parseStats(raw: unknown): DayStats | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  if (!isCount(r.players) || !isNumOrNull(r.average, MAX_SCORE) || !isNumOrNull(r.percentile, 100)) return null;
  if (!Array.isArray(r.histogram) || r.histogram.length !== BANDS || !r.histogram.every(isCount)) return null;
  if (!Array.isArray(r.questionAverages) || r.questionAverages.length !== ROUNDS) return null;
  if (!r.questionAverages.every((v) => isNumOrNull(v, MAX_ROUND_SCORE))) return null;
  return {
    date: r.date,
    players: r.players,
    average: r.average,
    histogram: r.histogram,
    questionAverages: r.questionAverages,
    percentile: r.percentile,
  };
}

/** Which band a total falls in. */
export function bandOf(score: number): number {
  return Math.max(0, Math.min(BANDS - 1, Math.floor(score / BAND)));
}

/**
 * "You scored better than X% of players": rounded down, so nobody is told
 * they beat everyone unless they did.
 */
export function betterThan(stats: DayStats): number | null {
  if (stats.percentile == null || stats.players === 0) return null;
  return Math.max(0, Math.min(100, Math.floor(stats.percentile + 1e-9)));
}

/**
 * "Top X%" for the share line, or null when it would say little: fewer than
 * EARLY_DAYS_PLAYERS players, or outside the top half.
 */
export function topPercent(stats: DayStats): number | null {
  if (stats.percentile == null || stats.players < EARLY_DAYS_PLAYERS) return null;
  const top = Math.max(1, Math.ceil(100 - stats.percentile - 1e-9));
  return top <= 50 ? top : null;
}

export const isEarlyDays = (stats: DayStats) => stats.players < EARLY_DAYS_PLAYERS;

/** The question with the lowest average (0-based), or null if there are none. */
export function hardestQuestion(stats: DayStats): number | null {
  let best: number | null = null;
  stats.questionAverages.forEach((v, i) => {
    if (v != null && (best == null || v < stats.questionAverages[best]!)) best = i;
  });
  return best;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bar extends Rect {
  band: number;
  count: number;
  /** Lowest and highest totals the band holds. */
  from: number;
  to: number;
}

/** Bars for the histogram inside `plot`, scaled so the tallest band fills it. */
export function histogramBars(histogram: number[], plot: Rect, gap = 2): Bar[] {
  const max = Math.max(1, ...histogram);
  const slot = plot.w / histogram.length;
  return histogram.map((count, band) => {
    const h = (count / max) * plot.h;
    return {
      band,
      count,
      from: band * BAND,
      to: band === histogram.length - 1 ? MAX_SCORE : (band + 1) * BAND - 1,
      x: plot.x + band * slot + gap / 2,
      y: plot.y + plot.h - h,
      w: slot - gap,
      h,
    };
  });
}

/** Where a total sits along the histogram's axis. */
export function scoreX(score: number, plot: Rect): number {
  return plot.x + (Math.max(0, Math.min(MAX_SCORE, score)) / MAX_SCORE) * plot.w;
}
