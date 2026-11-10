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
  archiveDays,
  isArchiveDay,
  LAUNCH_DATE,
} from '../src/game/daily.ts';

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

test('the archive runs from launch to yesterday: never today, never the future', () => {
  assert.deepEqual(archiveDays(LAUNCH_DATE), []);
  assert.deepEqual(archiveDays('2026-11-10'), ['2026-11-09', '2026-11-08', '2026-11-07', '2026-11-06']);
  assert.equal(isArchiveDay('2026-11-09', '2026-11-10'), true);
  assert.equal(isArchiveDay(LAUNCH_DATE, '2026-11-10'), true);
  assert.equal(isArchiveDay('2026-11-10', '2026-11-10'), false, 'today');
  assert.equal(isArchiveDay('2026-11-11', '2026-11-10'), false, 'tomorrow');
  assert.equal(isArchiveDay('2026-11-05', '2026-11-10'), false, 'before launch');
  assert.equal(isArchiveDay('2026-02-30', '2027-01-01'), false, 'not a date');
  assert.equal(isArchiveDay('9 Nov', '2026-11-10'), false);
});
