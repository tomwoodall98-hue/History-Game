/**
 * Review, practice and the claim prompt, played through the real App in a
 * simulated browser (happy-dom) with a fake map and a fake stats server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Clock, LngLat, Puzzle, PuzzleMode, Question, SavedGame } from '../src/game/types.ts';
import type { Schedule } from '../src/game/schedule.ts';
import type { GlobeView } from '../src/map/GlobeView.ts';
import type { ClaimResult, Profile, StatsService, Submission } from '../src/game/statsApi.ts';
import type { Leaderboard } from '../src/game/leaderboard.ts';
import type { DayStats } from '../src/game/stats.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bank = JSON.parse(readFileSync(resolve(ROOT, 'src/data/questions.json'), 'utf8')) as Question[];
const schedule = JSON.parse(readFileSync(resolve(ROOT, 'src/data/schedule.json'), 'utf8')) as Schedule;

let mod: {
  App: typeof import('../src/ui/App.ts').App;
  dailyPuzzle: typeof import('../src/game/schedule.ts').dailyPuzzle;
  LocalStore: typeof import('../src/game/storage.ts').LocalStore;
  ReadingList: typeof import('../src/game/reading.ts').ReadingList;
  addDays: typeof import('../src/game/daily.ts').addDays;
};

before(async () => {
  GlobalRegistrator.register({ url: 'https://chronomap.test/', width: 390, height: 844 });
  const [ui, sched, storage, reading, daily] = await Promise.all([
    import('../src/ui/App.ts'),
    import('../src/game/schedule.ts'),
    import('../src/game/storage.ts'),
    import('../src/game/reading.ts'),
    import('../src/game/daily.ts'),
  ]);
  mod = { App: ui.App, dailyPuzzle: sched.dailyPuzzle, LocalStore: storage.LocalStore, ReadingList: reading.ReadingList, addDays: daily.addDays };
});

after(async () => {
  await GlobalRegistrator.unregister();
});

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

class FakeMap {
  element = document.createElement('div');
  private guess: LngLat | null = null;
  private pick: ((p: LngLat) => void) | null = null;
  reviews: { guess: LngLat | null; answer: LngLat }[][] = [];
  highlighted: (number | null)[] = [];
  onPick(fn: (p: LngLat) => void) {
    this.pick = fn;
  }
  tap(p: LngLat) {
    this.pick?.(p);
  }
  setPickEnabled() {}
  setGuess(p: LngLat) {
    this.guess = p;
  }
  getGuess() {
    return this.guess;
  }
  clearMarkers() {
    this.guess = null;
  }
  clearReview() {}
  resetView() {}
  fitPoints() {}
  showAnswer() {
    return Promise.resolve();
  }
  fitRectFor() {
    return { left: 0, top: 0, right: 390, bottom: 844 };
  }
  setInsets() {}
  showReview(items: { guess: LngLat | null; answer: LngLat }[]) {
    this.reviews.push(items);
  }
  highlightReview(i: number | null) {
    this.highlighted.push(i);
  }
  zoomBy() {}
}

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

/** A fake stats server: records what is sent; the player has no name until they claim one. */
function fakeService(opts: { rows?: number[]; players?: number } = {}) {
  const submitted: Submission[] = [];
  const claimed: string[] = [];
  let name: string | null = null;
  const service: StatsService = {
    submit: async (s) => {
      submitted.push(s);
      return true;
    },
    stats: async (date, score): Promise<DayStats> => ({
      date,
      players: opts.players ?? 40,
      average: 3500,
      histogram: Array.from({ length: 14 }, () => 0),
      questionAverages: Array.from({ length: 7 }, () => 500),
      percentile: score == null ? null : 50,
    }),
    profile: async (): Promise<Profile> => ({ username: name, games: 1 }),
    claim: async (_id, username): Promise<ClaimResult> => {
      claimed.push(username);
      name = username;
      return { ok: true, username };
    },
    leaderboard: async (board): Promise<Leaderboard> => ({
      board,
      date: TODAY,
      minGames: 10,
      rows: (opts.rows ?? []).map((value, i) => ({ rank: i + 1, username: `Name${i}`, value, games: null, date: null })),
      you: null,
    }),
  };
  return { service, submitted, claimed };
}

const TODAY = '2026-11-25';
const clock = (today: string): Clock => ({ todayKey: () => today, msUntilNext: () => 3_600_000 });
const fakeReading = { topics: {}, events: Object.fromEntries(bank.map((q) => [q.id, [{ title: `BOOK-${q.id}`, author: 'A. Writer', year: 2000, why: 'Why.', work: 'OL1W' }]])) };

const button = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text) ?? null;
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function puzzleFor(day: string, archive: boolean, mode: PuzzleMode = 'play'): Puzzle {
  return { ...mod.dailyPuzzle(bank, schedule, day), archive, mode };
}

/** A finished game for a day, every mark a little off the answer. */
function finishedGame(puzzle: Puzzle, offset = 2): SavedGame {
  return {
    dateKey: puzzle.dateKey,
    puzzle: puzzle.number,
    questionIds: puzzle.questions.map((q) => q.id),
    rounds: puzzle.questions.map((q, i) => ({ questionId: q.id, guess: [q.lng + offset, q.lat], distanceKm: 150 + i, score: 600 + i })),
    pendingGuess: null,
    finished: true,
  };
}

function newApp(puzzle: Puzzle, storage: MemoryStorage, today: string, service: StatsService | null = null) {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app')!;
  const map = new FakeMap();
  const store = new mod.LocalStore(() => today, storage as unknown as Storage);
  const reading = new mod.ReadingList(() => Promise.resolve(fakeReading));
  const app = new mod.App(root, map as unknown as GlobeView, puzzle, store, clock(today), () => Promise.resolve(null), service, null, reading);
  return { app, root, map, store };
}

/** Plays every round of whatever is on screen, marking each answer `offset` degrees east. */
async function playAll(root: HTMLElement, map: FakeMap, puzzle: Puzzle, offset: number): Promise<void> {
  button(root, puzzle.mode === 'practice' ? 'Begin practice' : 'Begin')!.click();
  await settle();
  for (const [i, q] of puzzle.questions.entries()) {
    map.tap([q.lng + offset, q.lat]);
    button(root, 'Confirm')!.click();
    await settle();
    button(root, i === puzzle.questions.length - 1 ? 'See results' : 'Next')!.click();
    await settle();
  }
}

// ------------------------------------------------------------- practice ---

test('replaying a day as practice never overwrites the original result', async () => {
  const day = mod.addDays(TODAY, -5);
  const storage = new MemoryStorage();
  const seed = new mod.LocalStore(() => day, storage as unknown as Storage);
  const original = finishedGame(puzzleFor(day, false), 20); // a poor game, played on the day
  seed.saveGame(original);
  const originalTotal = original.rounds.reduce((a, r) => a + r.score, 0);
  const before = {
    raw: JSON.parse(storage.getItem('chronomap:v1')!),
    stats: new mod.LocalStore(() => TODAY, storage as unknown as Storage).stats(),
  };

  const { service, submitted } = fakeService();
  const puzzle = puzzleFor(day, true, 'practice');
  const { app, root, map, store } = newApp(puzzle, storage, TODAY, service);
  app.start();
  await settle();
  assert.match(text(root.querySelector('.practice-note')), /Practice: not scored\. Your original result of [\d,]+ stays as it is/);
  assert.equal(text(root.querySelector('.masthead .archive-stamp')), 'Practice');

  await playAll(root, map, puzzle, 0); // spot on this time
  const practiceTotal = 7000;
  assert.equal(text(root.querySelector('.results-title')), 'Practice: not scored');
  assert.equal(
    text(root.querySelector('.practice-compare')),
    `Original: ${originalTotal.toLocaleString('en-GB')} · Practice: ${practiceTotal.toLocaleString('en-GB')}`,
  );
  assert.equal(button(root, 'Share result'), null, 'practice is never shared');
  assert.equal(root.querySelector('.stats'), null, 'no streak or average on a practice');
  assert.equal(root.querySelector('.day-stats'), null);
  assert.equal(submitted.length, 0, 'nothing sent to the daily stats or leaderboards');

  // The original is exactly as it was.
  const after = JSON.parse(storage.getItem('chronomap:v1')!);
  assert.deepEqual(after.history, before.raw.history);
  assert.deepEqual(after.current, before.raw.current);
  assert.deepEqual(after.archive, before.raw.archive);
  assert.deepEqual(store.stats(), before.stats);
  assert.deepEqual(store.playedGame(day)!.scores, original.rounds.map((r) => r.score));
  assert.equal(after.practice.finished, true);

  // Replay again: a fresh attempt, and the original still the one compared with.
  const again = newApp(puzzle, storage, TODAY, service);
  again.app.start();
  await settle();
  assert.ok(button(again.root, 'Begin practice'), 'a finished practice starts afresh');
});

test('a practice left half-way carries on, still never scored', async () => {
  const day = mod.addDays(TODAY, -3);
  const storage = new MemoryStorage();
  new mod.LocalStore(() => day, storage as unknown as Storage).saveGame(finishedGame(puzzleFor(day, false)));
  const puzzle = puzzleFor(day, true, 'practice');
  const first = newApp(puzzle, storage, TODAY);
  first.app.start();
  await settle();
  button(first.root, 'Begin practice')!.click();
  await settle();
  first.map.tap([puzzle.questions[0].lng, puzzle.questions[0].lat]);
  button(first.root, 'Confirm')!.click();
  await settle();
  const second = newApp(puzzle, storage, TODAY);
  second.app.start();
  await settle();
  assert.match(text(second.root.querySelector('.slip .round-label')), /Practice · Round II of VII/);
  assert.equal(second.store.playedGame(day)!.scores[0], 600, 'the original first round is untouched');
});

// --------------------------------------------------------------- review ---

test('reviewing a past day steps through all seven, with marks, arcs and Read more', async () => {
  const day = mod.addDays(TODAY, -2);
  const storage = new MemoryStorage();
  const original = finishedGame(puzzleFor(day, false));
  new mod.LocalStore(() => day, storage as unknown as Storage).saveGame(original);
  const raw = storage.getItem('chronomap:v1');
  const puzzle = puzzleFor(day, true, 'review');
  const { app, root, map } = newApp(puzzle, storage, TODAY);
  app.start();
  await settle();

  const near = (p: LngLat | null) => p && p.map((x) => Math.round(x * 1e4) / 1e4);
  assert.deepEqual(
    map.reviews[0].map((r) => near(r.guess)),
    original.rounds.map((r) => near(r.guess)),
    'the original marks, each joined to its answer',
  );
  assert.deepEqual(map.reviews[0].map((r) => r.answer), puzzle.questions.map((q) => [q.lng, q.lat]));
  for (const [i, q] of puzzle.questions.entries()) {
    assert.match(text(root.querySelector('.slip .round-label')), new RegExp(`Review · ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][i]} of VII`));
    assert.equal(map.highlighted.at(-1), i, 'the map turns to this question');
    assert.match(text(root.querySelector('.slip .event')), new RegExp(q.event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text(root.querySelector('.slip .event')), new RegExp(q.dateDisplay.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(text(root.querySelector('.slip .points')), `${600 + i} points`);
    assert.match(text(root.querySelector('.slip .distance')), /away/);
    assert.equal(root.querySelector('.slip .missing-note'), null);
    // Read more, with Further reading.
    root.querySelector<HTMLButtonElement>('.slip .read-more')!.click();
    await settle();
    const dialog = root.querySelector<HTMLDialogElement>('dialog.gazetteer')!;
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector('.gz-title')?.textContent, q.event);
    assert.deepEqual([...dialog.querySelectorAll('.gz-book-title')].map((b) => b.textContent), [`BOOK-${q.id}`]);
    button(dialog, 'Close')!.click();
    button(root, i === 6 ? 'Done' : 'Next')!.click();
    await settle();
  }
  // Done: the day's summary, read-only.
  assert.equal(text(root.querySelector('.results-title')), 'Your Atlas');
  assert.equal(button(root, 'Share result'), null);
  assert.ok(button(root, 'Step through again'));
  assert.equal(storage.getItem('chronomap:v1'), raw, 'a review writes nothing');
});

test('a day saved before guesses were kept says so, and still shows the answers and Read more', async () => {
  const day = mod.addDays(TODAY, -4);
  const puzzle = puzzleFor(day, true, 'review');
  const storage = new MemoryStorage();
  // Version 1: scores only.
  storage.setItem('chronomap:v1', JSON.stringify({ version: 1, current: null, history: { [day]: { p: puzzle.number, s: [900, 800, 700, 600, 500, 400, 300] } } }));
  const { app, root, map } = newApp(puzzle, storage, TODAY);
  app.start();
  await settle();
  assert.equal(text(root.querySelector('.slip .missing-note')), 'Your guesses weren’t recorded for this day.');
  assert.equal(text(root.querySelector('.slip .points')), '900 points');
  assert.equal(root.querySelector('.slip .distance'), null);
  assert.deepEqual(
    map.reviews[0].map((r) => r.answer),
    puzzle.questions.map((q) => [q.lng, q.lat]),
    'the correct locations are all shown',
  );
  assert.ok(map.reviews[0].every((r) => r.guess === null));
  root.querySelector<HTMLButtonElement>('.slip .read-more')!.click();
  await settle();
  assert.equal(root.querySelector<HTMLDialogElement>('dialog.gazetteer')!.open, true);
  button(root.querySelector('dialog.gazetteer')!, 'Close')!.click();
  button(root, 'Close')!.click(); // leave the review early
  await settle();
  assert.match(text(root.querySelector('.panel')), /Your guesses weren’t recorded for this day/);
  assert.equal([...root.querySelectorAll('.breakdown .b-dist')].map((d) => d.textContent).join(''), '———————');
});

test('today’s results offer a review of today’s puzzle', async () => {
  const storage = new MemoryStorage();
  const puzzle = puzzleFor(TODAY, false);
  const { app, root, map } = newApp(puzzle, storage, TODAY);
  app.start();
  await settle();
  await playAll(root, map, puzzle, 1);
  button(root, 'Review today’s puzzle')!.click();
  await settle();
  assert.match(text(root.querySelector('.slip .round-label')), /Review · I of VII/);
  assert.equal(root.querySelector<HTMLButtonElement>('.slip [aria-label="Previous question"]')!.disabled, true);
  button(root, 'Next')!.click();
  await settle();
  assert.match(text(root.querySelector('.slip .round-label')), /Review · II of VII/);
  button(root, 'Close')!.click();
  await settle();
  assert.equal(text(root.querySelector('.results-title')), 'Your Atlas');
  // And the full guesses are stored for later review.
  assert.equal(new mod.LocalStore(() => TODAY, storage as unknown as Storage).playedGame(TODAY)!.rounds!.length, 7);

  // On another day's screens, a link back to today's review.
  const other = newApp(puzzleFor(mod.addDays(TODAY, -1), true), storage, TODAY);
  other.app.start();
  await settle();
  const link = [...other.root.querySelectorAll<HTMLAnchorElement>('.archive-links a')].find((a) => a.textContent === 'Review today’s puzzle');
  assert.ok(link?.href.endsWith(`?day=${TODAY}&mode=review`));
});

test('the almanac offers Review and Replay for finished days only', async () => {
  const storage = new MemoryStorage();
  const seed = new mod.LocalStore(() => TODAY, storage as unknown as Storage);
  const done = mod.addDays(TODAY, -2);
  seed.saveGame(finishedGame(puzzleFor(done, false)));
  const puzzle = puzzleFor(TODAY, false);
  const { app, root } = newApp(puzzle, storage, TODAY);
  app.start();
  await settle();
  button(root, 'Past puzzles')!.click();
  await settle();
  const actions = [...root.querySelectorAll<HTMLAnchorElement>('.ledger-action')];
  assert.deepEqual(actions.map((a) => a.textContent), ['Review', 'Replay']);
  assert.ok(actions[0].href.endsWith(`?day=${done}&mode=review`));
  assert.ok(actions[1].href.endsWith(`?day=${done}&mode=practice`));
  const unplayed = [...root.querySelectorAll<HTMLAnchorElement>('a.ledger-row')];
  assert.ok(unplayed.length > 0 && unplayed.every((a) => /\?day=\d{4}-\d{2}-\d{2}$/.test(a.href)), 'unplayed days open as before');
});

// --------------------------------------------------------- claim prompt ---

test('the end screen asks an unnamed player to claim a name, with where they’d rank', async () => {
  const storage = new MemoryStorage();
  const puzzle = puzzleFor(TODAY, false);
  new mod.LocalStore(() => TODAY, storage as unknown as Storage).saveGame(finishedGame(puzzle)); // 4,221 points
  const { service } = fakeService({ rows: [6900, 6000, 5100, 3000, 2000] });
  const { app, root, store } = newApp(puzzle, storage, TODAY, service);
  app.start();
  await settle();

  const prompt = root.querySelector<HTMLElement>('.claim-prompt')!;
  assert.equal(prompt.hidden, false);
  assert.equal(text(prompt.querySelector('.claim-title')), 'Claim your place on the leaderboard');
  assert.equal(text(prompt.querySelector('.claim-rank')), 'You’d be 4th of 6 today.');
  const breakdown = root.querySelector('.breakdown')!;
  assert.ok(prompt.compareDocumentPosition(breakdown) & Node.DOCUMENT_POSITION_FOLLOWING, 'above the breakdown and stats');
  assert.equal(root.querySelector<HTMLElement>('.masthead .claim-link')!.hidden, false, 'the header link too');
  assert.equal(root.querySelector<HTMLElement>('.archive-links .claim-open')!.hidden, false);

  button(prompt, 'Not now')!.click();
  await settle();
  assert.equal(prompt.hidden, true);
  assert.deepEqual(store.claimPrompt(), { snoozes: 1, until: '2026-11-28' });
  assert.equal(root.querySelector<HTMLElement>('.masthead .claim-link')!.hidden, false, 'the link stays');

  // Back the same day: still snoozed.
  const again = newApp(puzzle, storage, TODAY, service);
  again.app.start();
  await settle();
  assert.equal(again.root.querySelector<HTMLElement>('.claim-prompt')!.hidden, true);
});

test('choosing a username inline puts the player on the roll', async () => {
  const storage = new MemoryStorage();
  const puzzle = puzzleFor(TODAY, false);
  new mod.LocalStore(() => TODAY, storage as unknown as Storage).saveGame(finishedGame(puzzle));
  const { service, claimed } = fakeService();
  const { app, root } = newApp(puzzle, storage, TODAY, service);
  app.start();
  await settle();
  const prompt = root.querySelector<HTMLElement>('.claim-prompt')!;
  assert.equal(text(prompt.querySelector('.claim-rank')), 'You’d be the first name on today’s roll.');
  button(prompt, 'Choose a username')!.click();
  await settle();
  const input = prompt.querySelector<HTMLInputElement>('#claim-name')!;
  assert.equal(document.activeElement, input, 'the field takes focus');
  input.value = 'Mercator';
  input.dispatchEvent(new Event('input'));
  input.form!.requestSubmit();
  await settle();
  assert.deepEqual(claimed, ['Mercator']);
  assert.match(text(prompt), /Your name is on the roll.*Mercator/);
  assert.equal(root.querySelector<HTMLElement>('.masthead .claim-link')!.hidden, true, 'no more link once named');
  assert.equal(root.querySelector<HTMLElement>('.archive-links .claim-open')!.hidden, true);
});

test('no prompt for archive games, practice, or a named player', async () => {
  const storage = new MemoryStorage();
  const day = mod.addDays(TODAY, -1);
  const archive = puzzleFor(day, true);
  new mod.LocalStore(() => TODAY, storage as unknown as Storage).saveArchiveGame(finishedGame(archive));
  const { service } = fakeService();
  const a = newApp(archive, storage, TODAY, service);
  a.app.start();
  await settle();
  assert.equal(a.root.querySelector('.claim-prompt'), null);
  // The header link is there for any game, for a player without a name.
  assert.equal(a.root.querySelector<HTMLElement>('.masthead .claim-link')!.hidden, false);
});
