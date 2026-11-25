import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/im-fell-english/latin-400-italic.css';
import '@fontsource/im-fell-english-sc/latin-400.css';
import './styles/main.css';
import globeUrl from './data/globe.topo.json?url';
import countriesUrl from './data/countries.topo.json?url';
import questionsUrl from './data/questions.json?url';
import readingUrl from './data/reading.json?url';
import decorationsUrl from './data/decorations.json?url';
import scheduleData from './data/schedule.json';
import { GlobeView } from './map/GlobeView';
import { decodeDecorations, type DecorationFile } from './map/decorations';
import type { GlobeBase } from './map/globeData';
import { applyPaperTexture } from './map/texture';
import { App } from './ui/App';
import type { Question, Puzzle, Clock } from './game/types';
import { londonDateKey, nextLondonMidnight } from './game/daily';
import { canonicalQuery, resolveRoute } from './game/route';
import { dailyPuzzle, type Schedule } from './game/schedule';
import { LocalStore } from './game/storage';
import { CountryIndex, type CountryLookup } from './game/countries';
import { createStatsService, statsConfig } from './game/statsApi';
import { SummaryCache } from './game/wikipedia';
import { ReadingList } from './game/reading';

// Start the map and question downloads before anything else. The question
// bank is a file of its own rather than part of the script, so the two
// download in parallel and the script stays small.
const getJson = <T>(url: string, what: string): Promise<T> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${what} failed to load (${r.status})`);
    return r.json() as Promise<T>;
  });
const basePromise = getJson<GlobeBase>(globeUrl, 'Map data');
const questionsPromise = getJson<Question[]>(questionsUrl, 'The questions');

const root = document.getElementById('app')!;
applyPaperTexture(document.documentElement);

const zoomControls = document.createElement('div');
zoomControls.className = 'zoom-controls';
zoomControls.innerHTML = `
  <button class="ink-button" data-zoom="in" aria-label="Zoom in" title="Zoom in">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14M3 10h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
  </button>
  <button class="ink-button" data-zoom="out" aria-label="Zoom out" title="Zoom out">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
  </button>
  <button class="ink-button" data-zoom="reset" aria-label="Show whole map" title="Show whole map">
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
  </button>
  <button class="ink-button decor-toggle" data-toggle="decorations" aria-pressed="true" aria-label="Map decorations" title="Map decorations">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 16 6.8 6.5l3.4 5.6 2.3-3.4 6 7.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M7.6 9.4 9 13.2M13.4 11l1.4 3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path class="off" d="M3 3l14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
  </button>`;
root.appendChild(zoomControls);

const tileBaseUrl = new URL(`${import.meta.env.BASE_URL}geo/globe/`, document.baseURI).href;
const map = new GlobeView(document.getElementById('map')!, tileBaseUrl);
zoomControls.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>('[data-zoom]');
  if (!btn) return;
  const action = btn.dataset.zoom;
  if (action === 'in') map.zoomBy(1.8);
  else if (action === 'out') map.zoomBy(1 / 1.8);
  else map.resetView();
});

// --- Today's puzzle, chosen from the date in Europe/London, or a past day
// from the archive (?day=YYYY-MM-DD; never today or later), played, reviewed
// (&mode=review, today's too once it's done) or replayed as practice
// (&mode=practice). See game/route.ts.
const todayKey = londonDateKey();
const store = new LocalStore(() => londonDateKey());
const route = resolveRoute(location.search, todayKey, (day) => store.playedGame(day) != null);

// Map decorations (mountains, deserts, forests, ripples, ships): on unless
// the player turned them off. Their placements are a file of their own,
// fetched once the globe is up, and only while they are wanted.
const decorButton = zoomControls.querySelector<HTMLButtonElement>('[data-toggle="decorations"]')!;
let decorations: Promise<void> | null = null;
function showDecorations(on: boolean): void {
  decorButton.setAttribute('aria-pressed', String(on));
  map.setDecorationsVisible(on);
  if (on && !decorations) {
    decorations = getJson<DecorationFile>(decorationsUrl, 'Map decorations')
      .then((file) => map.setDecorations(decodeDecorations(file)))
      .catch((err) => {
        console.warn(err);
        decorations = null;
      });
  }
}
decorButton.setAttribute('aria-pressed', String(store.getDecorations()));
decorButton.addEventListener('click', () => {
  const on = !store.getDecorations();
  store.setDecorations(on);
  showDecorations(on);
});
const query = canonicalQuery(route, todayKey);
const asked = new URLSearchParams(location.search);
if ((asked.has('day') || asked.has('mode')) && location.search !== query) history.replaceState(null, '', location.pathname + query + location.hash);

/** The questions a day was actually played with, if they are known. */
function playedQuestionIds(): string[] | null {
  if (route.mode === 'play') {
    return (route.archive ? store.loadArchiveGame(route.day) : store.loadGame(route.day))?.questionIds ?? null;
  }
  const practice = route.mode === 'practice' ? store.loadPracticeGame(route.day) : null;
  if (practice && !practice.finished) return practice.questionIds;
  return store.playedGame(route.day)?.rounds?.map((r) => r.questionId) ?? null;
}

function makePuzzle(allQuestions: Question[]): Puzzle {
  const daily = dailyPuzzle(allQuestions, scheduleData as Schedule, route.day);
  const puzzle: Puzzle = { ...daily, archive: route.archive, mode: route.mode };
  // If a game was started before the question bank changed (a new deploy
  // mid-day), keep the questions the player was actually given.
  const ids = playedQuestionIds();
  if (ids && ids.join() !== daily.questions.map((q) => q.id).join()) {
    const byId = new Map(allQuestions.map((q) => [q.id, q]));
    const kept = ids.map((id) => byId.get(id));
    if (kept.length === daily.questions.length && kept.every(Boolean)) puzzle.questions = kept as Question[];
  }
  return puzzle;
}
// Country outlines, used only to score the same-country floor and never
// drawn. Fetched once the map is up; a failed fetch is retried next time.
let countries: Promise<CountryLookup | null> | null = null;
const loadCountries = (): Promise<CountryLookup | null> =>
  (countries ??= fetch(countriesUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`Country data failed to load (${r.status})`);
      return r.json();
    })
    .then((topo) => new CountryIndex(topo))
    .catch((err) => {
      console.warn(err);
      countries = null;
      return null;
    }));

// Anonymous daily stats (Supabase), if the build was given its URL and
// publishable key. Without them the game simply has no stats panel.
const statsCfg = statsConfig(import.meta.env);
const statsService = statsCfg ? createStatsService(statsCfg) : null;

// "Read more": Wikipedia summaries, fetched only for questions already
// answered (the App's ReadMore guard sees to that) and kept for the visit.
const summaries = new SummaryCache((url, init) => fetch(url, init));
// "Further reading": a file of its own, fetched when a Read more entry first opens.
const reading = new ReadingList(() => getJson<unknown>(readingUrl, 'Further reading'));

const clock: Clock = {
  msUntilNext: () => nextLondonMidnight().getTime() - Date.now(),
  todayKey: () => londonDateKey(),
};

Promise.all([basePromise, questionsPromise])
  .then(([base, questions]) => {
    const puzzle = makePuzzle(questions);
    map.render(base);
    showDecorations(store.getDecorations());
    requestAnimationFrame(() => map.element.classList.add('ready'));
    document.getElementById('loading')?.classList.add('done');
    const app = new App(root, map, puzzle, store, clock, loadCountries, statsService, summaries, reading);
    app.start();
    void loadCountries();
    // Handy for debugging in the console.
    (window as unknown as { chronomap: unknown }).chronomap = { map, app };
  })
  .catch((err) => {
    console.error(err);
    const loading = document.getElementById('loading');
    if (loading) loading.textContent = 'The globe could not be loaded. Please refresh the page.';
  });
