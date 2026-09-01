-- Defend The City — Supabase schema
--
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste
-- → Run. It is written to be re-runnable (every statement guards against
-- already existing), so pasting it again after a change is safe.
--
-- SECURITY MODEL, stated plainly so it isn't mistaken for something
-- stronger than it is: the game runs entirely in the player's browser, so
-- the anon key and every request it makes are fully visible to anyone who
-- opens devtools. A determined person can therefore post any score they
-- like. That is an accepted, deliberate trade-off for a friends-and-family
-- leaderboard. What the policies below DO guarantee is that nobody can
-- read other players' feedback, update or delete anyone's row, or store
-- unbounded junk — the CHECK constraints are the real defence here, not
-- the anon key.

-- ---------------------------------------------------------------------
-- Leaderboard
-- ---------------------------------------------------------------------
create table if not exists public.leaderboard (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  player_name   text not null,
  score         integer not null,
  level_reached integer not null,

  -- Bounds are generous but finite. They exist to stop absurd or abusive
  -- values from being stored at all (a 10MB "name", a negative level),
  -- not to detect cheating — see the security note above.
  constraint leaderboard_player_name_len  check (char_length(player_name) between 1 and 24),
  constraint leaderboard_score_range      check (score >= 0 and score <= 100000000),
  constraint leaderboard_level_range      check (level_reached >= 1 and level_reached <= 100000)
);

-- The leaderboard is only ever read one way: highest score first. A
-- descending index on score makes that read cheap no matter how many rows
-- accumulate.
create index if not exists leaderboard_score_desc_idx
  on public.leaderboard (score desc, created_at asc);

alter table public.leaderboard enable row level security;

-- Anyone may READ the leaderboard — that's the whole point of it.
drop policy if exists "leaderboard readable by everyone" on public.leaderboard;
create policy "leaderboard readable by everyone"
  on public.leaderboard for select
  to anon, authenticated
  using (true);

-- Anyone may INSERT a run. Deliberately no UPDATE or DELETE policy at
-- all: with RLS on, an operation with no permissive policy is denied, so
-- a submitted row is immutable from the client. Removing a bad entry is
-- an admin action through the dashboard.
drop policy if exists "anyone may submit a score" on public.leaderboard;
create policy "anyone may submit a score"
  on public.leaderboard for insert
  to anon, authenticated
  with check (true);

-- ---------------------------------------------------------------------
-- Player feedback
-- ---------------------------------------------------------------------
create table if not exists public.feedback (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  message       text not null,
  -- Optional: how to reach the player back. Free text on purpose (an
  -- email, a Discord handle, whatever they prefer) and never required.
  contact       text,
  -- Lightweight context captured automatically so a report like "this
  -- level is impossible" arrives with the level attached.
  level_reached integer,
  score         integer,
  user_agent    text,

  constraint feedback_message_len check (char_length(message) between 1 and 2000),
  constraint feedback_contact_len check (contact is null or char_length(contact) <= 200)
);

alter table public.feedback enable row level security;

-- Write-only from the client: players may submit feedback, but there is
-- deliberately NO select policy, so one player can never read another's
-- messages. Read it yourself in the Supabase dashboard (the service role
-- bypasses RLS), never from the browser.
drop policy if exists "anyone may submit feedback" on public.feedback;
create policy "anyone may submit feedback"
  on public.feedback for insert
  to anon, authenticated
  with check (true);
