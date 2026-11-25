import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalQuery, resolveRoute, routeQuery } from '../src/game/route.ts';

const TODAY = '2026-11-25';
const playedDays = new Set(['2026-11-20', TODAY]);
const route = (search: string) => resolveRoute(search, TODAY, (d) => playedDays.has(d));

test('today, the archive, and the two new modes', () => {
  assert.deepEqual(route(''), { day: TODAY, archive: false, mode: 'play' });
  assert.deepEqual(route('?day=2026-11-21'), { day: '2026-11-21', archive: true, mode: 'play' });
  assert.deepEqual(route('?day=2026-11-20&mode=review'), { day: '2026-11-20', archive: true, mode: 'review' });
  assert.deepEqual(route('?day=2026-11-20&mode=practice'), { day: '2026-11-20', archive: true, mode: 'practice' });
  assert.deepEqual(route(`?day=${TODAY}&mode=review`), { day: TODAY, archive: false, mode: 'review' }, 'today can be reviewed once played');
});

test('anything that does not apply falls back', () => {
  // Review or practice need an original result: unplayed days are simply played.
  assert.deepEqual(route('?day=2026-11-21&mode=review'), { day: '2026-11-21', archive: true, mode: 'play' });
  assert.deepEqual(route('?day=2026-11-21&mode=practice'), { day: '2026-11-21', archive: true, mode: 'play' });
  // Today is never practised, and the future or nonsense is today.
  assert.deepEqual(route(`?day=${TODAY}&mode=practice`), { day: TODAY, archive: false, mode: 'play' });
  assert.deepEqual(route(`?day=${TODAY}`), { day: TODAY, archive: false, mode: 'play' });
  assert.deepEqual(route('?day=2027-01-01&mode=review'), { day: TODAY, archive: false, mode: 'play' });
  assert.deepEqual(route('?day=yesterday'), { day: TODAY, archive: false, mode: 'play' });
  assert.deepEqual(route('?day=2026-11-20&mode=delete'), { day: '2026-11-20', archive: true, mode: 'play' });
  const unplayedToday = resolveRoute(`?day=${TODAY}&mode=review`, TODAY, () => false);
  assert.deepEqual(unplayedToday, { day: TODAY, archive: false, mode: 'play' });
});

test('links and the tidied address', () => {
  assert.equal(routeQuery(), '');
  assert.equal(routeQuery('2026-11-20'), '?day=2026-11-20');
  assert.equal(routeQuery('2026-11-20', 'practice'), '?day=2026-11-20&mode=practice');
  assert.equal(canonicalQuery(route('?day=2026-11-20&mode=practice'), TODAY), '?day=2026-11-20&mode=practice');
  assert.equal(canonicalQuery(route('?mode=review&day=2026-11-20'), TODAY), '?day=2026-11-20&mode=review');
  assert.equal(canonicalQuery(route('?day=2099-01-01'), TODAY), '');
  assert.equal(canonicalQuery(route(`?day=${TODAY}&mode=review`), TODAY), `?day=${TODAY}&mode=review`);
});
