create table if not exists users (
  id text primary key,
  clerk_user_id text unique,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists playlists (
  id text primary key,
  session_id text not null,
  user_id text references users(id) on delete set null,
  name text not null,
  source_type text not null,
  source_value text not null,
  imported_at timestamptz not null,
  updated_at timestamptz not null,
  channel_count integer not null default 0,
  groups jsonb not null default '[]'::jsonb,
  channels jsonb not null default '[]'::jsonb
);

create index if not exists playlists_session_id_idx on playlists(session_id);
create index if not exists playlists_updated_at_idx on playlists(updated_at desc);

create table if not exists streams (
  id bigserial primary key,
  stream_url text not null unique,
  stream_name text,
  source_kind text,
  last_status text,
  last_http_code integer,
  last_content_type text,
  last_response_ms integer,
  last_seen_at timestamptz not null default now()
);

create table if not exists favorites (
  id bigserial primary key,
  session_id text not null,
  user_id text references users(id) on delete set null,
  playlist_id text not null,
  channel_id text not null,
  created_at timestamptz not null default now(),
  unique (session_id, playlist_id, channel_id)
);

create index if not exists favorites_session_id_idx on favorites(session_id);

create table if not exists recent_views (
  id bigserial primary key,
  session_id text not null,
  user_id text references users(id) on delete set null,
  playlist_id text not null,
  channel_id text not null,
  name text not null,
  url text not null,
  logo text,
  category text,
  played_at timestamptz not null default now()
);

create index if not exists recent_views_session_id_idx on recent_views(session_id);
create index if not exists recent_views_played_at_idx on recent_views(played_at desc);

create table if not exists checker_reports (
  id text primary key,
  session_id text not null,
  user_id text references users(id) on delete set null,
  source_name text,
  total_count integer not null default 0,
  active_count integer not null default 0,
  dead_count integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists checker_reports_session_id_idx on checker_reports(session_id);
create index if not exists checker_reports_created_at_idx on checker_reports(created_at desc);

create table if not exists exported_files (
  id text primary key,
  session_id text not null,
  user_id text references users(id) on delete set null,
  format text not null,
  active_count integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists exported_files_session_id_idx on exported_files(session_id);

create table if not exists scan_history (
  id text primary key,
  session_id text not null,
  user_id text references users(id) on delete set null,
  input_count integer not null default 0,
  active_count integer not null default 0,
  dead_count integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scan_history_session_id_idx on scan_history(session_id);
create index if not exists scan_history_created_at_idx on scan_history(created_at desc);
