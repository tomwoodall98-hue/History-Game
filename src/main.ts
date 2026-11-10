import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/im-fell-english/latin-400-italic.css';
import '@fontsource/im-fell-english-sc/latin-400.css';
import './styles/main.css';
import globeUrl from './data/globe.topo.json?url';
import countriesUrl from './data/countries.topo.json?url';
import questionsData from './data/questions.json';
import scheduleData from './data/schedule.json';
import { GlobeView } from './map/GlobeView';
import type { GlobeBase } from './map/globeData';
import { applyPaperTexture } from './map/texture';
import { App } from './ui/App';
import type { Question, Puzzle, Clock } from './game/types';
import { isArchiveDay, londonDateKey, nextLondonMidnight } from './game/daily';
import { dailyPuzzle, type Schedule } from './game/schedule';
import { LocalStore } from './game/storage';
import { CountryIndex, type CountryLookup } from './game/countries';
import { createStatsService, statsConfig } from './game/statsApi';

// Start the map download before anything else.
const basePromise: Promise<GlobeBase> = fetch(globeUrl).then((r) => {
  if (!r.ok) throw new Error(`Map data failed to load (${r.status})`);
  return r.json();
});

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
// from the archive (?day=YYYY-MM-DD; never today or later).
const allQuestions = questionsData as Question[];
const todayKey = londonDateKey();
const store = new LocalStore(() => londonDateKey());
const requested = new URLSearchParams(location.search).get('day');
const archiveDay = requested && isArchiveDay(requested, todayKey) ? requested : null;
if (requested && !archiveDay) history.replaceState(null, '', location.pathname + location.hash);
const daily = dailyPuzzle(allQuestions, scheduleData as Schedule, archiveDay ?? todayKey);
const puzzle: Puzzle = { ...daily, archive: archiveDay != null };
// If a game was started before the question bank changed (a new deploy
// mid-day), keep the questions the player was actually given.
const saved = archiveDay ? store.loadArchiveGame(archiveDay) : store.loadGame(todayKey);
if (saved && saved.questionIds.join() !== daily.questions.map((q) => q.id).join()) {
  const byId = new Map(allQuestions.map((q) => [q.id, q]));
  const kept = saved.questionIds.map((id) => byId.get(id));
  if (kept.length === daily.questions.length && kept.every(Boolean)) puzzle.questions = kept as Question[];
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

const clock: Clock = {
  msUntilNext: () => nextLondonMidnight().getTime() - Date.now(),
  todayKey: () => londonDateKey(),
};

basePromise
  .then((base) => {
    map.render(base);
    requestAnimationFrame(() => map.element.classList.add('ready'));
    document.getElementById('loading')?.classList.add('done');
    const app = new App(root, map, puzzle, store, clock, loadCountries, statsService);
    app.start();
    void loadCountries();
    // Handy for debugging in the console.
    (window as unknown as { chronomap: unknown }).chronomap = { map, app };
  })
  .catch((err) => {
    console.error(err);
    const loading = document.getElementById('loading');
    if (loading) loading.textContent = 'The map could not be loaded. Please refresh the page.';
  });
