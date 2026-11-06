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
  /** Score decay distance in km; null/omitted → tier default. */
  k?: number | null;
  /** Full marks within this many km; null/omitted → tier default. */
  bullseyeKm?: number | null;
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
}
