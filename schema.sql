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
  time_control integer not null default 600 check (time_control between 60 and 604800),
  increment integer not null default 3 check (increment between 0 and 30),
  white_ms integer not null default 600000,
  black_ms integer not null default 600000,
  last_move_at timestamptz,
  draw_offer_by text,
  version integer not null default 0,
  rating_applied boolean not null default false,
  ply_count integer not null default 0,
  casual boolean not null default false,
  correspondence boolean not null default false,
  invited_id text,
  takeback_by text,
  series_id uuid not null default gen_random_uuid(),
  series_best_of integer not null default 3 check (series_best_of in (1, 3, 5)),
  series_game_no integer not null default 1,
  series_score jsonb not null default '{}'::jsonb,
  rematch_of uuid,
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

-- ZAMIN platform progression. Safe to run on an existing project.
alter table public.profiles add column if not exists puzzle_rating integer not null default 800;
alter table public.profiles add column if not exists puzzle_streak integer not null default 0;
alter table public.profiles add column if not exists last_puzzle_date date;
alter table public.profiles add column if not exists army_xp integer not null default 0;
alter table public.profiles add column if not exists equipped_theme text not null default 'registan';
alter table public.profiles add column if not exists performance_mode text not null default 'auto';
alter table public.profiles add column if not exists board_palette text not null default 'pro_green';
alter table public.profiles add column if not exists piece_style text not null default 'staunton';
alter table public.profiles add column if not exists board_shape text not null default 'tournament';

alter table public.games add column if not exists variant text not null default 'standard';
alter table public.games add column if not exists white_checks integer not null default 0;
alter table public.games add column if not exists black_checks integer not null default 0;
alter table public.games add column if not exists spectators_allowed boolean not null default true;
alter table public.games add column if not exists tournament_id uuid;
alter table public.games add column if not exists ply_count integer not null default 0;
alter table public.games add column if not exists casual boolean not null default false;
alter table public.games add column if not exists correspondence boolean not null default false;
alter table public.games add column if not exists invited_id text;
alter table public.games add column if not exists takeback_by text;
alter table public.games add column if not exists series_id uuid not null default gen_random_uuid();
alter table public.games add column if not exists series_best_of integer not null default 3;
alter table public.games add column if not exists series_game_no integer not null default 1;
alter table public.games add column if not exists series_score jsonb not null default '{}'::jsonb;
alter table public.games add column if not exists rematch_of uuid;

update public.games set ply_count = jsonb_array_length(move_history)
where ply_count = 0 and jsonb_array_length(move_history) > 0;

alter table public.games drop constraint if exists games_time_control_check;
alter table public.games add constraint games_time_control_check check (time_control between 60 and 604800);
alter table public.games drop constraint if exists games_series_best_of_check;
alter table public.games add constraint games_series_best_of_check check (series_best_of in (1, 3, 5));

create table if not exists public.bot_states (
  telegram_id bigint primary key,
  awaiting_name boolean not null default false,
  pending_name text,
  pending_challenge text,
  updated_at timestamptz not null default now()
);

create table if not exists public.clans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(name) between 3 and 32),
  owner_id text not null,
  xp integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.clan_members (
  clan_id uuid not null references public.clans(id) on delete cascade,
  user_id text not null unique,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (clan_id, user_id)
);

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(name) between 3 and 48),
  owner_id text not null,
  status text not null default 'registration' check (status in ('registration','active','finished','cancelled')),
  max_players integer not null default 8 check (max_players between 4 and 32),
  variant text not null default 'standard',
  time_control integer not null default 180,
  increment integer not null default 0,
  clan_war boolean not null default false,
  created_at timestamptz not null default now(),
  started_at timestamptz
);

create table if not exists public.tournament_players (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id text not null,
  display_name text not null,
  clan_id uuid references public.clans(id) on delete set null,
  score numeric(5,2) not null default 0,
  joined_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create table if not exists public.puzzle_completions (
  id bigint generated always as identity primary key,
  user_id text not null,
  puzzle_id text not null,
  puzzle_date date not null default current_date,
  elapsed_ms integer not null default 0,
  created_at timestamptz not null default now(),
  unique(user_id, puzzle_id, puzzle_date)
);

do $$ begin
  alter table public.games add constraint games_tournament_id_fkey
    foreign key (tournament_id) references public.tournaments(id) on delete set null;
exception when duplicate_object then null;
end $$;

create index if not exists games_code_idx on public.games(code);
create index if not exists games_players_idx on public.games(white_id, black_id, updated_at desc);
create index if not exists games_series_idx on public.games(series_id, series_game_no);
create index if not exists games_invited_idx on public.games(invited_id, status, created_at desc);
create unique index if not exists games_rematch_of_idx on public.games(rematch_of) where rematch_of is not null;
create index if not exists game_moves_game_idx on public.game_moves(game_id, ply);
create index if not exists clans_code_idx on public.clans(code);
create index if not exists clans_xp_idx on public.clans(xp desc);
create index if not exists tournament_status_idx on public.tournaments(status, created_at desc);
create index if not exists tournament_players_user_idx on public.tournament_players(user_id);
create index if not exists puzzle_user_date_idx on public.puzzle_completions(user_id, puzzle_date desc);

alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.game_moves enable row level security;
alter table public.clans enable row level security;
alter table public.clan_members enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_players enable row level security;
alter table public.puzzle_completions enable row level security;
alter table public.bot_states enable row level security;

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
revoke all on public.clans, public.clan_members, public.tournaments, public.tournament_players, public.puzzle_completions from anon, authenticated;
revoke all on public.bot_states from anon, authenticated;
grant select on public.profiles, public.games, public.game_moves to authenticated;

-- The app uses its own authenticated FastAPI WebSocket rooms. Avoid duplicate
-- WAL/realtime work when this table was added by an older schema version.
do $$ begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime drop table public.games;
  end if;
end $$;

-- Make newly added columns visible to the REST API immediately.
notify pgrst, 'reload schema';
