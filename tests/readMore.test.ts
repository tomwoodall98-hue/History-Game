/**
 * "Read more" must never give an answer away: nothing about a question may
 * be fetched, or appear in the page, until its guess is confirmed.
 *
 * The first tests check the guard on its own. The rest play whole games
 * through the real App in a simulated browser (happy-dom), with every
 * network request recorded, and check before each confirmation that nothing
 * about that question, or any later one, has been requested or rendered.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Clock, LngLat, Puzzle, Question, RoundResult } from '../src/game/types.ts';
import type { Schedule } from '../src/game/schedule.ts';
import type { GlobeView } from '../src/map/GlobeView.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bank = JSON.parse(readFileSync(resolve(ROOT, 'src/data/questions.json'), 'utf8')) as Question[];
const schedule = JSON.parse(readFileSync(resolve(ROOT, 'src/data/schedule.json'), 'utf8')) as Schedule;

// The modules under test touch `document` when used, so load them once the
// simulated browser is in place.
let mod: {
  App: typeof import('../src/ui/App.ts').App;
  ReadMore: typeof import('../src/game/readMore.ts').ReadMore;
  SummaryCache: typeof import('../src/game/wikipedia.ts').SummaryCache;
  summaryUrl: typeof import('../src/game/wikipedia.ts').summaryUrl;
  articleTitle: typeof import('../src/game/wikipedia.ts').articleTitle;
  dailyPuzzle: typeof import('../src/game/schedule.ts').dailyPuzzle;
  LocalStore: typeof import('../src/game/storage.ts').LocalStore;
};

before(async () => {
  GlobalRegistrator.register({ url: 'https://chronomap.test/', width: 390, height: 844 });
  const [ui, rm, wiki, sched, storage] = await Promise.all([
    import('../src/ui/App.ts'),
    import('../src/game/readMore.ts'),
    import('../src/game/wikipedia.ts'),
    import('../src/game/schedule.ts'),
    import('../src/game/storage.ts'),
  ]);
  mod = {
    App: ui.App,
    ReadMore: rm.ReadMore,
    SummaryCache: wiki.SummaryCache,
    summaryUrl: wiki.summaryUrl,
    articleTitle: wiki.articleTitle,
    dailyPuzzle: sched.dailyPuzzle,
    LocalStore: storage.LocalStore,
  };
});

after(async () => {
  await GlobalRegistrator.unregister();
});

// --------------------------------------------------------------- network ---

/** Every request made, by anything. */
const requests: string[] = [];
let offline = false;

/** A fake summary whose every part is marked with the article it came from. */
function fakeSummary(title: string) {
  return {
    type: 'standard',
    title: `ARTICLE ${title}`,
    titles: { normalized: `ARTICLE ${title}` },
    extract: `SUMMARY-${title} first paragraph.\nSUMMARY-${title} <b>second</b> paragraph.`,
    thumbnail: { source: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${title}.jpg/330px-${title}.jpg`, width: 330, height: 220 },
    content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title}` } },
  };
}

function installFetch(): void {
  const fake = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (offline) throw new TypeError('Failed to fetch');
    const m = /\/api\/rest_v1\/page\/summary\/(.+)$/.exec(url);
    if (!m) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(fakeSummary(decodeURIComponent(m[1]))), { headers: { 'content-type': 'application/json' } });
  };
  (globalThis as { fetch: unknown }).fetch = fake;
  (window as unknown as { fetch: unknown }).fetch = fake;
}

// ---------------------------------------------------------------- helpers ---

/** Lets promises, timers and animation frames run. */
const settle = async (ms = 0) => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, ms));
};

class FakeMap {
  element = document.createElement('div');
  private guess: LngLat | null = null;
  private pick: ((p: LngLat) => void) | null = null;
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
    return { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844, cx: 195, cy: 422, r: 180 };
  }
  setInsets() {}
  showReview() {}
  highlightReview() {}
  zoomBy() {}
}

const clock = (today: string): Clock => ({ todayKey: () => today, msUntilNext: () => 3_600_000 });

/** Everything that would give question `q` away, if it showed up early. */
function traces(q: Question): string[] {
  const title = mod.articleTitle(q.source)!;
  return [q.source, mod.summaryUrl(q.source)!, `/summary/${encodeURIComponent(title)}`, `SUMMARY-${title}`, `ARTICLE ${title}`, `${title}.jpg`];
}

function assertNothingAbout(q: Question, when: string): void {
  const html = document.documentElement.outerHTML;
  for (const t of traces(q)) {
    assert.ok(!requests.some((u) => u.includes(t)), `${when}: requested ${t}`);
    assert.ok(!html.includes(t), `${when}: the page contains ${t}`);
  }
}

const button = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text) ?? null;

interface Game {
  app: InstanceType<typeof mod.App>;
  map: FakeMap;
  root: HTMLElement;
  puzzle: Puzzle;
}

function newGame(dateKey: string, archive: boolean): Game {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app')!;
  const daily = mod.dailyPuzzle(bank, schedule, dateKey);
  const puzzle: Puzzle = { ...daily, archive };
  const map = new FakeMap();
  const today = archive ? '2030-01-01' : dateKey;
  const store = new mod.LocalStore(() => today, null);
  const summaries = new mod.SummaryCache((url, init) => fetch(url, init));
  const app = new mod.App(root, map as unknown as GlobeView, puzzle, store, clock(today), () => Promise.resolve(null), null, summaries);
  return { app, map, root, puzzle };
}

/**
 * Plays all seven rounds. Before each confirmation it checks that nothing
 * about this question or any later one has been fetched or rendered; after
 * it, that the entry was fetched and reads as it should.
 */
async function playThrough({ app, map, root, puzzle }: Game, label: string): Promise<void> {
  requests.length = 0;
  app.start();
  await settle();
  const begin = button(root, 'Begin');
  assert.ok(begin, 'start screen');
  begin.click();
  await settle();

  for (let i = 0; i < puzzle.questions.length; i++) {
    const q = puzzle.questions[i];
    const later = puzzle.questions.slice(i);
    for (const l of later) assertNothingAbout(l, `${label}, round ${i + 1} before marking (${l.id})`);
    assert.equal(root.querySelector('.read-more'), null, 'no Read more while guessing');

    map.tap([q.lng + 3, q.lat + 2]);
    await settle();
    for (const l of later) assertNothingAbout(l, `${label}, round ${i + 1} marked but not confirmed (${l.id})`);

    button(root, 'Confirm')!.click();
    await settle();

    // Confirmed: the entry is fetched while the reveal plays…
    const ownUrl = mod.summaryUrl(q.source)!;
    const sharedLater = puzzle.questions.slice(i + 1).some((l) => mod.summaryUrl(l.source) === ownUrl);
    if (sharedLater) {
      assert.equal(root.querySelector('.read-more'), null, 'an article shared with a later question waits for it');
    } else {
      assert.equal(requests.filter((u) => u === ownUrl).length, 1, `${label}, round ${i + 1}: prefetched once`);
      // …but still nothing about the questions to come.
      for (const l of puzzle.questions.slice(i + 1)) if (mod.summaryUrl(l.source) !== ownUrl) assertNothingAbout(l, `${label}, round ${i + 1} revealed (${l.id})`);

      // Read more opens the entry.
      const readMore = root.querySelector<HTMLButtonElement>('.slip .read-more');
      assert.ok(readMore, 'Read more on the reveal');
      readMore.click();
      await settle();
      const dialog = root.querySelector<HTMLDialogElement>('dialog.gazetteer')!;
      assert.equal(dialog.open, true);
      const title = mod.articleTitle(q.source)!;
      assert.equal(dialog.querySelector('.gz-title')?.textContent, q.event);
      assert.equal(dialog.querySelector('.gz-date')?.textContent, q.dateDisplay);
      assert.equal(dialog.querySelector('.gz-lead')?.textContent, q.note);
      assert.deepEqual(
        Array.from(dialog.querySelectorAll('.gz-summary > p')).map((p) => p.textContent),
        [`SUMMARY-${title} first paragraph.`, `SUMMARY-${title} second paragraph.`],
        'summary as plain paragraphs',
      );
      assert.equal(dialog.querySelector('.gz-summary b'), null, 'no HTML from the extract');
      assert.ok(dialog.querySelector<HTMLImageElement>('.gz-plate img')!.src.endsWith(`/330px-${title}.jpg`), 'the picture');
      const more = dialog.querySelector<HTMLAnchorElement>('a.gz-continue')!;
      assert.equal(more.textContent, 'Continue reading on Wikipedia');
      assert.equal(more.target, '_blank');
      assert.equal(dialog.querySelector('.gz-credit')?.textContent, 'From Wikipedia, CC BY-SA');
      assert.equal(requests.filter((u) => u === ownUrl).length, 1, 'opening uses the cached summary');

      // Next question is one tap away from inside the entry; or close it first.
      if (i % 2 === 0) {
        const next = button(dialog, i === puzzle.questions.length - 1 ? 'See results' : 'Next question')!;
        next.click();
        await settle();
        assert.equal(dialog.open, false);
        continue;
      }
      button(dialog, 'Close')!.click();
      assert.equal(dialog.open, false);
    }
    button(root, i === puzzle.questions.length - 1 ? 'See results' : 'Next')!.click();
    await settle();
  }

  // The results: Read more for every event.
  const rows = root.querySelectorAll<HTMLButtonElement>('.breakdown .b-more');
  assert.equal(rows.length, puzzle.questions.length);
  const before = requests.length;
  for (const [i, more] of Array.from(rows).entries()) {
    more.click();
    await settle();
    const dialog = root.querySelector<HTMLDialogElement>('dialog.gazetteer')!;
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector('.gz-title')?.textContent, puzzle.questions[i].event);
    assert.equal(button(dialog, 'Next question'), null, 'no next question from the results');
    button(dialog, 'Close')!.click();
  }
  // Summaries already fetched in the reveals came from the cache.
  const shared = new Set(puzzle.questions.map((q) => mod.summaryUrl(q.source))).size < puzzle.questions.length;
  if (!shared) assert.equal(requests.length, before, 'all seven from the cache');
}

// ------------------------------------------------------------------ guard ---

test('the guard refuses questions whose guess is not confirmed', async () => {
  const qs = bank.slice(0, 7);
  const rounds: RoundResult[] = [];
  const fetched: string[] = [];
  const summaries = new mod.SummaryCache((url) => {
    fetched.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
  const guard = new mod.ReadMore(qs, () => rounds, summaries);
  for (let n = 0; n < qs.length; n++) {
    for (let j = n; j < qs.length; j++) {
      assert.equal(guard.unlocked(j), false);
      assert.equal(guard.articleUrl(j), null);
      guard.prefetch(j);
      await assert.rejects(guard.summary(j));
    }
    assert.ok(!fetched.some((u) => qs.slice(n).some((q) => u === mod.summaryUrl(q.source))), `nothing about question ${n + 1} or later`);
    rounds.push({ questionId: qs[n].id, guess: [0, 0], distanceKm: 1, score: 1 });
    assert.equal(guard.unlocked(n), true);
    assert.equal(guard.articleUrl(n), qs[n].source);
    guard.prefetch(n);
    assert.equal(fetched.at(-1), mod.summaryUrl(qs[n].source));
  }
  assert.equal(guard.unlocked(7), false, 'out of range');
  assert.equal(guard.unlocked(-1), false);
});

test('a round recorded for a different question unlocks nothing', () => {
  const qs = bank.slice(0, 2);
  const guard = new mod.ReadMore(qs, () => [{ questionId: 'something-else', guess: null, distanceKm: 0, score: 0 }], null);
  assert.equal(guard.unlocked(0), false);
});

test('an article shared with a later question waits until both are answered', () => {
  const hiroshima = bank.find((q) => q.id === 't1-hiroshima')!;
  const nagasaki = bank.find((q) => q.id === 't2-nagasaki')!;
  const other = bank.find((q) => q.id === 't1-bastille')!;
  const qs = [hiroshima, other, nagasaki];
  const rounds: RoundResult[] = [];
  const guard = new mod.ReadMore(qs, () => rounds, null);
  const answer = (q: Question) => rounds.push({ questionId: q.id, guess: [0, 0], distanceKm: 1, score: 1 });
  answer(hiroshima);
  assert.equal(guard.unlocked(0), false, 'Hiroshima’s article also covers Nagasaki, still to play');
  answer(other);
  assert.equal(guard.unlocked(1), true);
  answer(nagasaki);
  assert.equal(guard.unlocked(0), true);
  assert.equal(guard.unlocked(2), true);
});

// ------------------------------------------------------- the whole game ---

test('a daily game: nothing about question N is fetched or shown before its guess is confirmed', async () => {
  installFetch();
  offline = false;
  await playThrough(newGame(schedule.start, false), 'daily');
});

test('an archive game keeps to the same rule', async () => {
  installFetch();
  offline = false;
  // A later day, for different questions.
  const day = new Date(Date.parse(`${schedule.start}T12:00:00Z`) + 9 * 86_400_000).toISOString().slice(0, 10);
  await playThrough(newGame(day, true), 'archive');
});

test('a day with Hiroshima before Nagasaki holds back the shared article', async () => {
  installFetch();
  offline = false;
  const game = newGame(schedule.start, false);
  const hiroshima = bank.find((q) => q.id === 't1-hiroshima')!;
  const nagasaki = bank.find((q) => q.id === 't2-nagasaki')!;
  const rest = game.puzzle.questions.filter((q) => q.id !== hiroshima.id && q.id !== nagasaki.id).slice(0, 5);
  game.puzzle.questions.splice(0, 7, hiroshima, nagasaki, ...rest);
  // Rebuild with the edited puzzle so the App sees it from the start.
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app')!;
  const map = new FakeMap();
  const app = new mod.App(
    root,
    map as unknown as GlobeView,
    game.puzzle,
    new mod.LocalStore(() => schedule.start, null),
    clock(schedule.start),
    () => Promise.resolve(null),
    null,
    new mod.SummaryCache((url, init) => fetch(url, init)),
  );
  await playThrough({ app, map, root, puzzle: game.puzzle }, 'shared article');
});

test('when Wikipedia is unreachable the entry shows the note and the link, and the game goes on', async () => {
  installFetch();
  offline = true;
  const { app, map, root, puzzle } = newGame(schedule.start, false);
  app.start();
  await settle();
  button(root, 'Begin')!.click();
  await settle();
  const q = puzzle.questions[0];
  map.tap([q.lng, q.lat]);
  button(root, 'Confirm')!.click();
  await settle();
  root.querySelector<HTMLButtonElement>('.slip .read-more')!.click();
  await settle();
  const dialog = root.querySelector<HTMLDialogElement>('dialog.gazetteer')!;
  assert.equal(dialog.querySelector('.gz-lead')?.textContent, q.note);
  assert.equal(dialog.querySelectorAll('.gz-summary p').length, 0);
  assert.equal(dialog.querySelector('.gz-plate'), null);
  assert.equal(dialog.querySelector<HTMLAnchorElement>('a.gz-continue')?.href, new URL(q.source).href);
  assert.ok(dialog.querySelector('.gz-credit')!.hasAttribute('hidden'), 'no credit without Wikipedia text');
  button(dialog, 'Next question')!.click();
  await settle();
  assert.equal(root.querySelector('.slip .event')?.textContent, puzzle.questions[1].event, 'on to round II');
  offline = false;
});

test('Escape closes the entry and leaves the round as it was', async () => {
  installFetch();
  offline = false;
  const { app, map, root, puzzle } = newGame(schedule.start, false);
  app.start();
  await settle();
  button(root, 'Begin')!.click();
  await settle();
  const q = puzzle.questions[0];
  map.tap([q.lng, q.lat]);
  button(root, 'Confirm')!.click();
  await settle();
  root.querySelector<HTMLButtonElement>('.slip .read-more')!.click();
  await settle();
  const dialog = root.querySelector<HTMLDialogElement>('dialog.gazetteer')!;
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  assert.equal(dialog.open, false);
  assert.ok(button(root, 'Next'), 'still on the reveal, Next to hand');
});
