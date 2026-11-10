/**
 * Puzzle dates.
 *
 * Every player sees the same seven questions on the same calendar day in
 * Europe/London; the puzzle changes at local midnight there (GMT in winter,
 * BST in summer). Which questions those are comes from the schedule
 * (schedule.ts).
 */

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

/** Past puzzles open to the archive on `todayKey`, newest first: launch day to yesterday. */
export function archiveDays(todayKey: string): string[] {
  const out: string[] = [];
  for (let d = addDays(todayKey, -1); daysBetween(LAUNCH_DATE, d) >= 0; d = addDays(d, -1)) out.push(d);
  return out;
}

/** Whether `key` is a real date the archive offers on `todayKey` (not today, not the future). */
export function isArchiveDay(key: string, todayKey: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && addDays(key, 0) === key && daysBetween(LAUNCH_DATE, key) >= 0 && daysBetween(key, todayKey) >= 1;
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
