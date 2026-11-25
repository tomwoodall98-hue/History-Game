/**
 * Which puzzle a URL opens, and how:
 *
 *   (no query)                  today's daily
 *   ?day=YYYY-MM-DD             a past day from the archive, played (or carried on)
 *   ?day=…&mode=review          a finished day stepped through, read-only (today's too)
 *   ?day=…&mode=practice        a finished past day replayed as practice, never scored
 *
 * Anything that doesn't apply falls back to the nearest thing that does, and
 * the address is tidied to match.
 */
import { isArchiveDay } from './daily';
import type { PuzzleMode } from './types';

export interface Route {
  /** The puzzle's date key. */
  day: string;
  /** A past day, not today's daily. */
  archive: boolean;
  mode: PuzzleMode;
}

/** The query string for a day (none for today's daily). */
export function routeQuery(day?: string, mode: PuzzleMode = 'play'): string {
  if (!day) return '';
  return mode === 'play' ? `?day=${day}` : `?day=${day}&mode=${mode}`;
}

/**
 * Reads the query string. `played` says whether a day has a finished
 * original result: review and practice need one.
 */
export function resolveRoute(search: string, todayKey: string, played: (day: string) => boolean): Route {
  const params = new URLSearchParams(search);
  const day = params.get('day');
  const mode = params.get('mode');
  if (day && isArchiveDay(day, todayKey)) {
    if ((mode === 'review' || mode === 'practice') && played(day)) return { day, archive: true, mode };
    return { day, archive: true, mode: 'play' };
  }
  // Today can be reviewed once it is done; it is never practised (it is still being played).
  if (day === todayKey && mode === 'review' && played(day)) return { day, archive: false, mode: 'review' };
  return { day: todayKey, archive: false, mode: 'play' };
}

/** The query string a route should have, to tidy the address bar. */
export const canonicalQuery = (route: Route, todayKey: string) => routeQuery(route.day === todayKey && route.mode === 'play' ? undefined : route.day, route.mode);
