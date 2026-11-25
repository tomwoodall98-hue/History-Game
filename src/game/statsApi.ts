/**
 * Talks to Supabase for the anonymous daily stats and the Roll of Honour,
 * with plain fetch.
 *
 * Only a handful of calls are needed (insert a result, and a few RPCs), so this
 * avoids @supabase/supabase-js, which would add ~59 KB gzipped to a game
 * whose own code is ~95 KB. Every call has a short timeout and never throws:
 * the game must play exactly the same when Supabase is down or slow.
 *
 * The SQL is in supabase/daily-stats.sql (results and stats) and
 * supabase/profiles-leaderboards.sql (usernames and leaderboards).
 */
import { parseStats, type DayStats } from './stats';
import { parseLeaderboard, type Board, type Leaderboard } from './leaderboard';
import { isClaimProblem, type ClaimProblem } from './username';

export interface StatsConfig {
  /** https://<project>.supabase.co */
  url: string;
  /** The publishable (anon) key. Never a secret or service-role key. */
  key: string;
}

/** A finished daily game, as submitted. No personal data. */
export interface Submission {
  playerId: string;
  date: string;
  total: number;
  rounds: number[];
}

/** A player's entry on the roll, as my_profile() returns it. */
export interface Profile {
  username: string | null;
  /** Daily games recorded for the player id. */
  games: number;
}

export type ClaimResult = { ok: true; username: string } | { ok: false; reason: ClaimProblem | 'unavailable' };

export interface StatsService {
  /** True once the result is stored (or was stored before); false on any failure. */
  submit(s: Submission): Promise<boolean>;
  /** A day's aggregates, with the percentile for `score`; null on any failure. */
  stats(date: string, score: number | null): Promise<DayStats | null>;
  /** The name (if any) on a player id; null on any failure. */
  profile(playerId: string): Promise<Profile | null>;
  /** Claims or changes the player's name. */
  claim(playerId: string, username: string): Promise<ClaimResult>;
  /** One leaderboard, with the player's own row; null on any failure. */
  leaderboard(board: Board, playerId: string | null): Promise<Leaderboard | null>;
}

export function parseProfile(raw: unknown): Profile | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (!(r.username === null || (typeof r.username === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(r.username)))) return null;
  if (typeof r.games !== 'number' || !Number.isInteger(r.games) || r.games < 0) return null;
  return { username: r.username, games: r.games };
}

export function parseClaim(raw: unknown): ClaimResult {
  const r = raw as Record<string, unknown> | null;
  if (r?.ok === true && typeof r.username === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(r.username)) return { ok: true, username: r.username };
  if (r?.ok === false && isClaimProblem(r.reason)) return { ok: false, reason: r.reason };
  return { ok: false, reason: 'unavailable' };
}

export const TIMEOUT_MS = 3000;

/** Reads the Vite env vars; null (stats switched off) if either is missing or unsafe. */
export function statsConfig(env: { VITE_SUPABASE_URL?: string; VITE_SUPABASE_PUBLISHABLE_KEY?: string }): StatsConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '') ?? '';
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  // https, or http on this machine (a local Supabase: `supabase start`).
  if (!/^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(url) || !key) return null;
  if (isPrivilegedKey(key)) {
    console.error('Chronomap: a secret or service-role key was configured for the browser; stats are disabled. Use the publishable key.');
    return null;
  }
  return { url, key };
}

/** Secret keys (sb_secret_…) and legacy service-role JWTs must never ship to browsers. */
export function isPrivilegedKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

export function createStatsService(config: StatsConfig, fetchImpl: typeof fetch = (...a) => fetch(...a), timeoutMs = TIMEOUT_MS): StatsService {
  /** One POST with a timeout covering the whole exchange, body included; `fallback` on any failure. */
  const call = async <T>(path: string, body: unknown, read: (res: Response) => Promise<T>, fallback: T, headers: Record<string, string> = {}): Promise<T> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${config.url}/rest/v1/${path}`, {
        method: 'POST',
        headers: { apikey: config.key, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return await read(res);
    } catch {
      return fallback; // offline, blocked, timed out, or not JSON
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    submit: ({ playerId, date, total, rounds }) =>
      call(
        'daily_results',
        { player_id: playerId, puzzle_date: date, total, rounds },
        // 409: this player's result for the day is already in.
        async (res) => res.ok || res.status === 409,
        false,
        // Nothing comes back: anon may insert but never read.
        { Prefer: 'return=minimal' },
      ),
    stats: (date, score) =>
      call('rpc/daily_stats', { p_date: date, p_score: score }, async (res) => (res.ok ? parseStats(await res.json()) : null), null),
    profile: (playerId) =>
      call('rpc/my_profile', { p_player_id: playerId }, async (res) => (res.ok ? parseProfile(await res.json()) : null), null),
    claim: (playerId, username) =>
      call(
        'rpc/claim_username',
        { p_player_id: playerId, p_username: username },
        async (res): Promise<ClaimResult> => (res.ok ? parseClaim(await res.json()) : { ok: false, reason: 'unavailable' }),
        { ok: false, reason: 'unavailable' } as ClaimResult,
      ),
    leaderboard: (board, playerId) =>
      call(
        'rpc/leaderboard',
        { p_board: board, p_player_id: playerId },
        async (res) => {
          const lb = res.ok ? parseLeaderboard(await res.json()) : null;
          return lb && lb.board === board ? lb : null;
        },
        null,
      ),
  };
}
