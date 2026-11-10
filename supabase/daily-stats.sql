-- Chronomap: anonymous daily stats.
--
-- Paste this whole file into the Supabase SQL Editor and run it once. It is
-- safe to run again: it creates what is missing and resets the grants,
-- policy and function.
--
-- What it sets up:
--   * daily_results: one row per anonymous player per puzzle day.
--   * Row Level Security: the public (anon) role may INSERT today's result
--     and nothing else. Nobody can read raw rows through the API, so player
--     ids never leave the database.
--   * daily_stats(date, score): aggregates only (player count, average,
--     histogram, per-question averages, percentile), for today or earlier.

-- --------------------------------------------------------------- table ---

create table if not exists public.daily_results (
  id bigint generated always as identity primary key,
  -- Random UUID made once per browser and kept in its localStorage. It is
  -- the only link between a player's results, and it is never readable
  -- through the API.
  player_id uuid not null,
  -- The puzzle's date (Europe/London).
  puzzle_date date not null,
  total smallint not null,
  -- The seven round scores, Q1 … Q7.
  rounds smallint[] not null,
  created_at timestamptz not null default now(),

  -- One result per player per day, enforced here, not just in the browser.
  -- (puzzle_date first, so the same index serves the stats queries.)
  constraint daily_results_one_per_player unique (puzzle_date, player_id),
  constraint daily_results_total_range check (total between 0 and 7000),
  constraint daily_results_seven_rounds check (
    array_ndims(rounds) = 1
    and array_lower(rounds, 1) = 1
    and cardinality(rounds) = 7
    and array_position(rounds, null) is null
  ),
  constraint daily_results_round_range check (0 <= all (rounds) and 1000 >= all (rounds)),
  constraint daily_results_rounds_sum check (
    total = rounds[1] + rounds[2] + rounds[3] + rounds[4] + rounds[5] + rounds[6] + rounds[7]
  )
);

comment on table public.daily_results is
  'Chronomap daily results, anonymous. Insert-only for anon; never readable through the API.';

-- ---------------------------------------------------------------- access ---

alter table public.daily_results enable row level security;

-- Supabase grants every new table to anon and authenticated by default.
-- Take that back, then allow anon to fill in the four data columns only
-- (id and created_at are always set by the database).
revoke all on table public.daily_results from anon, authenticated;
grant insert (player_id, puzzle_date, total, rounds) on table public.daily_results to anon;

-- Results only for today's puzzle in Europe/London. (A policy rather than a
-- CHECK constraint: a constraint calling now() would reject old rows on a
-- dump and restore.)
drop policy if exists "Anyone can submit today's result" on public.daily_results;
create policy "Anyone can submit today's result"
  on public.daily_results
  for insert
  to anon
  with check (puzzle_date = (now() at time zone 'Europe/London')::date);

-- No SELECT, UPDATE or DELETE policy or grant: raw rows can't be read,
-- changed or removed through the API by anyone.

-- ----------------------------------------------------------------- stats ---

create or replace function public.daily_stats(p_date date, p_score integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Europe/London')::date;
  result jsonb;
begin
  if p_date is null or p_date > today then
    raise exception 'Stats are only available for today or earlier' using errcode = '22023';
  end if;
  if p_score is not null and (p_score < 0 or p_score > 7000) then
    raise exception 'Score must be between 0 and 7000' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'date', p_date,
    'players', count(*),
    'average', round(avg(r.total)),
    -- Share of players who scored less than p_score, 0–100.
    'percentile', case
      when p_score is null or count(*) = 0 then null
      else round(100.0 * count(*) filter (where r.total < p_score) / count(*), 2)
    end,
    -- Players per band of 500 points: 0–499, 500–999, … 6,500–7,000.
    'histogram', (
      select jsonb_agg(coalesce(h.n, 0) order by b.band)
      from generate_series(0, 13) as b(band)
      left join (
        select least(d.total / 500, 13) as band, count(*) as n
        from public.daily_results d
        where d.puzzle_date = p_date
        group by 1
      ) h on h.band = b.band
    ),
    -- Average score for each of the seven questions.
    'questionAverages', (
      select jsonb_agg(q.average order by q.i)
      from (
        select g.i, round(avg(d.rounds[g.i])) as average
        from generate_series(1, 7) as g(i)
        left join public.daily_results d on d.puzzle_date = p_date
        group by g.i
      ) q
    )
  )
  into result
  from public.daily_results r
  where r.puzzle_date = p_date;

  return result;
end;
$$;

revoke all on function public.daily_stats(date, integer) from public, anon, authenticated;
grant execute on function public.daily_stats(date, integer) to anon, authenticated;

-- ------------------------------------------------- later: optional profiles ---
--
-- Not created now; this is how profiles can be added without changing the
-- table above. A signed-in user claims the anonymous ids from their devices:
--
--   create table public.player_claims (
--     player_id uuid primary key,
--     user_id uuid not null references auth.users (id) on delete cascade,
--     claimed_at timestamptz not null default now()
--   );
--
-- plus a SECURITY DEFINER function claim_player(p_player_id uuid) that inserts
-- (p_player_id, auth.uid()) if nobody has claimed it yet. A player's past
-- results are then daily_results joined through player_claims. Because raw
-- rows (and so player ids) are never readable, holding an id in your own
-- browser's storage is the proof that it is yours.
