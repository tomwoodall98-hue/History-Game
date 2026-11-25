/**
 * Progress, history and preferences in localStorage. Every access is
 * wrapped in try/catch: storage can be disabled, full, or throw in private
 * modes, and the game must still be playable (just not remembered).
 */
import type { SavedGame, Stats, Persistence, PastDay, SubmissionState, RoundResult, PlayedGame, ClaimPromptState } from './types';
import type { Units } from './scoring';
import { addDays, daysBetween } from './daily';
import { NEVER_SNOOZED, parseClaimPrompt, snoozeClaim } from './claimPrompt';

/**
 * The key keeps its original name; the format inside it carries its own
 * version. Version 1 kept only the scores of past daily games; version 2 adds
 * each round in full (question, guess, distance) so a day can be reviewed.
 * Version 1 data reads as version 2 with no rounds, and nothing is lost.
 */
const KEY = 'chronomap:v1';
export const STORAGE_VERSION = 2;

/** Summary of a finished daily game, kept for streaks, averages and review. */
export interface HistoryEntry {
  /** Puzzle number. */
  p: number;
  /** Round scores in order. */
  s: number[];
  /**
   * The rounds in full, for reviewing the day (since version 2). Absent for
   * games saved before then, which kept only their scores.
   */
  r?: RoundResult[];
}

export interface StoredData {
  version: typeof STORAGE_VERSION;
  /** The most recent game in full (finished or not). */
  current: SavedGame | null;
  /** Finished daily games by London date key: streaks and stats come from these alone. */
  history: Record<string, HistoryEntry>;
  /** Archive games (past days played later), finished or not, by date key. */
  archive: Record<string, SavedGame>;
  units: Units;
  seenIntro: boolean;
  /** Random id for the anonymous daily stats; no personal data. */
  playerId: string | null;
  /** Daily stats submissions by date key (recent days only). */
  submissions: Record<string, SubmissionState>;
  /** The latest practice replay of a past day. Never a result: nothing reads it for stats. */
  practice: SavedGame | null;
  /** The end-screen prompt to claim a username. */
  claimPrompt: ClaimPromptState;
}

const empty = (): StoredData => ({
  version: STORAGE_VERSION,
  current: null,
  history: {},
  archive: {},
  units: 'km',
  seenIntro: false,
  playerId: null,
  submissions: {},
  practice: null,
  claimPrompt: { ...NEVER_SNOOZED },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Submission records older than this many days are dropped. */
const KEEP_SUBMISSIONS_DAYS = 7;

/** A random (version 4) UUID. */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const isCoord = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

function isRound(v: unknown): v is RoundResult {
  const r = v as RoundResult;
  return (
    !!r &&
    typeof r.questionId === 'string' &&
    (r.guess === null || (Array.isArray(r.guess) && r.guess.length === 2 && isCoord(r.guess[0], 180) && isCoord(r.guess[1], 90))) &&
    typeof r.distanceKm === 'number' &&
    Number.isFinite(r.distanceKm) &&
    r.distanceKm >= 0 &&
    typeof r.score === 'number' &&
    (r.countryFloor === undefined || typeof r.countryFloor === 'number')
  );
}

/** A round as kept in the history: the guess to about a metre, the distance to 100 m. */
function compactRound(r: RoundResult): RoundResult {
  const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
  return {
    questionId: r.questionId,
    // Longitude wrapped into −180…180, the range the parser accepts.
    guess: r.guess ? [round(((((r.guess[0] + 180) % 360) + 360) % 360) - 180, 5), round(r.guess[1], 5)] : null,
    distanceKm: round(r.distanceKm, 1),
    score: r.score,
    ...(r.countryFloor ? { countryFloor: r.countryFloor } : {}),
  };
}

/** The history entry for a finished daily game: its scores, and its rounds in full. */
export function historyEntry(game: SavedGame): HistoryEntry {
  return { p: game.puzzle, s: game.rounds.map((r) => r.score), r: game.rounds.map(compactRound) };
}

const sameScores = (rounds: RoundResult[], scores: number[]) => rounds.length === scores.length && rounds.every((r, i) => r.score === scores[i]);

function isSavedGame(v: unknown): v is SavedGame {
  const g = v as SavedGame;
  return (
    !!g &&
    typeof g.dateKey === 'string' &&
    typeof g.puzzle === 'number' &&
    Array.isArray(g.questionIds) &&
    Array.isArray(g.rounds) &&
    typeof g.finished === 'boolean'
  );
}

/**
 * Parses stored JSON defensively; anything malformed is dropped, not trusted.
 * Older versions are migrated as they are read (see migrate()).
 */
export function parseStored(raw: string | null): StoredData {
  if (!raw) return empty();
  try {
    const v = JSON.parse(raw) as Partial<Omit<StoredData, 'version'>> & { version?: unknown };
    const data = empty();
    if (isSavedGame(v.current)) data.current = v.current;
    if (v.history && typeof v.history === 'object') {
      for (const [k, e] of Object.entries(v.history)) {
        if (DATE_KEY.test(k) && e && Array.isArray(e.s) && e.s.every((n) => typeof n === 'number')) {
          const entry: HistoryEntry = { p: Number(e.p) || 0, s: e.s };
          // Rounds are kept only if they are whole and agree with the scores.
          if (Array.isArray(e.r) && e.r.every(isRound) && sameScores(e.r, e.s)) entry.r = e.r;
          data.history[k] = entry;
        }
      }
    }
    if (v.archive && typeof v.archive === 'object') {
      for (const [k, g] of Object.entries(v.archive)) if (DATE_KEY.test(k) && isSavedGame(g) && g.dateKey === k) data.archive[k] = g;
    }
    if (typeof v.playerId === 'string' && UUID.test(v.playerId)) data.playerId = v.playerId;
    if (v.submissions && typeof v.submissions === 'object') {
      for (const [k, e] of Object.entries(v.submissions)) {
        if (DATE_KEY.test(k) && e && typeof e.done === 'boolean' && Number.isInteger(e.tries)) data.submissions[k] = { done: e.done, tries: e.tries };
      }
    }
    if (isSavedGame(v.practice)) data.practice = v.practice;
    data.claimPrompt = parseClaimPrompt(v.claimPrompt);
    if (v.units === 'mi' || v.units === 'km') data.units = v.units;
    data.seenIntro = v.seenIntro === true;
    return migrate(data);
  } catch {
    return empty();
  }
}

/**
 * Brings older data up to date. Version 1 kept only scores in the history,
 * but the latest game was kept in full as `current`: if that game is a
 * finished daily with the same scores, its rounds fill in that day's
 * guesses. Every other day keeps its scores and simply has no guesses to
 * review.
 */
export function migrate(data: StoredData): StoredData {
  const g = data.current;
  const entry = g ? data.history[g.dateKey] : undefined;
  if (g && entry && !entry.r && g.finished && g.rounds.every(isRound) && sameScores(g.rounds, entry.s)) {
    entry.r = g.rounds.map(compactRound);
  }
  data.version = STORAGE_VERSION;
  return data;
}

/**
 * Streaks count consecutive London days with a finished puzzle. A streak
 * survives until a day is missed, so before today's game is done it runs
 * up to yesterday.
 */
export function computeStats(history: Record<string, HistoryEntry>, todayKey: string): Stats {
  const days = Object.keys(history).sort();
  const totals = days.map((d) => history[d].s.reduce((a, b) => a + b, 0));
  let maxStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    maxStreak = Math.max(maxStreak, run);
    prev = d;
  }
  let currentStreak = 0;
  let cursor = history[todayKey] ? todayKey : addDays(todayKey, -1);
  while (history[cursor]) {
    currentStreak++;
    cursor = addDays(cursor, -1);
  }
  return {
    played: days.length,
    currentStreak,
    maxStreak,
    averageScore: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
    bestScore: totals.length ? Math.max(...totals) : 0,
  };
}

export class LocalStore implements Persistence {
  private data: StoredData;

  constructor(
    private readonly todayKey: () => string,
    private readonly storage: Storage | null = LocalStore.safeStorage(),
  ) {
    this.data = this.read();
  }

  static safeStorage(): Storage | null {
    try {
      const s = window.localStorage;
      const probe = '__chronomap_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch {
      return null;
    }
  }

  private read(): StoredData {
    try {
      return parseStored(this.storage?.getItem(KEY) ?? null);
    } catch {
      return empty();
    }
  }

  private write(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Quota exceeded or storage revoked: keep playing in memory.
    }
  }

  loadGame(dateKey: string): SavedGame | null {
    this.data = this.read(); // another tab may have played
    const g = this.data.current;
    return g && g.dateKey === dateKey ? structuredClone(g) : null;
  }

  saveGame(game: SavedGame): void {
    this.data.current = structuredClone(game);
    if (game.finished && game.rounds.length) this.data.history[game.dateKey] = historyEntry(game);
    this.write();
  }

  loadArchiveGame(dateKey: string): SavedGame | null {
    this.data = this.read();
    const g = this.data.archive[dateKey] ?? this.data.current;
    if (!g || g.dateKey !== dateKey) return null;
    // A daily game finished on the day isn't replayed; one left unfinished carries on here.
    if (g === this.data.current && g.finished) return null;
    return structuredClone(g);
  }

  saveArchiveGame(game: SavedGame): void {
    this.data = this.read();
    this.data.archive[game.dateKey] = structuredClone(game);
    this.write();
  }

  playedGame(dateKey: string): PlayedGame | null {
    this.data = this.read();
    const { history, archive, current } = this.data;
    const e = history[dateKey];
    if (e) {
      // Version 1 entries have no rounds; the full game may still be `current`.
      const full = e.r ?? (current?.dateKey === dateKey && current.finished && sameScores(current.rounds, e.s) ? current.rounds : null);
      return { dateKey, puzzle: e.p, via: 'daily', scores: [...e.s], rounds: full ? structuredClone(full) : null };
    }
    const g = archive[dateKey];
    if (g?.finished && g.rounds.length) {
      return { dateKey, puzzle: g.puzzle, via: 'archive', scores: g.rounds.map((r) => r.score), rounds: structuredClone(g.rounds) };
    }
    return null;
  }

  loadPracticeGame(dateKey: string): SavedGame | null {
    this.data = this.read();
    const g = this.data.practice;
    return g && g.dateKey === dateKey ? structuredClone(g) : null;
  }

  savePracticeGame(game: SavedGame): void {
    this.data = this.read();
    this.data.practice = structuredClone(game);
    this.write();
  }

  claimPrompt(): ClaimPromptState {
    this.data = this.read();
    return { ...this.data.claimPrompt };
  }

  snoozeClaimPrompt(todayKey: string): void {
    this.data = this.read();
    this.data.claimPrompt = snoozeClaim(this.data.claimPrompt, todayKey);
    this.write();
  }

  pastDays(todayKey: string): Record<string, PastDay> {
    this.data = this.read();
    const out: Record<string, PastDay> = {};
    const { current, archive, history } = this.data;
    if (current && current.dateKey < todayKey && !current.finished && current.rounds.length) {
      out[current.dateKey] = { via: 'daily', finished: false, scores: current.rounds.map((r) => r.score) };
    }
    for (const [k, g] of Object.entries(archive)) {
      if (k < todayKey && (g.rounds.length || g.finished)) out[k] = { via: 'archive', finished: g.finished, scores: g.rounds.map((r) => r.score) };
    }
    for (const [k, e] of Object.entries(history)) if (k < todayKey) out[k] = { via: 'daily', finished: true, scores: e.s };
    return out;
  }

  playerId(): string | null {
    if (!this.storage) return null; // an id that can't be kept would count the player again on every visit
    this.data = this.read();
    if (!this.data.playerId) {
      this.data.playerId = randomId();
      this.write();
      if (this.read().playerId !== this.data.playerId) return null; // storage refused it
    }
    return this.data.playerId;
  }

  setPlayerId(id: string): boolean {
    if (!this.storage || !UUID.test(id)) return false;
    this.data = this.read();
    this.data.playerId = id;
    this.write();
    return this.read().playerId === id;
  }

  submission(dateKey: string): SubmissionState {
    this.data = this.read();
    return { ...(this.data.submissions[dateKey] ?? { done: false, tries: 0 }) };
  }

  recordSubmission(dateKey: string, done: boolean): void {
    this.data = this.read();
    const prev = this.data.submissions[dateKey] ?? { done: false, tries: 0 };
    this.data.submissions[dateKey] = { done: prev.done || done, tries: prev.tries + 1 };
    const oldest = addDays(this.todayKey(), -KEEP_SUBMISSIONS_DAYS);
    for (const k of Object.keys(this.data.submissions)) if (k < oldest) delete this.data.submissions[k];
    this.write();
  }

  stats(): Stats {
    return computeStats(this.data.history, this.todayKey());
  }

  getUnits(): Units {
    return this.data.units;
  }

  setUnits(units: Units): void {
    this.data.units = units;
    this.write();
  }

  hasSeenIntro(): boolean {
    return this.data.seenIntro;
  }

  setSeenIntro(): void {
    if (this.data.seenIntro) return;
    this.data.seenIntro = true;
    this.write();
  }
}
