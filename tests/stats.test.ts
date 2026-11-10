import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANDS,
  bandOf,
  betterThan,
  hardestQuestion,
  histogramBars,
  isEarlyDays,
  parseStats,
  scoreX,
  topPercent,
  type DayStats,
} from '../src/game/stats.ts';
import { createStatsService, isPrivilegedKey, statsConfig } from '../src/game/statsApi.ts';
import { plateLabel, statsPlateSVG } from '../src/ui/statsPlate.ts';
import { shareText } from '../src/game/scoring.ts';

const stats = (over: Partial<DayStats> = {}): DayStats => ({
  date: '2026-11-10',
  players: 20,
  average: 3500,
  histogram: [1, 1, 2, 2, 3, 3, 2, 2, 1, 1, 1, 1, 0, 0],
  questionAverages: [900, 800, 700, 600, 500, 200, 400],
  percentile: 80,
  ...over,
});

test('server replies are checked before use', () => {
  const ok = stats();
  assert.deepEqual(parseStats(JSON.parse(JSON.stringify(ok))), ok);
  const empty = { ...ok, players: 0, average: null, percentile: null, histogram: Array(14).fill(0), questionAverages: Array(7).fill(null) };
  assert.deepEqual(parseStats(empty), empty);
  for (const bad of [
    null,
    'nope',
    { ...ok, date: 'yesterday' },
    { ...ok, players: -1 },
    { ...ok, players: 2.5 },
    { ...ok, average: 9000 },
    { ...ok, percentile: 101 },
    { ...ok, histogram: [1, 2, 3] },
    { ...ok, histogram: [...ok.histogram.slice(1), -1] },
    { ...ok, questionAverages: [1, 2, 3, 4, 5, 6] },
    { ...ok, questionAverages: [1, 2, 3, 4, 5, 6, 1001] },
  ]) {
    assert.equal(parseStats(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('bands of 500, with a perfect 7,000 in the last', () => {
  assert.equal(BANDS, 14);
  assert.equal(bandOf(0), 0);
  assert.equal(bandOf(499), 0);
  assert.equal(bandOf(500), 1);
  assert.equal(bandOf(6999), 13);
  assert.equal(bandOf(7000), 13);
  assert.equal(bandOf(-5), 0);
});

test('"better than X%" rounds down and never overstates', () => {
  assert.equal(betterThan(stats({ percentile: 80 })), 80);
  assert.equal(betterThan(stats({ percentile: 79.99 })), 79);
  assert.equal(betterThan(stats({ percentile: 99.95 })), 99, 'not "better than 100%" unless it is so');
  assert.equal(betterThan(stats({ percentile: 100 })), 100, 'an archive score above everyone that day');
  assert.equal(betterThan(stats({ percentile: 0 })), 0);
  assert.equal(betterThan(stats({ percentile: null })), null);
  assert.equal(betterThan(stats({ players: 0, percentile: null })), null);
});

test('"Top X%" for the share line: only with enough players, only in the top half', () => {
  assert.equal(topPercent(stats({ percentile: 80 })), 20);
  assert.equal(topPercent(stats({ percentile: 79.5 })), 21);
  assert.equal(topPercent(stats({ percentile: 99.99 })), 1, 'never "Top 0%"');
  assert.equal(topPercent(stats({ percentile: 50 })), 50);
  assert.equal(topPercent(stats({ percentile: 49 })), null, 'bottom half: left out');
  assert.equal(topPercent(stats({ players: 4, percentile: 90 })), null, 'early days');
  assert.equal(topPercent(stats({ players: 5, percentile: 90 })), 10);
  assert.equal(shareText(5, [1000, 900, 650, 820, 300, 520, 40], undefined, false, 20), 'Chronomap #5 — 4,230/7,000 🟩🟩🟨🟨🟧🟧🟥 · Top 20%');
});

test('early days and the hardest question', () => {
  assert.equal(isEarlyDays(stats({ players: 3 })), true);
  assert.equal(isEarlyDays(stats({ players: 5 })), false);
  assert.equal(hardestQuestion(stats()), 5);
  assert.equal(hardestQuestion(stats({ questionAverages: [null, null, null, null, null, null, null] })), null);
  assert.equal(hardestQuestion(stats({ questionAverages: [300, null, 100, 100, 900, 900, 900] })), 2, 'first of a tie');
});

test('histogram bars fill the plot and scale to the tallest band', () => {
  const plot = { x: 10, y: 20, w: 280, h: 100 };
  const bars = histogramBars([0, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], plot, 2);
  assert.equal(bars.length, 14);
  assert.deepEqual([bars[0].h, bars[1].h, bars[2].h, bars[13].h], [0, 50, 100, 25]);
  for (const b of bars) {
    assert.ok(b.x >= plot.x && b.x + b.w <= plot.x + plot.w + 1e-9);
    assert.equal(b.y + b.h, plot.y + plot.h, 'bars stand on the base line');
  }
  assert.deepEqual([bars[1].from, bars[1].to, bars[13].from, bars[13].to], [500, 999, 6500, 7000]);
  assert.ok(histogramBars(Array(14).fill(0), plot).every((b) => b.h === 0), 'no players: no bars, no division by zero');
  assert.equal(scoreX(0, plot), 10);
  assert.equal(scoreX(3500, plot), 150);
  assert.equal(scoreX(7000, plot), 290);
  assert.equal(scoreX(9000, plot), 290);
});

test('the plate marks the player’s band and score', () => {
  const svg = statsPlateSVG(stats(), 5230, 'p');
  assert.equal((svg.match(/url\(#p-cross\)/g) ?? []).length, 1, 'one cross-hatched (own) band');
  assert.equal((svg.match(/url\(#p-hatch\)/g) ?? []).length, 11, 'the other bands with players');
  assert.match(svg, /Yours: 5,230/);
  assert.match(svg, />7,000</);
  assert.doesNotMatch(statsPlateSVG(stats(), null, 'p'), /Yours/);
  assert.equal(
    plateLabel(stats(), 5230),
    'Histogram of 20 scores in bands of 500 points. Most players scored 2,000 to 2,499. Your 5,230 is in the 5,000 to 5,499 band.',
  );
});

test('config: needs both values, https, and never a secret key', () => {
  const key = 'sb_publishable_abc';
  assert.deepEqual(statsConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co/', VITE_SUPABASE_PUBLISHABLE_KEY: ` ${key} ` }), {
    url: 'https://x.supabase.co',
    key,
  });
  assert.equal(statsConfig({}), null);
  assert.equal(statsConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co' }), null);
  assert.equal(statsConfig({ VITE_SUPABASE_URL: 'http://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: key }), null, 'http only on this machine');
  assert.equal(statsConfig({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: key })?.url, 'http://127.0.0.1:54321');
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(statsConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' }), null);
  } finally {
    console.error = original;
  }
  const jwt = (role: string) => `x.${btoa(JSON.stringify({ role })).replace(/=+$/, '')}.y`;
  assert.equal(isPrivilegedKey(jwt('service_role')), true);
  assert.equal(isPrivilegedKey(jwt('anon')), false);
  assert.equal(isPrivilegedKey(key), false);
});

type Call = { url: string; init: RequestInit };
const fakeFetch = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond({ url, init });
  }) as unknown as typeof fetch;
  return { f, calls };
};
const cfg = { url: 'https://x.supabase.co', key: 'sb_publishable_abc' };
const result = { playerId: '6f1c0f9e-8a51-4d33-9e57-2a9b6c7d8e9f', date: '2026-11-10', total: 1500, rounds: [500, 500, 500, 0, 0, 0, 0] };

test('submitting: one insert with the publishable key; a duplicate counts as done', async () => {
  const { f, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  assert.equal(await createStatsService(cfg, f).submit(result), true);
  assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/daily_results');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.apikey, 'sb_publishable_abc');
  assert.equal(headers.Prefer, 'return=minimal');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    player_id: result.playerId,
    puzzle_date: '2026-11-10',
    total: 1500,
    rounds: [500, 500, 500, 0, 0, 0, 0],
  });
  assert.equal(await createStatsService(cfg, fakeFetch(() => new Response(null, { status: 409 })).f).submit(result), true);
  assert.equal(await createStatsService(cfg, fakeFetch(() => new Response(null, { status: 403 })).f).submit(result), false);
  assert.equal(
    await createStatsService(cfg, fakeFetch(() => Promise.reject(new TypeError('offline'))).f).submit(result),
    false,
  );
});

test('stats: parsed reply, or null on errors, junk and timeouts', async () => {
  const ok = fakeFetch(() => Response.json(stats()));
  assert.deepEqual(await createStatsService(cfg, ok.f).stats('2026-11-10', 4230), stats());
  assert.equal(ok.calls[0].url, 'https://x.supabase.co/rest/v1/rpc/daily_stats');
  assert.deepEqual(JSON.parse(String(ok.calls[0].init.body)), { p_date: '2026-11-10', p_score: 4230 });
  assert.equal(await createStatsService(cfg, fakeFetch(() => new Response('oops', { status: 500 })).f).stats('2026-11-10', 1), null);
  assert.equal(await createStatsService(cfg, fakeFetch(() => new Response('not json')).f).stats('2026-11-10', 1), null);
  assert.equal(await createStatsService(cfg, fakeFetch(() => Response.json({ players: 'many' })).f).stats('2026-11-10', 1), null);
  // A server that never answers: aborted after the timeout.
  const hang = ((_: string, init: RequestInit) =>
    new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await createStatsService(cfg, hang, 50).stats('2026-11-10', 1), null);
  assert.ok(Date.now() - started < 1000);
});
