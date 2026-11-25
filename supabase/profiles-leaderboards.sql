-- Chronomap: optional usernames and the Roll of Honour (leaderboards).
--
-- Run daily-stats.sql first (once), then paste this whole file into the
-- Supabase SQL Editor and run it. It is safe to run again: it creates what
-- is missing and replaces the functions, so re-running it is also how to
-- change the rules below (the blocklists, or the games Best average needs).
--
-- What it sets up:
--   * profiles: a username for an anonymous player_id. No email, no
--     password, no personal data. Claiming a name links it to the id the
--     browser already has, so every past daily result counts at once.
--   * The player_id is the secret that proves a profile is yours (the
--     browser shows it as a "recovery code"). It is never returned by any
--     function below, and nobody can read the tables through the API.
--   * claim_username(id, name), my_profile(id) and leaderboard(board, id):
--     SECURITY DEFINER functions with an empty search_path, returning only
--     usernames, values, games played, dates and ranks.
--
-- Only daily_results feed the boards, and that table only ever takes a
-- result on its own day (see daily-stats.sql), so archive plays never count.

-- ------------------------------------------------------------- settings ---

-- Daily games a player needs to appear on Best average. Change it here (and
-- re-run the file); the game reads it from leaderboard() and needs no change.
create or replace function public.leaderboard_min_average_games()
returns integer
language sql
immutable
set search_path = ''
as $$ select 10 $$;

revoke all on function public.leaderboard_min_average_games() from public, anon, authenticated;

-- --------------------------------------------------------------- tables ---

create table if not exists public.profiles (
  -- The anonymous id from daily_results. Never readable through the API.
  player_id uuid primary key,
  -- As the player typed it; unique ignoring case (index below).
  username text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The format only. The blocklists are checked by claim_username(), so an
  -- admin can still set a reserved name (e.g. an official account) by hand.
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$')
);

comment on table public.profiles is
  'Chronomap usernames for anonymous player ids. Never readable through the API; see leaderboard().';

create unique index if not exists profiles_username_lower on public.profiles (lower(username));

-- A player's results, for the all-time boards (daily_results' own unique
-- index starts with puzzle_date, which serves Today's board).
create index if not exists daily_results_player on public.daily_results (player_id, puzzle_date);

alter table public.profiles enable row level security;
-- No policies and no grants: nobody reads or writes profiles through the
-- API except via the functions below.
revoke all on table public.profiles from anon, authenticated;

-- ------------------------------------------------------------ usernames ---

-- The problem with a name, or null if it may be claimed (if nobody has it):
-- 'length', 'characters', 'letter', 'reserved' or 'unsuitable'. The game
-- checks the same rules as the player types (src/game/username.ts), and a
-- test runs both on the same names, so change both together.
create or replace function public.username_problem(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- Names nobody may take: they could pass for the game, its staff, or "You".
  reserved_names text[] := array[
    'admin', 'administrator', 'anon', 'anonymous', 'api', 'bot', 'chronomap', 'editor', 'everyone', 'guest',
    'help', 'helpdesk', 'me', 'mod', 'moderator', 'mods', 'nobody', 'none', 'null', 'official', 'owner',
    'player', 'postmaster', 'root', 'security', 'server', 'staff', 'supabase', 'support', 'sysadmin', 'system',
    'team', 'test', 'undefined', 'webmaster', 'you'
  ];
  -- Reserved at the start of a name too.
  reserved_prefixes text[] := array['admin', 'chronomap', 'moderator', 'official'];
  -- Rude anywhere in a name, even run together with other words.
  rude_anywhere text[] := array[
    'bastard', 'bellend', 'bitch', 'bollock', 'cunt', 'dildo', 'faggot', 'fuck', 'fuk', 'hitler', 'jizz',
    'kkk', 'nigga', 'nigger', 'paedophile', 'pedophile', 'penis', 'porn', 'retard', 'shit', 'slut', 'tosser',
    'tranny', 'twat', 'vagina', 'wank', 'whore'
  ];
  -- Rude only as a whole word (each hides inside innocent ones: Dickens, Sussex).
  rude_words text[] := array[
    'anal', 'arse', 'ass', 'boob', 'boobs', 'bugger', 'chink', 'clit', 'cock', 'coon', 'crap', 'cum', 'dick',
    'dyke', 'fag', 'gook', 'heil', 'homo', 'kike', 'knob', 'minge', 'nazi', 'nonce', 'paedo', 'paki', 'pedo',
    'piss', 'prick', 'rape', 'sex', 'shag', 'spaz', 'spic', 'tit', 'tits', 'wog'
  ];
  -- Innocent words that contain a rude_anywhere word (the Scunthorpe problem).
  innocent text[] := array['scunthorpe', 'penistone', 'shiitake'];

  lowered text;
  collapsed text;
  bare text;
  squashed text;
  w text;
begin
  if p_name is null or char_length(p_name) < 3 or char_length(p_name) > 20 then
    return 'length';
  end if;
  if p_name !~ '^[A-Za-z0-9_]+$' then
    return 'characters';
  end if;
  if p_name !~ '[A-Za-z]' then
    return 'letter';
  end if;

  lowered := lower(p_name);
  collapsed := replace(lowered, '_', '');
  bare := regexp_replace(collapsed, '[0-9]+$', '');
  -- Digits standing in for letters: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b, 9→g.
  if bare = any (reserved_names)
     or translate(bare, '01345789', 'oieastbg') = any (reserved_names)
     or translate(collapsed, '01345789', 'oieastbg') = any (reserved_names) then
    return 'reserved';
  end if;
  foreach w in array reserved_prefixes loop
    if starts_with(collapsed, w) or starts_with(translate(collapsed, '01345789', 'oieastbg'), w) then
      return 'reserved';
    end if;
  end loop;

  squashed := translate(collapsed, '01345789', 'oieastbg');
  foreach w in array innocent loop
    squashed := replace(squashed, w, '');
  end loop;
  foreach w in array rude_anywhere loop
    if strpos(squashed, w) > 0 then
      return 'unsuitable';
    end if;
  end loop;
  if exists (
    select 1
    from unnest(
      regexp_split_to_array(lowered, '[_0-9]+')
      || string_to_array(translate(lowered, '01345789', 'oieastbg'), '_')
    ) as t(word)
    where t.word = any (rude_words)
  ) then
    return 'unsuitable';
  end if;
  return null;
end;
$$;

revoke all on function public.username_problem(text) from public, anon, authenticated;

-- Claims (or changes) the name for a player id. Returns {"ok": true,
-- "username": …} or {"ok": false, "reason": …}, where reason is one of
-- username_problem()'s, or 'taken'.
create or replace function public.claim_username(p_player_id uuid, p_username text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_username);
  problem text;
begin
  if p_player_id is null then
    raise exception 'A player id is required' using errcode = '22023';
  end if;
  problem := public.username_problem(v_name);
  if problem is not null then
    return jsonb_build_object('ok', false, 'reason', problem);
  end if;
  if exists (
    select 1 from public.profiles p
    where lower(p.username) = lower(v_name) and p.player_id <> p_player_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;

  insert into public.profiles (player_id, username)
  values (p_player_id, v_name)
  on conflict (player_id) do update
    set username = excluded.username, updated_at = now();
  return jsonb_build_object('ok', true, 'username', v_name);
exception
  when unique_violation then
    -- Someone took it in the moment between the check and the insert.
    return jsonb_build_object('ok', false, 'reason', 'taken');
end;
$$;

revoke all on function public.claim_username(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_username(uuid, text) to anon, authenticated;

-- The name (or null) and daily games played for a player id. Used to show
-- "Entered as …", and to confirm a recovery code before it is used.
create or replace function public.my_profile(p_player_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'username', (select p.username from public.profiles p where p.player_id = p_player_id),
    'games', (select count(*) from public.daily_results d where d.player_id = p_player_id)
  );
$$;

revoke all on function public.my_profile(uuid) from public, anon, authenticated;
grant execute on function public.my_profile(uuid) to anon, authenticated;

-- --------------------------------------------------------- leaderboards ---

-- One board: 'today', 'total', 'best' or 'average'. Returns
--   {"board", "date" (today), "minGames",
--    "rows": the top 25 [{"rank", "username", "value", "games", "date"}],
--    "you": the same for p_player_id (rank and value null if not on this
--           board; games is all their daily games), or null without a name}
--
-- Ranking:
--   today    today's score; equal scores share a rank.
--   total    points across every daily game; equal totals share a rank.
--   best     each player's single best day. Never shared: equal scores go
--            to whoever made theirs first (earliest puzzle day, then
--            earliest submission). "date" is the day it was made.
--   average  average daily score, for players with at least
--            leaderboard_min_average_games() games; equal averages share.
-- Within a shared rank, rows are listed by name.
create or replace function public.leaderboard(p_board text, p_player_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Europe/London')::date;
  min_games integer := public.leaderboard_min_average_games();
  top_n constant integer := 25;
  result jsonb;
begin
  if p_board is null or p_board not in ('today', 'total', 'best', 'average') then
    raise exception 'Unknown leaderboard' using errcode = '22023';
  end if;

  with entries as (
    -- One row per named player on this board. Only the branch for p_board runs.
    select p.player_id, p.username, d.total::numeric as value, null::bigint as games,
           null::date as day, null::timestamptz as made_at
    from public.profiles p
    join public.daily_results d on d.player_id = p.player_id and d.puzzle_date = today
    where p_board = 'today'
    union all
    select p.player_id, p.username, sum(d.total)::numeric, count(*), null, null
    from public.profiles p
    join public.daily_results d on d.player_id = p.player_id
    where p_board = 'total'
    group by p.player_id, p.username
    union all
    select b.player_id, b.username, b.total::numeric, null, b.puzzle_date, b.created_at
    from (
      select distinct on (p.player_id) p.player_id, p.username, d.total, d.puzzle_date, d.created_at
      from public.profiles p
      join public.daily_results d on d.player_id = p.player_id
      where p_board = 'best'
      order by p.player_id, d.total desc, d.puzzle_date, d.created_at
    ) b
    union all
    select p.player_id, p.username, avg(d.total), count(*), null, null
    from public.profiles p
    join public.daily_results d on d.player_id = p.player_id
    where p_board = 'average'
    group by p.player_id, p.username
    having count(*) >= min_games
  ),
  ranked as (
    select e.*,
      -- Display order; on 'best' it is the rank as well. (day and made_at
      -- are null on the other boards, so there it falls through to the name.)
      row_number() over (order by e.value desc, e.day nulls last, e.made_at nulls last, lower(e.username)) as pos,
      rank() over (order by e.value desc) as shared_rank
    from entries e
  ),
  shaped as (
    select r.player_id, r.pos,
      jsonb_build_object(
        'rank', case when p_board = 'best' then r.pos else r.shared_rank end,
        'username', r.username,
        'value', round(r.value),
        'games', r.games,
        'date', r.day
      ) as entry
    from ranked r
  )
  select jsonb_build_object(
    'board', p_board,
    'date', today,
    'minGames', min_games,
    'rows', coalesce((select jsonb_agg(f.entry order by f.pos) from shaped f where f.pos <= top_n), '[]'::jsonb),
    'you', coalesce(
      (select f.entry || jsonb_build_object('games', (
                select count(*) from public.daily_results d where d.player_id = p_player_id))
       from shaped f where f.player_id = p_player_id),
      (select jsonb_build_object(
                'rank', null, 'username', p.username, 'value', null, 'date', null,
                'games', (select count(*) from public.daily_results d where d.player_id = p_player_id))
       from public.profiles p where p.player_id = p_player_id)
    )
  )
  into result;

  return result;
end;
$$;

revoke all on function public.leaderboard(text, uuid) from public, anon, authenticated;
grant execute on function public.leaderboard(text, uuid) to anon, authenticated;

-- ---------------------------------------------------- admin (run by hand) ---
--
-- Check a name against the rules (null means fine):
--   select public.username_problem('NewName');
--
-- Rename a player (case-insensitive match on the old name; the new name must
-- be 3–20 letters, numbers or underscores and not already taken):
--   update public.profiles set username = 'NewName', updated_at = now()
--   where lower(username) = lower('OldName');
--
-- Delete a username (their results stay, anonymous again, and they can
-- claim a new name):
--   delete from public.profiles where lower(username) = lower('BadName');
