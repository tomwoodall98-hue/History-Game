import type { Units } from './scoring';

export type LngLat = [number, number];

export type Tier = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const TIERS: readonly Tier[] = [1, 2, 3, 4, 5, 6, 7];

/** One entry in src/data/questions.json. */
export interface Question {
  /** Stable, unique, never reused (e.g. "t3-waterloo"). */
  id: string;
  /** What happened, as shown to the player. */
  event: string;
  /** Human date: "14 October 1066", "AD 79", "c. 2560 BC", "1815". */
  dateDisplay: string;
  /** Astronomical-ish year for sorting and filtering; negative for BC. */
  year: number;
  tier: Tier;
  lat: number;
  lng: number;
  /** Score decay distance in km; null/omitted → tier default (× SEA_K_FACTOR at sea). */
  k?: number | null;
  /** Full marks within this many km; null/omitted → tier default. */
  bullseyeKm?: number | null;
  /** Happened at sea: no same-country floor, and a longer default k. */
  atSea?: boolean;
  /**
   * ADM0_A3 code of the answer's modern country, for the rare answer the
   * country outlines miss (an island too small for them). Usually left out.
   */
  country?: string;
  /** One or two sentences shown after the guess. */
  note: string;
  /** Where the coordinates can be checked (usually Wikipedia). */
  source: string;
}

export interface RoundResult {
  questionId: string;
  /** null if the player confirmed without a mark (shouldn't happen in UI). */
  guess: LngLat | null;
  distanceKm: number;
  score: number;
  /** The same-country floor, when it decided the score. */
  countryFloor?: number;
}

export interface Puzzle {
  number: number;
  /** YYYY-MM-DD in Europe/London. */
  dateKey: string;
  /** e.g. "Friday 6 November 2026". */
  dateLabel: string;
  /** A past day replayed from the archive, not today's daily. */
  archive: boolean;
  questions: Question[];
}

/** What gets saved between visits for one day's puzzle. */
export interface SavedGame {
  dateKey: string;
  puzzle: number;
  questionIds: string[];
  rounds: RoundResult[];
  /** A mark placed but not yet confirmed. */
  pendingGuess: LngLat | null;
  finished: boolean;
}

export interface Stats {
  played: number;
  currentStreak: number;
  maxStreak: number;
  averageScore: number;
  bestScore: number;
}

/** What the player did on a past day, for the archive ledger. */
export interface PastDay {
  /** Played on the day itself, or later from the archive. */
  via: 'daily' | 'archive';
  finished: boolean;
  /** Round scores so far. */
  scores: number[];
}

export interface Persistence {
  /** Today's daily game. */
  loadGame(dateKey: string): SavedGame | null;
  /** Saves a daily game; a finished one counts towards streaks and stats. */
  saveGame(game: SavedGame): void;
  /** An archive game: its own save, or else a daily game left unfinished on that day. */
  loadArchiveGame(dateKey: string): SavedGame | null;
  /** Saves an archive game apart from daily results; it never touches streaks or stats. */
  saveArchiveGame(game: SavedGame): void;
  /** Every past day the player has played, by date key. */
  pastDays(todayKey: string): Record<string, PastDay>;
  /** Stats including today's finished game, if any. */
  stats(): Stats;
  getUnits(): Units;
  setUnits(units: Units): void;
  hasSeenIntro(): boolean;
  setSeenIntro(): void;
}

export interface Clock {
  /** Milliseconds until the next puzzle (midnight, Europe/London). */
  msUntilNext(): number;
  /** dateKey for "now" in Europe/London. */
  todayKey(): string;
}

