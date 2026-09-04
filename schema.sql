-- Run once in Supabase Dashboard -> SQL editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  telegram_id bigint primary key,
  auth_id uuid unique,
  username text,
  full_name text not null,
  phone text not null,
  avatar_url text,
  rating integer not null default 1200 check (rating between 100 and 4000),
  games_played integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  mode text not null check (mode in ('friend','ai')),
  white_id text not null,
  white_name text not null default 'White',
  black_id text,
  black_name text,
  ai_level integer check (ai_level between 1 and 4),
  fen text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  move_history jsonb not null default '[]'::jsonb,
  status text not null default 'waiting' check (status in ('waiting','active','white_won','black_won','draw','aborted')),
  result_reason text,
  turn text not null default 'white' check (turn in ('white','black')),
  time_control integer not null default 600 check (time_control between 60 and 3600),
  increment integer not null default 3 check (increment between 0 and 30),
  white_ms integer not null default 600000,
  black_ms integer not null default 600000,
  last_move_at timestamptz,
  draw_offer_by text,
  version integer not null default 0,
  rating_applied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_moves (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  ply integer not null,
  player_id text not null,
  uci text not null,
  san text not null,
  fen_after text not null,
  created_at timestamptz not null default now(),
  unique(game_id, ply)
);

create index if not exists games_code_idx on public.games(code);
create index if not exists games_players_idx on public.games(white_id, black_id, updated_at desc);
create index if not exists game_moves_game_idx on public.game_moves(game_id, ply);

alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.game_moves enable row level security;

drop policy if exists "players can read their games" on public.games;
create policy "players can read their games" on public.games for select to authenticated
using (
  white_id = (select telegram_id::text from public.profiles where auth_id = auth.uid())
  or black_id = (select telegram_id::text from public.profiles where auth_id = auth.uid())
);

drop policy if exists "players can read moves" on public.game_moves;
create policy "players can read moves" on public.game_moves for select to authenticated
using (exists (
  select 1 from public.games g
  where g.id = game_id
    and (
      g.white_id = (select telegram_id::text from public.profiles where auth_id = auth.uid())
      or g.black_id = (select telegram_id::text from public.profiles where auth_id = auth.uid())
    )
));

drop policy if exists "users can read own profile" on public.profiles;
create policy "users can read own profile" on public.profiles for select to authenticated
using (auth_id = auth.uid());

-- Browser clients only SELECT/subscribe. All mutations pass through the Python API.
revoke insert, update, delete on public.games from anon, authenticated;
revoke insert, update, delete on public.game_moves from anon, authenticated;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles, public.games, public.game_moves to authenticated;

-- Realtime publication (safe to re-run).
do $$ begin
  alter publication supabase_realtime add table public.games;
exception when duplicate_object then null;
end $$;
