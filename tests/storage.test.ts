import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, parseStored, LocalStore, type HistoryEntry } from '../src/game/storage.ts';
import type { SavedGame } from '../src/game/types.ts';

const h = (...scores: number[]): HistoryEntry => ({ p: 1, s: scores });

test('streaks count consecutive London days', () => {
  const history = {
    '2026-11-01': h(500, 500, 500, 500, 500, 500, 500),
    '2026-11-02': h(1000, 0, 0, 0, 0, 0, 0),
    '2026-11-04': h(100, 100, 100, 100, 100, 100, 100),
    '2026-11-05': h(0, 0, 0, 0, 0, 0, 0),
    '2026-11-06': h(700, 700, 700, 700, 700, 700, 700),
  };
  const s = computeStats(history, '2026-11-06');
  assert.equal(s.played, 5);
  assert.equal(s.currentStreak, 3);
  assert.equal(s.maxStreak, 3);
  assert.equal(s.averageScore, Math.round((3500 + 1000 + 700 + 0 + 4900) / 5));
  assert.equal(s.bestScore, 4900);
  // Today not yet played: the streak still stands from yesterday...
  assert.equal(computeStats(history, '2026-11-07').currentStreak, 3);
  // ...but a missed day breaks it.
  assert.equal(computeStats(history, '2026-11-08').currentStreak, 0);
  assert.deepEqual(computeStats({}, '2026-11-06'), { played: 0, currentStreak: 0, maxStreak: 0, averageScore: 0, bestScore: 0 });
});

test('malformed storage is ignored, not trusted', () => {
  assert.equal(parseStored(null).current, null);
  assert.equal(parseStored('not json').current, null);
  assert.deepEqual(parseStored('{"history":{"bad-key":{"p":1,"s":[1]},"2026-11-06":{"p":1,"s":["x"]}}}').history, {});
  assert.equal(parseStored('{"units":"furlongs"}').units, 'km');
  assert.equal(parseStored('{"current":{"dateKey":5}}').current, null);
});

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const game = (dateKey: string, finished: boolean, scores: number[]): SavedGame => ({
  dateKey,
  puzzle: 3,
  questionIds: scores.map((_, i) => `q${i}`),
  rounds: scores.map((score, i) => ({ questionId: `q${i}`, guess: [0, 0], distanceKm: 1, score })),
  pendingGuess: null,
  finished,
});

test('progress survives a reload; finished games feed the stats', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  const today = () => '2026-11-08';
  const a = new LocalStore(today, mem);
  a.saveGame(game('2026-11-08', false, [900, 800]));
  a.setUnits('mi');
  const b = new LocalStore(today, mem);
  assert.equal(b.loadGame('2026-11-08')?.rounds.length, 2);
  assert.equal(b.loadGame('2026-11-09'), null, 'a different day starts fresh');
  assert.equal(b.getUnits(), 'mi');
  b.saveGame(game('2026-11-08', true, [900, 800, 700, 600, 500, 400, 300]));
  const c = new LocalStore(today, mem);
  assert.equal(c.loadGame('2026-11-08')?.finished, true);
  assert.equal(c.stats().played, 1);
  assert.equal(c.stats().currentStreak, 1);
});

test('broken storage never throws', () => {
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota');
    },
  } as unknown as Storage;
  const s = new LocalStore(() => '2026-11-08', broken);
  assert.doesNotThrow(() => s.saveGame(game('2026-11-08', true, [1, 2, 3, 4, 5, 6, 7])));
  assert.equal(s.loadGame('2026-11-08'), null); // re-read from (broken) storage
  assert.doesNotThrow(() => s.setUnits('mi'));
  const none = new LocalStore(() => '2026-11-08', null);
  assert.doesNotThrow(() => none.saveGame(game('2026-11-08', false, [1])));
});

test('archive games are stored apart and never touch streaks or stats', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  const s = new LocalStore(() => '2026-11-10', mem);
  s.saveGame(game('2026-11-09', true, [500, 500, 500, 500, 500, 500, 500])); // yesterday, on the day
  const before = s.stats();
  // A missed day played later from the archive...
  s.saveArchiveGame(game('2026-11-07', true, [1000, 1000, 1000, 1000, 1000, 1000, 1000]));
  s.saveArchiveGame(game('2026-11-08', false, [800]));
  const t = new LocalStore(() => '2026-11-10', mem);
  // ...is not a daily result: no streak, no average, no best score from it.
  assert.deepEqual(t.stats(), before);
  assert.deepEqual(Object.keys(parseStored(mem.getItem('chronomap:v1')).history), ['2026-11-09']);
  assert.equal(t.loadGame('2026-11-07'), null, 'the daily slot never sees archive games');
  assert.equal(t.loadArchiveGame('2026-11-07')?.finished, true);
  assert.equal(t.loadArchiveGame('2026-11-08')?.rounds.length, 1);
  assert.equal(t.loadArchiveGame('2026-11-09'), null, 'a day finished on the day is not replayed');
  assert.deepEqual(t.pastDays('2026-11-10'), {
    '2026-11-07': { via: 'archive', finished: true, scores: [1000, 1000, 1000, 1000, 1000, 1000, 1000] },
    '2026-11-08': { via: 'archive', finished: false, scores: [800] },
    '2026-11-09': { via: 'daily', finished: true, scores: [500, 500, 500, 500, 500, 500, 500] },
  });
});

test('a daily game left unfinished carries on in the archive', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  const s = new LocalStore(() => '2026-11-10', mem);
  s.saveGame(game('2026-11-09', false, [700, 600])); // started yesterday, not finished
  assert.deepEqual(s.pastDays('2026-11-10')['2026-11-09'], { via: 'daily', finished: false, scores: [700, 600] });
  const resumed = s.loadArchiveGame('2026-11-09')!;
  assert.equal(resumed.rounds.length, 2);
  resumed.rounds.push(...game('2026-11-09', true, [1, 2, 3, 4, 5]).rounds);
  s.saveArchiveGame({ ...resumed, finished: true });
  assert.equal(s.stats().played, 0, 'finishing it late does not count as a daily');
  assert.equal(s.pastDays('2026-11-10')['2026-11-09'].via, 'archive');
  // Today never appears among past days.
  s.saveGame(game('2026-11-10', true, [1, 1, 1, 1, 1, 1, 1]));
  assert.equal(s.pastDays('2026-11-10')['2026-11-10'], undefined);
});

test('malformed archive entries are dropped', () => {
  const data = parseStored(JSON.stringify({ archive: { '2026-11-07': { dateKey: '2026-11-08' }, nope: {}, '2026-11-06': game('2026-11-06', true, [1]) } }));
  assert.deepEqual(Object.keys(data.archive), ['2026-11-06']);
});
