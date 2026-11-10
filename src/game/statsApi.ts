/**
 * Talks to Supabase for the anonymous daily stats, with plain fetch.
 *
 * Only two calls are needed (insert a result, call daily_stats), so this
 * avoids @supabase/supabase-js, which would add ~59 KB gzipped to a game
 * whose own code is ~95 KB. Every call has a short timeout and never throws:
 * the game must play exactly the same when Supabase is down or slow.
 *
 * The SQL that sets up the table, policy and function is in
 * supabase/daily-stats.sql.
 */
import { parseStats, type DayStats } from './stats';

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

export interface StatsService {
  /** True once the result is stored (or was stored before); false on any failure. */
  submit(s: Submission): Promise<boolean>;
  /** A day's aggregates, with the percentile for `score`; null on any failure. */
  stats(date: string, score: number | null): Promise<DayStats | null>;
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
  };
}
