import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  londonDateKey,
  londonOffsetMinutes,
  nextLondonMidnight,
  dayIndex,
  puzzleNumber,
  formatDateLabel,
  addDays,
  daysBetween,
  dailyPuzzle,
  questionForDay,
  poolsByTier,
  seededPermutation,
  LAUNCH_DATE,
} from '../src/game/daily.ts';
import { TIERS, type Question, type Tier } from '../src/game/types.ts';

const utc = (s: string) => new Date(s);

test('London calendar date, GMT and BST', () => {
  assert.equal(londonDateKey(utc('2026-11-06T23:59:59Z')), '2026-11-06'); // GMT
  assert.equal(londonDateKey(utc('2026-11-07T00:00:00Z')), '2026-11-07');
  assert.equal(londonDateKey(utc('2026-07-01T22:59:59Z')), '2026-07-01'); // BST
  assert.equal(londonDateKey(utc('2026-07-01T23:00:00Z')), '2026-07-02');
  assert.equal(londonDateKey(utc('2026-12-31T23:30:00Z')), '2026-12-31');
});

test('London UTC offset', () => {
  assert.equal(londonOffsetMinutes(utc('2026-01-15T12:00:00Z')), 0);
  assert.equal(londonOffsetMinutes(utc('2026-07-15T12:00:00Z')), 60);
  // Clocks go forward at 01:00 UTC on 29 March 2026 and back at 01:00 UTC on 25 October 2026.
  assert.equal(londonOffsetMinutes(utc('2026-03-29T00:59:59Z')), 0);
  assert.equal(londonOffsetMinutes(utc('2026-03-29T01:00:00Z')), 60);
  assert.equal(londonOffsetMinutes(utc('2026-10-25T00:59:59Z')), 60);
  assert.equal(londonOffsetMinutes(utc('2026-10-25T01:00:00Z')), 0);
});

test('next puzzle arrives at London midnight, across DST changes', () => {
  const next = (s: string) => nextLondonMidnight(utc(s)).toISOString();
  assert.equal(next('2026-11-06T12:00:00Z'), '2026-11-07T00:00:00.000Z');
  assert.equal(next('2026-07-01T12:00:00Z'), '2026-07-01T23:00:00.000Z');
  assert.equal(next('2026-07-01T23:30:00Z'), '2026-07-02T23:00:00.000Z');
  assert.equal(next('2026-03-28T12:00:00Z'), '2026-03-29T00:00:00.000Z'); // night before spring forward
  assert.equal(next('2026-03-29T12:00:00Z'), '2026-03-29T23:00:00.000Z');
  assert.equal(next('2026-10-24T12:00:00Z'), '2026-10-24T23:00:00.000Z'); // night before fall back
  assert.equal(next('2026-10-25T12:00:00Z'), '2026-10-26T00:00:00.000Z');
});

test('day arithmetic and puzzle numbers', () => {
  assert.equal(dayIndex(LAUNCH_DATE), 0);
  assert.equal(puzzleNumber(LAUNCH_DATE), 1);
  assert.equal(puzzleNumber(addDays(LAUNCH_DATE, 41)), 42);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2); // leap year
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(formatDateLabel('2026-11-06'), 'Friday 6 November 2026');
});

test('seeded permutation is deterministic and a true permutation', () => {
  const a = seededPermutation(40, 'x');
  assert.deepEqual(a, seededPermutation(40, 'x'));
  assert.notDeepEqual(a, seededPermutation(40, 'y'));
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 40 }, (_, i) => i));
});

function fakeBank(perTier: number): Question[] {
  const qs: Question[] = [];
  for (const tier of TIERS) {
    for (let i = 0; i < perTier; i++) {
      qs.push({
        id: `t${tier}-q${String(i).padStart(3, '0')}`,
        event: `Event ${tier}/${i}`,
        dateDisplay: '1900',
        year: 1900,
        tier,
        lat: 0,
        lng: 0,
        note: '',
        source: '',
      });
    }
  }
  return qs;
}

test('no repeats within a cycle; never the same question two days running', () => {
  for (const size of [3, 7, 40, 41]) {
    const pools = poolsByTier(fakeBank(size));
    for (const tier of [1, 4, 7] as Tier[]) {
      const pool = pools[tier];
      for (let cycle = -2; cycle < 6; cycle++) {
        const ids = new Set<string>();
        for (let d = cycle * size; d < (cycle + 1) * size; d++) ids.add(questionForDay(pool, tier, d).id);
        assert.equal(ids.size, size, `tier ${tier}, pool ${size}, cycle ${cycle}`);
      }
      for (let d = -50; d < 400; d++) {
        assert.notEqual(
          questionForDay(pool, tier, d).id,
          questionForDay(pool, tier, d + 1).id,
          `tier ${tier}, pool ${size}, day ${d}`,
        );
      }
    }
  }
});

test('daily puzzle: one question per tier, in order, the same for everyone', () => {
  const bank = fakeBank(40);
  const a = dailyPuzzle(bank, '2027-03-14');
  const b = dailyPuzzle([...bank].reverse(), '2027-03-14'); // input order doesn't matter
  assert.deepEqual(a.questions.map((q) => q.tier), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(a.questions.map((q) => q.id), b.questions.map((q) => q.id));
  assert.equal(a.number, daysBetween(LAUNCH_DATE, '2027-03-14') + 1);
  const c = dailyPuzzle(bank, '2027-03-15');
  assert.notDeepEqual(a.questions.map((q) => q.id), c.questions.map((q) => q.id));
});
