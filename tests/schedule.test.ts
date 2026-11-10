import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyPuzzle, extendSchedule, refreshSchedule, scheduleEnd, scheduledIds, type Schedule } from '../src/game/schedule.ts';
import { addDays, daysBetween, LAUNCH_DATE } from '../src/game/daily.ts';
import { TIERS, type Question, type Tier } from '../src/game/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schedule = JSON.parse(readFileSync(resolve(ROOT, 'src/data/schedule.json'), 'utf8')) as Schedule;
const bank = JSON.parse(readFileSync(resolve(ROOT, 'src/data/questions.json'), 'utf8')) as Question[];
const ids = (qs: Question[]) => qs.map((q) => q.id);

const question = (id: string, tier: Tier): Question => ({
  id, event: id, dateDisplay: '1900', year: 1900, tier, lat: 0, lng: 0, note: '', source: '',
});

/** Fresh questions for every tier, some sorting before the existing ids and some after. */
function newQuestions(perTier: number): Question[] {
  return TIERS.flatMap((t) =>
    Array.from({ length: perTier }, (_, i) => question(`t${t}-${i % 2 ? 'zz' : 'aa'}-new-${String(i).padStart(2, '0')}`, t)),
  );
}

test('puzzles already played are frozen', () => {
  // As served on the days themselves, before the schedule was committed.
  const played: Record<string, string[]> = {
    '2026-11-06': ['t1-hiroshima', 't2-thermopylae', 't3-guernica', 't4-actium', 't5-tsushima', 't6-imphal', 't7-majuba'],
    '2026-11-07': ['t1-colosseum', 't2-tutankhamun', 't3-columbus-landfall', 't4-sutters-mill', 't5-stamford-bridge', 't6-isurava', 't7-bear-paw'],
    '2026-11-08': ['t1-machu-picchu', 't2-jerusalem-1099', 't3-santiago-coup', 't4-nazca', 't5-talas', 't6-grunwald', 't7-peking-man'],
    '2026-11-09': ['t1-christ-redeemer', 't2-tenochtitlan', 't3-becket', 't4-marconi', 't5-ain-jalut', 't6-nile-aboukir', 't7-changping'],
    '2026-11-10': ['t1-suez-canal', 't2-moai', 't3-trafalgar', 't4-boyne', 't5-poltava', 't6-pharsalus', 't7-numantia'],
  };
  for (const [day, expected] of Object.entries(played)) assert.deepEqual(ids(dailyPuzzle(bank, schedule, day).questions), expected, day);
  assert.equal(schedule.start, LAUNCH_DATE);
});

test('adding questions to the bank changes no scheduled puzzle', () => {
  const grown = [...newQuestions(25), ...bank];
  for (let day = schedule.start; daysBetween(day, scheduleEnd(schedule)) >= 0; day = addDays(day, 1)) {
    assert.deepEqual(ids(dailyPuzzle(grown, schedule, day).questions), ids(dailyPuzzle(bank, schedule, day).questions), day);
  }
  // Extending with the bigger bank only appends: every existing day is untouched.
  const extended = extendSchedule(schedule, grown, addDays(scheduleEnd(schedule), 120));
  assert.deepEqual(extended.days.slice(0, schedule.days.length), schedule.days);
  assert.equal(extended.days.length, schedule.days.length + 120);
});

test('every day is one question per tier, in tier order', () => {
  const byId = new Map(bank.map((q) => [q.id, q]));
  for (const day of schedule.days) assert.deepEqual(day.map((id) => byId.get(id)?.tier), [...TIERS]);
});

test('new days: no repeats within a cycle, never the same question two days running', () => {
  for (const size of [3, 7, 40]) {
    const pool = TIERS.flatMap((t) => Array.from({ length: size }, (_, i) => question(`t${t}-q${String(i).padStart(3, '0')}`, t)));
    const s = extendSchedule({ start: '2030-01-01', days: [] }, pool, addDays('2030-01-01', size * 5 - 1));
    for (const [ti] of TIERS.entries()) {
      const run = s.days.map((d) => d[ti]);
      for (let c = 0; c < 5; c++) assert.equal(new Set(run.slice(c * size, (c + 1) * size)).size, size, `pool ${size}, cycle ${c}`);
      for (let d = 1; d < run.length; d++) assert.notEqual(run[d], run[d - 1], `pool ${size}, day ${d}`);
    }
  }
});

test('questions added mid-cycle are played before anything repeats', () => {
  const pool = TIERS.flatMap((t) => Array.from({ length: 40 }, (_, i) => question(`t${t}-q${String(i).padStart(3, '0')}`, t)));
  const first = extendSchedule({ start: '2030-01-01', days: [] }, pool, '2030-01-10'); // 10 days into a 40-day cycle
  const grown = [...pool, ...newQuestions(5)];
  const s = extendSchedule(first, grown, addDays('2030-01-01', 44));
  assert.deepEqual(s.days.slice(0, 10), first.days);
  for (const [ti, t] of TIERS.entries()) {
    const run = s.days.map((d) => d[ti]);
    assert.equal(new Set(run).size, 45, `tier ${t}: all 45 questions before any repeat`);
  }
});

test('days past the committed schedule still work, and agree with extending it', () => {
  const later = addDays(scheduleEnd(schedule), 30);
  assert.equal(scheduledIds(schedule, later), null);
  const a = ids(dailyPuzzle(bank, schedule, later).questions);
  assert.deepEqual(a, scheduledIds(extendSchedule(schedule, bank, later), later));
  assert.deepEqual(ids(dailyPuzzle([...bank].reverse(), schedule, later).questions), a, 'bank order does not matter');
  assert.throws(() => dailyPuzzle(bank, schedule, addDays(LAUNCH_DATE, -1)));
  assert.throws(() => dailyPuzzle(bank.filter((q) => q.id !== 't1-hiroshima'), schedule, LAUNCH_DATE), /t1-hiroshima/);
});

test('refreshing redraws only future days, and brings new questions in', () => {
  const tomorrow = '2026-11-11';
  const from = '2026-11-12';
  const grown = [...bank, ...newQuestions(5)];
  const s = refreshSchedule(schedule, grown, from);
  const keep = daysBetween(schedule.start, from);
  assert.deepEqual(s.days.slice(0, keep), schedule.days.slice(0, keep), 'launch to tomorrow untouched');
  assert.deepEqual(scheduledIds(s, tomorrow), scheduledIds(schedule, tomorrow));
  assert.equal(scheduleEnd(s), scheduleEnd(schedule));
  // The new questions turn up within one 45-question cycle.
  const fresh = new Set(newQuestions(5).map((q) => q.id));
  const soon = new Set(s.days.slice(keep, keep + 45).flat().filter((id) => fresh.has(id)));
  assert.equal(soon.size, fresh.size);
});
