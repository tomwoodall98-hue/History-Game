/**
 * The puzzle schedule: which seven questions are played on which day.
 *
 * The schedule is a committed ledger (src/data/schedule.json) with one row of
 * seven question ids per day from launch, Q1 (tier 1) … Q7 (tier 7). Once a
 * day is in the ledger it never changes, whatever happens to the question
 * bank later, so past puzzles stay exactly as they were played and the
 * archive can replay them. `npm run schedule:extend` appends days, and with
 * `--refresh` redraws only days nobody can have seen yet (after tomorrow), so
 * new questions needn't wait for the schedule to run out.
 *
 * New days follow the same rules as before, tier by tier: a "cycle" plays
 * every question in the tier's pool once before any repeats, in a seeded
 * random order, and the same question never appears two days running. A
 * question added to the bank joins the cycle in progress, so it comes up
 * within one pool's worth of days.
 */
import { TIERS, type Question, type Tier } from './types';
import { addDays, daysBetween, dayIndex, formatDateLabel, londonDateKey } from './daily';

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

export interface Schedule {
  /** The date of days[0]: launch day, YYYY-MM-DD in Europe/London. */
  start: string;
  /** Question ids for each day in order, one per tier. */
  days: string[][];
}

/** The last date the schedule covers. */
export function scheduleEnd(s: Schedule): string {
  return addDays(s.start, s.days.length - 1);
}

/** The ids scheduled for a date, or null outside the schedule. */
export function scheduledIds(s: Schedule, dateKey: string): string[] | null {
  const i = daysBetween(s.start, dateKey);
  return i >= 0 && i < s.days.length ? s.days[i] : null;
}

interface TierState {
  /** Ids played since the current cycle began. */
  used: Set<string>;
  /** Yesterday's id. */
  last: string | null;
}

/** Replays a tier's history to find where its current cycle stands. A repeat marks a new cycle. */
function replay(history: string[]): TierState {
  let used = new Set<string>();
  for (const id of history) {
    if (used.has(id)) used = new Set();
    used.add(id);
  }
  return { used, last: history.at(-1) ?? null };
}

function pick(pool: string[], state: TierState, tier: Tier, dateKey: string): string {
  let remaining = pool.filter((id) => !state.used.has(id));
  if (!remaining.length) {
    state.used.clear(); // the cycle is complete: start another
    remaining = pool;
  }
  if (remaining.length > 1 && state.last) remaining = remaining.filter((id) => id !== state.last);
  const id = remaining[Math.floor(mulberry32(hashSeed(`chronomap/${tier}/${dateKey}`))() * remaining.length)];
  state.used.add(id);
  state.last = id;
  return id;
}

/**
 * The schedule extended to cover `until`, using the current bank. Days
 * already in the schedule are kept as they are.
 */
export function extendSchedule(s: Schedule, questions: Question[], until: string): Schedule {
  const total = daysBetween(s.start, until) + 1;
  if (total <= s.days.length) return s;
  const pools = TIERS.map((t) => {
    const pool = questions.filter((q) => q.tier === t).map((q) => q.id);
    if (!pool.length) throw new Error(`No questions in tier ${t}`);
    return pool.sort();
  });
  const states = TIERS.map((_, ti) => replay(s.days.map((day) => day[ti])));
  const days = s.days.slice();
  for (let i = days.length; i < total; i++) {
    const dateKey = addDays(s.start, i);
    days.push(TIERS.map((t, ti) => pick(pools[ti], states[ti], t, dateKey)));
  }
  return { start: s.start, days };
}

/**
 * Redraws every day from `from` to the schedule's end with the current bank,
 * keeping all days before `from` exactly as they are.
 */
export function refreshSchedule(s: Schedule, questions: Question[], from: string): Schedule {
  const keep = Math.max(0, Math.min(s.days.length, daysBetween(s.start, from)));
  return extendSchedule({ start: s.start, days: s.days.slice(0, keep) }, questions, scheduleEnd(s));
}

/** JSON with one day per line, so additions read clearly in a diff. */
export function formatSchedule(s: Schedule): string {
  const rows = s.days.map((d, i) => `    ${JSON.stringify(d)}${i < s.days.length - 1 ? ',' : ''}`);
  return `{\n  "start": ${JSON.stringify(s.start)},\n  "days": [\n${rows.join('\n')}\n  ]\n}\n`;
}

export interface DailySelection {
  dateKey: string;
  number: number;
  dateLabel: string;
  questions: Question[];
}

/**
 * Any day's seven questions, Q1 = tier 1 … Q7 = tier 7. Days past the end of
 * the committed schedule are worked out from the current bank (the validator
 * warns long before that happens, so they can be committed first).
 */
export function dailyPuzzle(questions: Question[], schedule: Schedule, dateKey: string = londonDateKey()): DailySelection {
  if (daysBetween(schedule.start, dateKey) < 0) throw new Error(`No puzzle before ${schedule.start}`);
  const ids = scheduledIds(schedule, dateKey) ?? scheduledIds(extendSchedule(schedule, questions, dateKey), dateKey)!;
  const byId = new Map(questions.map((q) => [q.id, q]));
  return {
    dateKey,
    number: dayIndex(dateKey) + 1,
    dateLabel: formatDateLabel(dateKey),
    questions: ids.map((id) => {
      const q = byId.get(id);
      if (!q) throw new Error(`Scheduled question ${id} (${dateKey}) is not in the bank`);
      return q;
    }),
  };
}
