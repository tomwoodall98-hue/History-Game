/**
 * Daily puzzle selection.
 *
 * Every player sees the same seven questions on the same calendar day in
 * Europe/London; the puzzle changes at local midnight there (GMT in winter,
 * BST in summer).
 *
 * Each tier is played in "cycles". A cycle shows every question in the tier
 * once, in an order shuffled by a PRNG seeded with the tier and the cycle
 * number, so no question repeats until the whole pool has been used. A new
 * cycle never opens with the question that closed the previous one.
 */
import { TIERS, type Question, type Tier } from './types';

/** Puzzle No. 1 was played on this London date. */
export const LAUNCH_DATE = '2026-11-06';
export const TIME_ZONE = 'Europe/London';
const DAY_MS = 86_400_000;

// ----------------------------------------------------------- dates ---

const keyFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function parts(fmt: Intl.DateTimeFormat, date: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** The London calendar date of an instant, as YYYY-MM-DD. */
export function londonDateKey(now: Date = new Date()): string {
  const p = parts(keyFormatter, now);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** London's offset from UTC at an instant, in minutes (0 for GMT, 60 for BST). */
export function londonOffsetMinutes(at: Date): number {
  const p = parts(clockFormatter, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant of the next midnight in London after `now`. */
export function nextLondonMidnight(now: Date = new Date()): Date {
  const [y, m, d] = londonDateKey(now).split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d + 1); // that midnight, read as if London were UTC
  // DST changes happen at 01:00 UTC, never at midnight, so one correction suffices.
  return new Date(naive - londonOffsetMinutes(new Date(naive)) * 60_000);
}

/** Whole days from date key a to date key b (b − a). */
export function daysBetween(a: string, b: string): number {
  const toUtc = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Day 0 is launch day; puzzle number is day + 1. */
export function dayIndex(dateKey: string): number {
  return daysBetween(LAUNCH_DATE, dateKey);
}

export function puzzleNumber(dateKey: string): number {
  return dayIndex(dateKey) + 1;
}

/** "Friday 6 November 2026". */
export function formatDateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .replace(',', '');
}

// ------------------------------------------------------------ PRNG ---

/** cyrb53-style string hash → 32-bit seed. */
export function hashSeed(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** mulberry32: small, fast, well-distributed 32-bit PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle of 0..n-1 driven by a seeded PRNG. */
export function seededPermutation(n: number, seedText: string): number[] {
  const rand = mulberry32(hashSeed(seedText));
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const mod = (a: number, b: number) => ((a % b) + b) % b;

/**
 * The order in which a tier's pool is played during one cycle. If the shuffle
 * would open with the question that ended the previous cycle, the first two
 * are swapped so the same question never appears on consecutive days.
 */
export function cycleOrder(tier: Tier, cycle: number, poolSize: number): number[] {
  const order = seededPermutation(poolSize, `chronomap/${tier}/${cycle}`);
  if (poolSize >= 3) {
    const previous = seededPermutation(poolSize, `chronomap/${tier}/${cycle - 1}`);
    if (order[0] === previous[poolSize - 1]) [order[0], order[1]] = [order[1], order[0]];
  }
  return order;
}

/** Questions grouped by tier, each pool sorted by id so order is stable. */
export function poolsByTier(questions: Question[]): Record<Tier, Question[]> {
  const pools = Object.fromEntries(TIERS.map((t) => [t, [] as Question[]])) as unknown as Record<Tier, Question[]>;
  for (const q of questions) pools[q.tier]?.push(q);
  for (const t of TIERS) pools[t].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return pools;
}

/** The question for one tier on a given day (day 0 = launch). */
export function questionForDay(pool: Question[], tier: Tier, day: number): Question {
  if (!pool.length) throw new Error(`No questions in tier ${tier}`);
  const cycle = floorDiv(day, pool.length);
  const order = cycleOrder(tier, cycle, pool.length);
  return pool[order[mod(day, pool.length)]];
}

export interface DailySelection {
  dateKey: string;
  number: number;
  dateLabel: string;
  questions: Question[];
}

/** Today's (or any day's) seven questions, Q1 = tier 1 … Q7 = tier 7. */
export function dailyPuzzle(questions: Question[], dateKey: string = londonDateKey()): DailySelection {
  const pools = poolsByTier(questions);
  const day = dayIndex(dateKey);
  return {
    dateKey,
    number: day + 1,
    dateLabel: formatDateLabel(dateKey),
    questions: TIERS.map((t) => questionForDay(pools[t], t, day)),
  };
}
