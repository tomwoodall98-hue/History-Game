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

test('map decorations are on until turned off, and the choice is kept', () => {
  assert.equal(parseStored(null).decorations, true);
  assert.equal(parseStored('{"decorations":"no"}').decorations, true);
  assert.equal(parseStored('{"decorations":false}').decorations, false);
  const mem = new MemoryStorage();
  const s = new LocalStore(() => '2026-11-25', mem as unknown as Storage);
  assert.equal(s.getDecorations(), true);
  s.setDecorations(false);
  assert.equal(new LocalStore(() => '2026-11-25', mem as unknown as Storage).getDecorations(), false);
  s.setDecorations(true);
  assert.equal(new LocalStore(() => '2026-11-25', mem as unknown as Storage).getDecorations(), true);
});

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

test('anonymous player id: made once, kept, and none without storage', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  const a = new LocalStore(() => '2026-11-10', mem);
  const id = a.playerId();
  assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new LocalStore(() => '2026-11-10', mem).playerId(), id, 'the same id on the next visit');
  assert.equal(new LocalStore(() => '2026-11-10', null).playerId(), null);
  assert.equal(parseStored('{"playerId":"not-a-uuid"}').playerId, null);
});

test('submission attempts are recorded per day, and old ones forgotten', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  let today = '2026-11-10';
  const s = new LocalStore(() => today, mem);
  assert.deepEqual(s.submission('2026-11-10'), { done: false, tries: 0 });
  s.recordSubmission('2026-11-10', false);
  assert.deepEqual(new LocalStore(() => today, mem).submission('2026-11-10'), { done: false, tries: 1 });
  s.recordSubmission('2026-11-10', true);
  assert.deepEqual(s.submission('2026-11-10'), { done: true, tries: 2 });
  today = '2026-11-30';
  s.recordSubmission('2026-11-30', true);
  assert.deepEqual(s.submission('2026-11-10'), { done: false, tries: 0 }, 'pruned after a week');
});

test('a restored player id replaces the old one and is kept', () => {
  const storage = new MemoryStorage();
  const store = new LocalStore(() => '2026-11-06', storage as unknown as Storage);
  const first = store.playerId();
  const restored = '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d';
  assert.ok(first && first !== restored);
  assert.equal(store.setPlayerId(restored), true);
  assert.equal(store.playerId(), restored);
  assert.equal(new LocalStore(() => '2026-11-06', storage as unknown as Storage).playerId(), restored, 'kept across visits');
  assert.equal(store.setPlayerId('not-an-id'), false);
  assert.equal(store.playerId(), restored);
  assert.equal(new LocalStore(() => '2026-11-06', null).setPlayerId(restored), false, 'no storage, nothing to keep it in');
});

// ------------------------------------------------- version 2: full rounds ---

/** A finished daily game with real-looking marks. */
const played = (dateKey: string, scores: number[]): SavedGame => ({
  dateKey,
  puzzle: 7,
  questionIds: scores.map((_, i) => `${dateKey}-q${i}`),
  rounds: scores.map((score, i) => ({ questionId: `${dateKey}-q${i}`, guess: [2.123456789 + i, 48.987654321 - i], distanceKm: 12.3456 * (i + 1), score })),
  pendingGuess: null,
  finished: true,
});

test('finished daily games keep every guess from now on', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  const s = new LocalStore(() => '2026-11-25', mem);
  s.saveGame(played('2026-11-24', [900, 800, 700, 600, 500, 400, 300]));
  s.saveGame(played('2026-11-25', [100, 200, 300, 400, 500, 600, 700])); // `current` moves on to today
  const raw = parseStored(mem.getItem('chronomap:v1'));
  assert.equal(raw.version, 2);
  const yesterday = new LocalStore(() => '2026-11-25', mem).playedGame('2026-11-24')!;
  assert.equal(yesterday.via, 'daily');
  assert.deepEqual(yesterday.scores, [900, 800, 700, 600, 500, 400, 300]);
  assert.equal(yesterday.rounds?.length, 7, 'yesterday’s guesses kept although it is no longer the current game');
  assert.deepEqual(yesterday.rounds![0].guess, [2.12346, 48.98765], 'to about a metre');
  assert.equal(yesterday.rounds![1].distanceKm, 24.7, 'to 100 m');
  assert.equal(yesterday.rounds![3].questionId, '2026-11-24-q3');
});

test('version 1 data migrates without losing a thing', () => {
  // Exactly what the game stored before guesses were kept.
  const current = played('2026-11-20', [1000, 900, 800, 700, 600, 500, 400]);
  const v1 = {
    version: 1,
    current,
    history: {
      '2026-11-18': { p: 13, s: [10, 20, 30, 40, 50, 60, 70] },
      '2026-11-19': { p: 14, s: [500, 500, 500, 500, 500, 500, 500] },
      '2026-11-20': { p: 15, s: [1000, 900, 800, 700, 600, 500, 400] },
    },
    archive: { '2026-11-10': game('2026-11-10', true, [300, 300, 300, 300, 300, 300, 300]) },
    units: 'mi',
    seenIntro: true,
    playerId: '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d',
    submissions: { '2026-11-20': { done: true, tries: 1 } },
  };
  const mem = new MemoryStorage();
  mem.setItem('chronomap:v1', JSON.stringify(v1));
  const today = () => '2026-11-21';
  const before = computeStats(
    Object.fromEntries(Object.entries(v1.history).map(([k, e]) => [k, { p: e.p, s: e.s }])),
    '2026-11-21',
  );

  const s = new LocalStore(today, mem as unknown as Storage);
  // Everything the player had is still there…
  assert.deepEqual(s.stats(), before);
  assert.equal(s.stats().played, 3);
  assert.equal(s.getUnits(), 'mi');
  assert.equal(s.hasSeenIntro(), true);
  assert.equal(s.playerId(), v1.playerId);
  assert.deepEqual(s.submission('2026-11-20'), { done: true, tries: 1 });
  assert.equal(s.loadArchiveGame('2026-11-10')?.finished, true);
  assert.deepEqual(Object.keys(s.pastDays('2026-11-21')).sort(), ['2026-11-10', '2026-11-18', '2026-11-19', '2026-11-20']);
  // …older days have their scores but no guesses to show…
  const old = s.playedGame('2026-11-18')!;
  assert.deepEqual(old.scores, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(old.rounds, null);
  assert.equal(old.puzzle, 13);
  // …and the latest game, kept in full, fills in its own day's guesses.
  assert.deepEqual(s.playedGame('2026-11-20')!.rounds!.map((r) => r.questionId), current.questionIds);

  // Written back (any save), the data is version 2 and still complete.
  s.setUnits('km');
  const after = parseStored(mem.getItem('chronomap:v1'));
  assert.equal(after.version, 2);
  assert.deepEqual(
    Object.fromEntries(Object.entries(after.history).map(([k, e]) => [k, e.s])),
    Object.fromEntries(Object.entries(v1.history).map(([k, e]) => [k, e.s])),
  );
  assert.equal(after.history['2026-11-20'].r?.length, 7, 'the migrated guesses are stored now');
  assert.equal(after.history['2026-11-19'].r, undefined);
  assert.deepEqual(after.archive['2026-11-10'], v1.archive['2026-11-10']);
  assert.equal(after.playerId, v1.playerId);
  assert.deepEqual(after.current, current);
  assert.deepEqual(new LocalStore(today, mem as unknown as Storage).stats(), before);
});

test('migration only borrows guesses that match the day’s scores', () => {
  const current = played('2026-11-20', [1, 2, 3, 4, 5, 6, 7]);
  const data = parseStored(JSON.stringify({ version: 1, current, history: { '2026-11-20': { p: 15, s: [7, 6, 5, 4, 3, 2, 1] } } }));
  assert.equal(data.history['2026-11-20'].r, undefined);
  assert.deepEqual(data.history['2026-11-20'].s, [7, 6, 5, 4, 3, 2, 1]);
});

test('malformed stored rounds are dropped, the scores kept', () => {
  const bad = [{ questionId: 'a', guess: [999, 0], distanceKm: 1, score: 1 }];
  const mismatched = [{ questionId: 'a', guess: [1, 1], distanceKm: 1, score: 2 }];
  const data = parseStored(JSON.stringify({ history: { '2026-11-20': { p: 1, s: [1], r: bad }, '2026-11-21': { p: 1, s: [1], r: mismatched } } }));
  assert.deepEqual(data.history['2026-11-20'], { p: 1, s: [1] });
  assert.deepEqual(data.history['2026-11-21'], { p: 1, s: [1] });
});

test('a practice replay never overwrites the original result', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  const s = new LocalStore(() => '2026-11-25', mem);
  s.saveGame(played('2026-11-20', [500, 500, 500, 500, 500, 500, 500])); // played on the day
  s.saveArchiveGame(played('2026-11-12', [300, 300, 300, 300, 300, 300, 300])); // from the archive
  s.saveGame(played('2026-11-25', [100, 100, 100, 100, 100, 100, 100])); // today
  const snapshot = () => ({
    stats: s.stats(),
    past: s.pastDays('2026-11-25'),
    daily: s.playedGame('2026-11-20'),
    archived: s.playedGame('2026-11-12'),
    today: s.loadGame('2026-11-25'),
    archiveSlot: s.loadArchiveGame('2026-11-12'),
    submission: s.submission('2026-11-20'),
  });
  const before = snapshot();

  for (const day of ['2026-11-20', '2026-11-12']) {
    const practice = played(day, [1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    s.savePracticeGame({ ...practice, rounds: practice.rounds.slice(0, 3), finished: false });
    s.savePracticeGame(practice);
    assert.equal(new LocalStore(() => '2026-11-25', mem).loadPracticeGame(day)?.finished, true);
  }
  assert.deepEqual(snapshot(), before, 'results, streak, averages and the archive are untouched');
  assert.deepEqual(new LocalStore(() => '2026-11-25', mem).stats(), before.stats);
  assert.equal(s.loadPracticeGame('2026-11-20'), null, 'only the latest practice is kept');
  assert.equal(s.loadGame('2026-11-12'), null);
});

test('the claim prompt’s snoozes are kept between visits', () => {
  const mem = new MemoryStorage() as unknown as Storage;
  const s = new LocalStore(() => '2026-11-25', mem);
  assert.deepEqual(s.claimPrompt(), { snoozes: 0, until: null });
  s.snoozeClaimPrompt('2026-11-25');
  assert.deepEqual(new LocalStore(() => '2026-11-25', mem).claimPrompt(), { snoozes: 1, until: '2026-11-28' });
  assert.deepEqual(parseStored('{"claimPrompt":{"snoozes":-1,"until":"soon"}}').claimPrompt, { snoozes: 0, until: null });
});
