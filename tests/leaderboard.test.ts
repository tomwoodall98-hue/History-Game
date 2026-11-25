import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayBoard,
  orderRows,
  ordinal,
  parseLeaderboard,
  rankLabel,
  shortDay,
  type Board,
  type BoardRow,
  type DisplayRow,
  type Leaderboard,
  type YourRow,
} from '../src/game/leaderboard.ts';
import { createStatsService, parseClaim, parseProfile } from '../src/game/statsApi.ts';

const row = (rank: number, username: string, value: number, extra: Partial<BoardRow> = {}): BoardRow => ({
  rank,
  username,
  value,
  games: null,
  date: null,
  ...extra,
});

const board = (b: Board, rows: BoardRow[], you: YourRow | null = null): Leaderboard => ({ board: b, date: '2026-11-25', minGames: 10, rows, you });

/** The rows as "label name" strings, with "…" for a gap and "*" marking the player. */
const show = (lb: Leaderboard) =>
  displayBoard(lb).rows.map((r) => (r.kind === 'gap' ? '…' : `${r.rankLabel} ${r.username}${r.you ? '*' : ''}`));

test('ordinals', () => {
  const cases: [number, string][] = [
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [10, '10th'], [11, '11th'], [12, '12th'], [13, '13th'],
    [21, '21st'], [22, '22nd'], [23, '23rd'], [101, '101st'], [111, '111th'], [112, '112th'], [1003, '1003rd'],
  ];
  for (const [n, s] of cases) assert.equal(ordinal(n), s);
  assert.equal(rankLabel(3, true), '=3rd');
  assert.equal(rankLabel(3, false), '3rd');
});

test('equal values share a rank, marked "="', () => {
  const lb = board('today', [row(1, 'Ada', 6900), row(2, 'Bede', 6100), row(2, 'Cnut', 6100), row(4, 'Dido', 5000)]);
  assert.deepEqual(show(lb), ['1st Ada', '=2nd Bede', '=2nd Cnut', '4th Dido']);
  const total = board('total', [row(1, 'Ada', 70000, { games: 10 }), row(1, 'Bede', 70000, { games: 12 })]);
  assert.deepEqual(show(total), ['=1st Ada', '=1st Bede']);
});

test('All-time best: equal scores are split by whoever made theirs first', () => {
  // As the database sends them: ranks already unique, the earlier day first.
  const rows = [
    row(1, 'Zeno', 6800, { date: '2026-11-02' }),
    row(2, 'Ada', 6800, { date: '2026-11-10' }),
    row(3, 'Bede', 6800, { date: '2026-11-10' }), // same day: Bede submitted after Ada
    row(4, 'Cnut', 6500, { date: '2026-11-01' }),
  ];
  assert.deepEqual(show(board('best', rows)), ['1st Zeno', '2nd Ada', '3rd Bede', '4th Cnut'], 'no "=" on Best');

  // Whatever order they arrive in, they are shown by rank, earliest first.
  const shuffled = [rows[2], rows[3], rows[0], rows[1]];
  assert.deepEqual(
    orderRows('best', shuffled).map((r) => r.username),
    ['Zeno', 'Ada', 'Bede', 'Cnut'],
  );
  const parsed = parseLeaderboard(JSON.parse(JSON.stringify(board('best', shuffled))))!;
  assert.deepEqual(parsed.rows.map((r) => r.username), ['Zeno', 'Ada', 'Bede', 'Cnut']);

  // Even if two best rows ever came with the same rank, the earlier date goes first and neither shows "=".
  const same = [row(1, 'Late', 6800, { date: '2026-11-20' }), row(1, 'Early', 6800, { date: '2026-11-03' })];
  const lb = parseLeaderboard(board('best', same))!;
  assert.deepEqual(show(lb), ['1st Early', '1st Late']);
});

test('shared ranks are listed by name', () => {
  const rows = [row(2, 'bede', 100), row(1, 'Zed', 200), row(2, 'Ada', 100)];
  assert.deepEqual(orderRows('today', rows).map((r) => r.username), ['Zed', 'Ada', 'bede']);
});

test('your row is marked in the top rows', () => {
  const you: YourRow = { rank: 2, username: 'bede', value: 6100, games: 30, date: null };
  const lb = board('today', [row(1, 'Ada', 6900), row(2, 'Bede', 6100), row(3, 'Cnut', 6000)], you);
  assert.deepEqual(show(lb), ['1st Ada', '2nd Bede*', '3rd Cnut'], 'matched ignoring case');
  assert.deepEqual(displayBoard(lb).status, { kind: 'ranked', rank: 2 });
});

const top25 = () => Array.from({ length: 25 }, (_, i) => row(i + 1, `P${i + 1}`, 7000 - i * 10));

test('outside the top 25: your row follows, after a gap if anyone is left out', () => {
  const far = board('total', top25(), { rank: 40, username: 'Me', value: 100, games: 3, date: null });
  const shown = show(far);
  assert.equal(shown.length, 27);
  assert.deepEqual(shown.slice(-3), ['25th P25', '…', '40th Me*']);

  const next = board('total', top25(), { rank: 26, username: 'Me', value: 100, games: 3, date: null });
  assert.deepEqual(show(next).slice(-2), ['25th P25', '26th Me*'], 'directly below: no gap');

  // Tied with the 25th but listed after them by name: no gap, and both marked "=".
  const tiedRows = top25();
  const tied = board('today', tiedRows, { rank: 25, username: 'Zz', value: tiedRows[24].value, games: 3, date: null });
  assert.deepEqual(show(tied).slice(-2), ['=25th P25', '=25th Zz*']);
  assert.deepEqual(displayBoard(tied).status, { kind: 'ranked', rank: 25 });
});

test('your standing when you are not on the board', () => {
  const rows = [row(1, 'Ada', 6900)];
  assert.deepEqual(displayBoard(board('today', rows, null)).status, { kind: 'unnamed' });
  assert.deepEqual(displayBoard(board('today', rows, { rank: null, username: 'Me', value: null, games: 5, date: null })).status, { kind: 'not-today' });
  assert.deepEqual(displayBoard(board('average', rows, { rank: null, username: 'Me', value: null, games: 4, date: null })).status, {
    kind: 'unqualified',
    games: 4,
    needed: 10,
  });
  assert.deepEqual(displayBoard(board('total', [], { rank: null, username: 'Me', value: null, games: 0, date: null })).status, { kind: 'no-games' });
  // Never a stray row for someone who isn't ranked.
  assert.deepEqual(show(board('average', rows, { rank: null, username: 'Me', value: null, games: 4, date: null })), ['1st Ada']);
});

test('your row carries the date on All-time best', () => {
  const lb = board('best', top25(), { rank: 30, username: 'Me', value: 5000, games: 12, date: '2026-11-09' });
  const mine = displayBoard(lb).rows.at(-1) as DisplayRow;
  assert.equal(mine.you, true);
  assert.equal(mine.date, '2026-11-09');
  assert.equal(shortDay('2026-11-09'), '9 Nov 2026');
});

test('leaderboard replies are checked before use', () => {
  const ok = board('total', [row(1, 'Ada', 70000, { games: 10 })], { rank: 1, username: 'Ada', value: 70000, games: 10, date: null });
  assert.deepEqual(parseLeaderboard(JSON.parse(JSON.stringify(ok))), ok);
  for (const bad of [
    null,
    'nope',
    { ...ok, board: 'weekly' },
    { ...ok, date: 'today' },
    { ...ok, minGames: 0 },
    { ...ok, rows: 'x' },
    { ...ok, rows: [{ ...ok.rows[0], rank: 0 }] },
    { ...ok, rows: [{ ...ok.rows[0], username: '<script>' }] },
    { ...ok, rows: [{ ...ok.rows[0], value: -1 }] },
    { ...ok, rows: [{ ...ok.rows[0], games: 1.5 }] },
    { ...ok, rows: [{ ...ok.rows[0], date: 'Tuesday' }] },
    { ...ok, you: { ...ok.you, rank: -2 } },
    { ...ok, you: { ...ok.you, username: 7 } },
  ]) {
    assert.equal(parseLeaderboard(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
  // Nothing beyond the five fields is passed on, even if the server sent it.
  const extra = parseLeaderboard({ ...ok, rows: [{ ...ok.rows[0], player_id: '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d' }] })!;
  assert.deepEqual(Object.keys(extra.rows[0]).sort(), ['date', 'games', 'rank', 'username', 'value']);
});

test('profile and claim replies are checked before use', () => {
  assert.deepEqual(parseProfile({ username: 'Ada', games: 3 }), { username: 'Ada', games: 3 });
  assert.deepEqual(parseProfile({ username: null, games: 0 }), { username: null, games: 0 });
  assert.equal(parseProfile({ username: 'a b', games: 0 }), null);
  assert.equal(parseProfile({ username: 'Ada' }), null);
  assert.deepEqual(parseClaim({ ok: true, username: 'Ada' }), { ok: true, username: 'Ada' });
  assert.deepEqual(parseClaim({ ok: false, reason: 'taken' }), { ok: false, reason: 'taken' });
  assert.deepEqual(parseClaim({ ok: false, reason: 'gremlins' }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(parseClaim(null), { ok: false, reason: 'unavailable' });
});

test('the service calls the right functions and never throws', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const replies: Record<string, unknown> = {
    'rpc/my_profile': { username: 'Ada', games: 4 },
    'rpc/claim_username': { ok: false, reason: 'taken' },
    'rpc/leaderboard': board('today', [row(1, 'Ada', 6000)]),
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const path = url.split('/rest/v1/')[1];
    return new Response(JSON.stringify(replies[path]), { status: 200 });
  }) as unknown as typeof fetch;
  const service = createStatsService({ url: 'https://x.supabase.co', key: 'sb_publishable_x' }, fetchImpl);
  const id = '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d';
  assert.deepEqual(await service.profile(id), { username: 'Ada', games: 4 });
  assert.deepEqual(await service.claim(id, 'Ada'), { ok: false, reason: 'taken' });
  assert.equal((await service.leaderboard('today', id))?.rows[0].username, 'Ada');
  assert.equal(await service.leaderboard('best', id), null, 'a reply for another board is ignored');
  assert.deepEqual(
    calls.map((c) => [c.url, c.body]),
    [
      ['https://x.supabase.co/rest/v1/rpc/my_profile', { p_player_id: id }],
      ['https://x.supabase.co/rest/v1/rpc/claim_username', { p_player_id: id, p_username: 'Ada' }],
      ['https://x.supabase.co/rest/v1/rpc/leaderboard', { p_board: 'today', p_player_id: id }],
      ['https://x.supabase.co/rest/v1/rpc/leaderboard', { p_board: 'best', p_player_id: id }],
    ],
  );

  const down = createStatsService({ url: 'https://x.supabase.co', key: 'k' }, (async () => {
    throw new TypeError('offline');
  }) as unknown as typeof fetch);
  assert.equal(await down.profile(id), null);
  assert.deepEqual(await down.claim(id, 'Ada'), { ok: false, reason: 'unavailable' });
  assert.equal(await down.leaderboard('total', null), null);
  const error = createStatsService({ url: 'https://x.supabase.co', key: 'k' }, (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch);
  assert.deepEqual(await error.claim(id, 'Ada'), { ok: false, reason: 'unavailable' });
});
