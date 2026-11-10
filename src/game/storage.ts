/**
 * Progress, history and preferences in localStorage. Every access is
 * wrapped in try/catch: storage can be disabled, full, or throw in private
 * modes, and the game must still be playable (just not remembered).
 */
import type { SavedGame, Stats, Persistence, PastDay, SubmissionState } from './types';
import type { Units } from './scoring';
import { addDays, daysBetween } from './daily';

const KEY = 'chronomap:v1';

/** Summary of a finished game, kept for streaks and averages. */
export interface HistoryEntry {
  /** Puzzle number. */
  p: number;
  /** Round scores in order. */
  s: number[];
}

export interface StoredData {
  version: 1;
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
}

const empty = (): StoredData => ({
  version: 1,
  current: null,
  history: {},
  archive: {},
  units: 'km',
  seenIntro: false,
  playerId: null,
  submissions: {},
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

/** Parses stored JSON defensively; anything malformed is dropped, not trusted. */
export function parseStored(raw: string | null): StoredData {
  if (!raw) return empty();
  try {
    const v = JSON.parse(raw) as Partial<StoredData>;
    const data = empty();
    if (isSavedGame(v.current)) data.current = v.current;
    if (v.history && typeof v.history === 'object') {
      for (const [k, e] of Object.entries(v.history)) {
        if (DATE_KEY.test(k) && e && Array.isArray(e.s) && e.s.every((n) => typeof n === 'number')) {
          data.history[k] = { p: Number(e.p) || 0, s: e.s };
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
    if (v.units === 'mi' || v.units === 'km') data.units = v.units;
    data.seenIntro = v.seenIntro === true;
    return data;
  } catch {
    return empty();
  }
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
    if (game.finished && game.rounds.length) {
      this.data.history[game.dateKey] = { p: game.puzzle, s: game.rounds.map((r) => r.score) };
    }
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
