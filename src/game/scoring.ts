import type { LngLat, Question, Tier } from './types';

export const ROUNDS = 7;
export const MAX_ROUND_SCORE = 1000;
export const MAX_SCORE = ROUNDS * MAX_ROUND_SCORE;

/** Mean Earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_MILE = 1.609344;

/**
 * Per-tier defaults. `k` is the distance at which the score falls to ~368
 * (1000/e); `bullseyeKm` is the radius that earns the full 1,000. Later
 * tiers ask for more precision as well as more knowledge.
 */
export const TIER_DEFAULTS: Record<Tier, { k: number; bullseyeKm: number }> = {
  1: { k: 1200, bullseyeKm: 30 },
  2: { k: 1000, bullseyeKm: 25 },
  3: { k: 800, bullseyeKm: 20 },
  4: { k: 650, bullseyeKm: 15 },
  5: { k: 500, bullseyeKm: 15 },
  6: { k: 400, bullseyeKm: 10 },
  7: { k: 300, bullseyeKm: 10 },
};

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

export function scoringParams(q: Pick<Question, 'tier' | 'k' | 'bullseyeKm'>): { k: number; bullseyeKm: number } {
  const d = TIER_DEFAULTS[q.tier];
  return { k: q.k ?? d.k, bullseyeKm: q.bullseyeKm ?? d.bullseyeKm };
}

/** score = round(1000 · e^(−d/k)), or 1000 inside the bullseye. */
export function scoreForDistance(distanceKm: number, k: number, bullseyeKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  if (distanceKm <= bullseyeKm) return MAX_ROUND_SCORE;
  return Math.round(MAX_ROUND_SCORE * Math.exp(-distanceKm / k));
}

export function scoreGuess(q: Question, guess: LngLat | null): { distanceKm: number; score: number } {
  if (!guess) return { distanceKm: Infinity, score: 0 };
  const distanceKm = haversineKm(guess, [q.lng, q.lat]);
  const { k, bullseyeKm } = scoringParams(q);
  return { distanceKm, score: scoreForDistance(distanceKm, k, bullseyeKm) };
}

export type Grade = 'great' | 'good' | 'fair' | 'poor';

export function gradeFor(score: number): Grade {
  if (score >= 800) return 'great';
  if (score >= 500) return 'good';
  if (score >= 200) return 'fair';
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

/** Spoiler-free share line, e.g. "Chronomap #42 — 5,830/7,000 🟩🟩🟨🟩🟧🟨🟥". */
export function shareText(puzzle: number, scores: number[], url?: string): string {
  const total = scores.reduce((a, b) => a + b, 0);
  const line = `Chronomap #${puzzle} — ${formatNumber(total)}/${formatNumber(MAX_SCORE)} ${scores.map(emojiFor).join('')}`;
  return url ? `${line}\n${url}` : line;
}
