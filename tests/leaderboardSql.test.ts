/**
 * Runs the real SQL (supabase/daily-stats.sql, then
 * supabase/profiles-leaderboards.sql) in PGlite, Postgres compiled to
 * WebAssembly, and checks the functions as the public (anon) role sees them:
 * the rankings, the tie-breaking, the username rules, and that no player id
 * ever comes back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { usernameProblem } from '../src/game/username.ts';
import { parseLeaderboard, displayBoard, type Board, type Leaderboard } from '../src/game/leaderboard.ts';
import { addDays } from '../src/game/daily.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sql = (file: string) => readFileSync(resolve(ROOT, 'supabase', file), 'utf8');

let db: PGlite;
let today: string;
const ids: string[] = [];
let n = 0;
/** A fresh player id. */
const player = () => {
  n++;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  ids.push(id);
  return id;
};

/** Seven rounds adding up to `total`. */
const roundsFor = (total: number) => {
  const r = Array(7).fill(Math.floor(total / 7));
  r[0] += total - r.reduce((a, b) => a + b, 0);
  return `{${r.join(',')}}`;
};

/** Stores a result directly (as the database owner, so any day is allowed). */
async function result(id: string, day: string, total: number, at?: string): Promise<void> {
  await db.query(`insert into public.daily_results (player_id, puzzle_date, total, rounds, created_at) values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))`, [
    id,
    day,
    total,
    roundsFor(total),
    at ?? null,
  ]);
}

/** Runs a query as the public (anon) role, as the browser does. */
async function asAnon<T>(query: string, params: unknown[] = []): Promise<T[]> {
  await db.exec('set role anon');
  try {
    return (await db.query<T>(query, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

const claim = async (id: string, name: string) =>
  (await asAnon<{ r: { ok: boolean; reason?: string; username?: string } }>('select public.claim_username($1, $2) as r', [id, name]))[0].r;

const raw = new Map<string, string>();
async function leaderboard(b: Board, id: string | null = null): Promise<Leaderboard> {
  const r = (await asAnon<{ r: unknown }>('select public.leaderboard($1, $2) as r', [b, id]))[0].r;
  raw.set(`${b}:${id}`, JSON.stringify(r));
  const lb = parseLeaderboard(r);
  assert.ok(lb, `leaderboard(${b}) parses: ${JSON.stringify(r).slice(0, 200)}`);
  return lb;
}
const names = (lb: Leaderboard) => lb.rows.map((r) => `${r.rank} ${r.username} ${r.value}`);

before(async () => {
  db = new PGlite();
  // The roles Supabase provides.
  await db.exec(`create role anon nologin; create role authenticated nologin;`);
  await db.exec(sql('daily-stats.sql'));
  await db.exec(sql('profiles-leaderboards.sql'));
  // Run it twice: it must be safe to re-run.
  await db.exec(sql('profiles-leaderboards.sql'));
  today = (await db.query<{ d: string }>(`select ((now() at time zone 'Europe/London')::date)::text as d`)).rows[0].d;
});

after(async () => {
  await db?.close();
});

test('the database and the game agree on every username rule', async () => {
  const samples = [
    'Ada', 'ab', '', 'abcdefghijklmnopqrstu', 'abcdefghijklmnopqrst', 'ada lovelace', 'Zoë', '1851', '___', 'x_1',
    'admin', 'ADMIN', 'ad_min', 'admin_99', '4dmin', '4dm1n', 'Chronomap_Fan', 'Moderator7', 'mod', 'badminton', 'Modernist',
    'You', 'Youngblood', 'official_bob', 'fuck', 'f_u_c_k', 'sh1t_head', 'b1tch', 'ass', 'Ass_Hat', 'ass69', 'a55', 'Classic_Maps',
    'Scunthorpe_Utd', 'Penistone', 'Dickens', 'big_dick', 'Sussex', 'Middlesex1066', 'NAZI_1', 'Nazir', 'Hitler_fan', 'Grapefruit',
    'Cockburn', 'Titanic', 'Arsenal', 'Shiitake', 'heil_99', 'tit', 'pornking', 'Henry8', '_Mercator_', 'test', 'Test_Pilot',
  ];
  for (const name of samples) {
    const { p } = (await db.query<{ p: string | null }>('select public.username_problem($1) as p', [name])).rows[0];
    assert.equal(p, usernameProblem(name), `"${name}": database says ${p}, game says ${usernameProblem(name)}`);
  }
});

test('claiming a name: rules, uniqueness ignoring case, renaming', async () => {
  const a = player();
  const b = player();
  assert.deepEqual(await claim(a, 'Mercator'), { ok: true, username: 'Mercator' });
  assert.deepEqual(await claim(b, 'mercator'), { ok: false, reason: 'taken' }, 'unique ignoring case');
  assert.deepEqual(await claim(b, ' Ortelius '), { ok: true, username: 'Ortelius' }, 'trimmed');
  assert.deepEqual(await claim(b, 'Admin'), { ok: false, reason: 'reserved' });
  assert.deepEqual(await claim(b, 'two words'), { ok: false, reason: 'characters' });
  assert.deepEqual(await claim(b, 'f_u_c_k'), { ok: false, reason: 'unsuitable' });
  // Renaming frees the old name.
  assert.deepEqual(await claim(a, 'Gerardus'), { ok: true, username: 'Gerardus' });
  assert.deepEqual(await claim(b, 'MERCATOR'), { ok: true, username: 'MERCATOR' });
  assert.deepEqual(await claim(a, 'gerardus'), { ok: true, username: 'gerardus' }, 'changing only the case of your own name');
  const [{ r }] = await asAnon<{ r: unknown }>('select public.my_profile($1) as r', [b]);
  assert.deepEqual(r, { username: 'MERCATOR', games: 0 });
  await db.exec(`delete from public.profiles`);
});

test('past daily results count as soon as a name is claimed', async () => {
  const id = player();
  await result(id, addDays(today, -3), 4000);
  await result(id, addDays(today, -2), 5000);
  assert.equal((await leaderboard('total', id)).you, null, 'no name, not on the roll');
  await claim(id, 'Latecomer');
  const lb = await leaderboard('total', id);
  assert.deepEqual(lb.you, { rank: 1, username: 'Latecomer', value: 9000, games: 2, date: null });
  await db.exec(`delete from public.profiles; delete from public.daily_results;`);
});

test('the four boards, with ties and the player’s own row', async () => {
  const [ada, bede, cnut, dido, eadu, anon] = [player(), player(), player(), player(), player(), player()];
  await claim(ada, 'Ada');
  await claim(bede, 'Bede');
  await claim(cnut, 'Cnut');
  await claim(dido, 'Dido');
  await claim(eadu, 'Eadu');
  // anon never claims a name: counted in stats, never on the roll.
  const d = (k: number) => addDays(today, -k);

  // Ada: 12 games averaging 5,000, best 6,800 made on day -11.
  for (let k = 1; k <= 12; k++) await result(ada, d(k), k === 11 ? 6800 : k === 12 ? 3200 : 5000);
  // Bede: 10 games averaging 5,000 (ties Ada on average), best 6,800 made later (day -3).
  for (let k = 1; k <= 10; k++) await result(bede, d(k), k === 3 ? 6800 : k === 4 ? 3200 : 5000);
  // Cnut: 8 games (9 with today's), high scores, but short of the minimum for Best average.
  for (let k = 1; k <= 8; k++) await result(cnut, d(k), 6900);
  // Dido and Eadu: best 6,800 on the same day; Dido submitted first.
  await result(dido, d(11), 6800, `${d(11)}T09:00:00Z`);
  await result(eadu, d(11), 6800, `${d(11)}T08:00:00Z`);
  await result(anon, d(1), 7000);
  // Today: Bede and Cnut tie, Ada lower, anon top.
  await result(bede, today, 6000);
  await result(cnut, today, 6000);
  await result(ada, today, 5500);
  await result(anon, today, 7000);

  const t = await leaderboard('today', ada);
  assert.deepEqual(names(t), ['1 Bede 6000', '1 Cnut 6000', '3 Ada 5500'], 'shared rank, listed by name; the unnamed player is left out');
  assert.equal(t.date, today);
  assert.deepEqual(t.you, { rank: 3, username: 'Ada', value: 5500, games: 13, date: null });
  assert.deepEqual(displayBoard(t).rows.map((r) => (r.kind === 'row' ? r.rankLabel : '…')), ['=1st', '=1st', '3rd']);
  const notToday = await leaderboard('today', dido);
  assert.deepEqual(notToday.you, { rank: null, username: 'Dido', value: null, games: 1, date: null });

  const total = await leaderboard('total', ada);
  assert.deepEqual(names(total), ['1 Ada 65500', '2 Cnut 61200', '3 Bede 56000', '4 Dido 6800', '4 Eadu 6800']);
  assert.deepEqual(
    total.rows.map((r) => r.games),
    [13, 9, 11, 1, 1],
  );

  // All-time best: four players on 6,800, ranked by who made it first.
  // Eadu, Dido and Ada all made it on day -11: Eadu submitted at 08:00,
  // Dido at 09:00, Ada later ("now"). Bede's came on day -3. Cnut's 6,900
  // was first made on day -8 (the earliest of eight equal scores).
  const best = await leaderboard('best', eadu);
  assert.deepEqual(
    best.rows.map((r) => [r.rank, r.username, r.value, r.date]),
    [
      [1, 'Cnut', 6900, d(8)],
      [2, 'Eadu', 6800, d(11)],
      [3, 'Dido', 6800, d(11)],
      [4, 'Ada', 6800, d(11)],
      [5, 'Bede', 6800, d(3)],
    ],
  );
  assert.deepEqual(best.you, { rank: 2, username: 'Eadu', value: 6800, games: 1, date: d(11) });
  assert.ok(displayBoard(best).rows.every((r) => r.kind === 'row' && !r.tied), 'no "=" on Best');

  const avg = await leaderboard('average', cnut);
  assert.equal(avg.minGames, 10);
  assert.deepEqual(avg.rows.map((r) => [r.rank, r.username, r.value, r.games]), [
    [1, 'Bede', 5091, 11],
    [2, 'Ada', 5038, 13],
  ]);
  assert.deepEqual(avg.you, { rank: null, username: 'Cnut', value: null, games: 9, date: null }, 'one game short');
  assert.deepEqual(displayBoard(avg).status, { kind: 'unqualified', games: 9, needed: 10 });
});

test('top 25, with the player’s own row from further down', async () => {
  await db.exec(`delete from public.profiles; delete from public.daily_results;`);
  const all: string[] = [];
  for (let i = 0; i < 40; i++) {
    const id = player();
    all.push(id);
    await claim(id, `Voyager_${String(i + 1).padStart(2, '0')}`);
    await result(id, today, 7000 - i * 100);
  }
  const lb = await leaderboard('today', all[34]);
  assert.equal(lb.rows.length, 25);
  assert.equal(lb.rows[24].username, 'Voyager_25');
  assert.deepEqual(lb.you, { rank: 35, username: 'Voyager_35', value: 3600, games: 1, date: null });
  const shown = displayBoard(lb).rows;
  assert.equal(shown.length, 27);
  assert.equal(shown[25].kind, 'gap');
});

test('Best average needs leaderboard_min_average_games() games', async () => {
  const { m } = (await db.query<{ m: number }>('select public.leaderboard_min_average_games() as m')).rows[0];
  assert.equal(m, 10);
  const id = player();
  await claim(id, 'Steady');
  for (let k = 1; k < m; k++) await result(id, addDays(today, -k - 1), 6000);
  assert.equal((await leaderboard('average', id)).you?.rank, null, `${m - 1} games: not yet`);
  await result(id, addDays(today, -1), 6000);
  assert.equal((await leaderboard('average', id)).you?.rank, 1, `${m} games: on the board`);
});

test('the public can call the functions but never read a player id', async () => {
  for (const table of ['profiles', 'daily_results']) {
    await assert.rejects(asAnon(`select * from public.${table}`), /permission denied/, table);
  }
  await assert.rejects(asAnon(`update public.profiles set username = 'Hacker'`), /permission denied/);
  await assert.rejects(asAnon(`delete from public.profiles`), /permission denied/);
  await assert.rejects(asAnon(`select public.username_problem('x')`), /permission denied/, 'internal helper');
  await assert.rejects(asAnon(`select public.leaderboard('weekly')`), /Unknown leaderboard/);

  // Every reply seen in these tests: no player id anywhere.
  for (const b of ['today', 'total', 'best', 'average'] as const) await leaderboard(b, ids[ids.length - 1]);
  const everything = [...raw.values()].join('\n');
  assert.ok(raw.size >= 8);
  for (const id of ids) assert.ok(!everything.includes(id), `player id ${id} leaked`);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(everything), 'nothing shaped like an id');
  assert.ok(!everything.includes('player_id'));
});

test('reads are SECURITY DEFINER with a fixed, empty search_path', async () => {
  const { rows } = await db.query<{ name: string; secdef: boolean; config: string[] | null }>(
    `select p.proname as name, p.prosecdef as secdef, p.proconfig as config
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('leaderboard', 'my_profile', 'claim_username', 'daily_stats')
     order by 1`,
  );
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.secdef, true, r.name);
    assert.deepEqual(r.config, ['search_path=""'], r.name);
  }
});
