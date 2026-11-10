import type { LngLat, Question, Tier } from './types';
import type { CountryLookup } from './countries';

export const ROUNDS = 7;
export const MAX_ROUND_SCORE = 1000;
export const MAX_SCORE = ROUNDS * MAX_ROUND_SCORE;

/** Mean Earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_MILE = 1.609344;

/**
 * Per-tier defaults. Points fall off with distance along a bell curve:
 * `k` is the distance beyond the bullseye at which a mark scores ~368
 * (1000/e), and `bullseyeKm` is the radius that earns the full 1,000.
 *
 * k grows with tier. Anyone who knows a famous event puts it within a few km,
 * so a 1,000 km miss on tier 1 is a real mistake; even experts can only place
 * a deep cut within a few hundred km. Later tiers stay harder because they
 * are obscure, not because the target shrinks.
 */
export const TIER_DEFAULTS: Record<Tier, { k: number; bullseyeKm: number }> = {
  1: { k: 1000, bullseyeKm: 30 },
  2: { k: 1125, bullseyeKm: 25 },
  3: { k: 1250, bullseyeKm: 20 },
  4: { k: 1375, bullseyeKm: 15 },
  5: { k: 1500, bullseyeKm: 15 },
  6: { k: 1625, bullseyeKm: 10 },
  7: { k: 1750, bullseyeKm: 10 },
};

/** Events at sea that don't set their own k use the tier's k times this. */
export const SEA_K_FACTOR = 1.25;

/**
 * The same-country floor, for events on land: a mark in the answer's modern
 * country, and within `maxDistanceKm` of it (which leaves out overseas
 * territories), scores at least `max` points, or less for big countries:
 * `max` up to an equivalent radius of `fullUpToKm`, `min` from `minFromKm`,
 * log-linear in between.
 */
export const COUNTRY_FLOOR = { max: 500, min: 250, fullUpToKm: 500, minFromKm: 1500, maxDistanceKm: 2500 } as const;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in km between two [lng, lat] points (haversine). */
export function haversineKm(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function scoringParams(q: Pick<Question, 'tier' | 'k' | 'bullseyeKm' | 'atSea'>): { k: number; bullseyeKm: number } {
  const d = TIER_DEFAULTS[q.tier];
  return { k: q.k ?? d.k * (q.atSea ? SEA_K_FACTOR : 1), bullseyeKm: q.bullseyeKm ?? d.bullseyeKm };
}

/** score = round(1000 · e^(−(d′/k)²)) with d′ = max(0, d − bullseyeKm). */
export function scoreForDistance(distanceKm: number, k: number, bullseyeKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  const d = Math.max(0, distanceKm - bullseyeKm);
  return Math.round(MAX_ROUND_SCORE * Math.exp(-((d / k) ** 2)));
}

/** The same-country floor for a country of equivalent radius `radiusKm`, in steps of 10. */
export function countryFloor(radiusKm: number): number {
  const { max, min, fullUpToKm, minFromKm } = COUNTRY_FLOOR;
  const t = Math.min(1, Math.max(0, Math.log(radiusKm / fullUpToKm) / Math.log(minFromKm / fullUpToKm)));
  return Math.round((max - (max - min) * t) / 10) * 10;
}

export interface Scored {
  score: number;
  /** Set when the same-country floor decided the score. */
  countryFloor?: number;
}

/**
 * Points for a mark `distanceKm` from the answer. `countryRadiusKm` is the
 * answer country's size when the mark is in that country, otherwise null.
 */
export function pointsFor(q: Pick<Question, 'tier' | 'k' | 'bullseyeKm' | 'atSea'>, distanceKm: number, countryRadiusKm: number | null = null): Scored {
  const { k, bullseyeKm } = scoringParams(q);
  const score = scoreForDistance(distanceKm, k, bullseyeKm);
  if (q.atSea || countryRadiusKm == null || !(distanceKm <= COUNTRY_FLOOR.maxDistanceKm)) return { score };
  const floor = countryFloor(countryRadiusKm);
  return floor > score ? { score: floor, countryFloor: floor } : { score };
}

/**
 * Scores a mark. With `countries`, a mark in the answer's country can earn the
 * same-country floor; without them (still loading, or failed), distance alone.
 */
export function scoreGuess(q: Question, guess: LngLat | null, countries: CountryLookup | null = null): Scored & { distanceKm: number } {
  if (!guess) return { distanceKm: Infinity, score: 0 };
  const distanceKm = haversineKm(guess, [q.lng, q.lat]);
  let countryRadiusKm: number | null = null;
  if (countries && !q.atSea && distanceKm <= COUNTRY_FLOOR.maxDistanceKm) {
    const answer = q.country ? countries.byCode(q.country) : countries.countryAt([q.lng, q.lat]);
    if (answer && countries.countryAt(guess)?.code === answer.code) countryRadiusKm = answer.radiusKm;
  }
  return { distanceKm, ...pointsFor(q, distanceKm, countryRadiusKm) };
}

export type Grade = 'great' | 'good' | 'fair' | 'poor';

/** Share squares: 🟩 900+, 🟨 600+, 🟧 300+, 🟥 below. */
export function gradeFor(score: number): Grade {
  if (score >= 900) return 'great';
  if (score >= 600) return 'good';
  if (score >= 300) return 'fair';
  return 'poor';
}

export const GRADE_EMOJI: Record<Grade, string> = { great: '🟩', good: '🟨', fair: '🟧', poor: '🟥' };

export function emojiFor(score: number): string {
  return GRADE_EMOJI[gradeFor(score)];
}

export type Units = 'km' | 'mi';

const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

export function formatNumber(n: number): string {
  return nf0.format(n);
}

export function formatDistance(km: number, units: Units): string {
  if (!Number.isFinite(km)) return '—';
  const v = units === 'km' ? km : km / KM_PER_MILE;
  return `${v < 10 ? nf1.format(v) : nf0.format(v)} ${units === 'km' ? 'km' : v === 1 ? 'mile' : 'miles'}`;
}

/** Spoiler-free share line, e.g. "Chronomap #42 — 5,830/7,000 🟩🟩🟨🟩🟧🟨🟥" ("Chronomap #42 · Archive — …" for a past day). */
export function shareText(puzzle: number, scores: number[], url?: string, archive = false, topPercent: number | null = null): string {
  const total = scores.reduce((a, b) => a + b, 0);
  const top = topPercent != null ? ` · Top ${topPercent}%` : '';
  const line = `Chronomap #${puzzle}${archive ? ' · Archive' : ''} — ${formatNumber(total)}/${formatNumber(MAX_SCORE)} ${scores.map(emojiFor).join('')}${top}`;
  return url ? `${line}\n${url}` : line;
}
