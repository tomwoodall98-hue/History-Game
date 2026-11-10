/**
 * Appends days to the puzzle schedule (src/data/schedule.json).
 *
 *   npm run schedule:extend                       cover a year from today
 *   npm run schedule:extend -- --until 2028-12-31
 *   npm run schedule:extend -- --refresh          after adding questions
 *
 * New days are drawn from the current question bank, and days already in the
 * schedule are kept, so past puzzles (and the archive) stay exactly as they
 * were played. `--refresh` also redraws the scheduled days after tomorrow,
 * which nobody can have seen yet, so newly added questions join the cycles in
 * progress straight away instead of waiting for the schedule to run out.
 * Today and tomorrow are never touched (a deploy can land either side of
 * midnight). Commit the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, londonDateKey } from '../src/game/daily.ts';
import { extendSchedule, formatSchedule, refreshSchedule, scheduleEnd, type Schedule } from '../src/game/schedule.ts';
import type { Question } from '../src/game/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEDULE = resolve(ROOT, 'src/data/schedule.json');
const args = process.argv.slice(2);
const until = args.includes('--until') ? args[args.indexOf('--until') + 1] : addDays(londonDateKey(), 365);
if (!/^\d{4}-\d{2}-\d{2}$/.test(until ?? '') || addDays(until, 0) !== until) {
  console.error(`--until must be a date, YYYY-MM-DD (got ${until})`);
  process.exit(1);
}

const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8')) as Schedule;
const questions = JSON.parse(readFileSync(resolve(ROOT, 'src/data/questions.json'), 'utf8')) as Question[];
const refreshFrom = addDays(londonDateKey(), 2);
const refreshed = args.includes('--refresh') ? refreshSchedule(schedule, questions, refreshFrom) : schedule;
const next = extendSchedule(refreshed, questions, until);
const changed = schedule.days.filter((d, i) => next.days[i]?.join() !== d.join()).length;
if (next.days.length === schedule.days.length && !changed) {
  console.log(`The schedule already runs to ${scheduleEnd(schedule)}; nothing to change.`);
} else {
  writeFileSync(SCHEDULE, formatSchedule(next));
  if (changed) console.log(`Redrew ${changed} future days from ${refreshFrom} with the current bank.`);
  console.log(`The schedule now runs to ${scheduleEnd(next)} (${next.days.length - schedule.days.length} days added).`);
}
