-- SomLuul Production Schema (Supabase Postgres)
-- Run once in Supabase SQL Editor. This is the long-term source of truth
-- instead of a single JSON file (which fails under serverless / multi-instance).

-- Profiles
create table if not exists profiles (
  id text primary key,
  email text unique,
  username text unique,
  first_name text,
  last_name text,
  avatar text,
  cover_photo text,
  bio text,
  phone text,
  country text,
  city text,
  website text,
  gender text,
  dob text,
  work text,
  role text default 'normal',
  blocked boolean default false,
  email_verified boolean default false,
  phone_verified boolean default false,
  followers jsonb default '[]',
  following jsonb default '[]',
  friends jsonb default '[]',
  friend_requests jsonb default '[]',
  devices jsonb default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_profiles_username on profiles (lower(username));
create index if not exists idx_profiles_email on profiles (lower(email));

-- Auth credentials (password hashes only — never store plain passwords)
create table if not exists credentials (
  user_id text primary key references profiles(id) on delete cascade,
  password_hash text not null
);

-- Posts (feed) — never disappear
create table if not exists posts (
  id text primary key,
  author_id text references profiles(id),
  author jsonb not null,
  content text default '',
  media_type text default 'text',
  media_url text,
  media_list jsonb default '[]',
  reactions jsonb default '{}',
  comments jsonb default '[]',
  shares int default 0,
  is_pinned boolean default false,
  is_sponsored boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_posts_created on posts (created_at desc);
create index if not exists idx_posts_author on posts (author_id);

-- Chat rooms
create table if not exists chat_rooms (
  id text primary key,
  name text,
  avatar text,
  is_group boolean default false,
  members jsonb default '[]',
  last_message text,
  last_message_time timestamptz,
  created_at timestamptz default now()
);

-- Chat messages — durable
create table if not exists chat_messages (
  id text primary key,
  room_id text not null references chat_rooms(id) on delete cascade,
  sender_id text,
  sender_name text,
  content text,
  type text default 'text',
  media_url text,
  created_at timestamptz default now(),
  meta jsonb default '{}'
);

create index if not exists idx_messages_room_time on chat_messages (room_id, created_at desc);

-- Notifications
create table if not exists notifications (
  id text primary key,
  user_id text not null,
  type text,
  title text,
  body text,
  data jsonb default '{}',
  read boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_noti_user on notifications (user_id, created_at desc);

-- WebRTC signaling (short-lived; can also use Supabase Realtime channels)
create table if not exists webrtc_signals (
  id text primary key,
  room_id text not null,
  from_user_id text not null,
  target_user_id text,
  type text not null,
  call_type text,
  from_name text,
  sdp jsonb,
  candidate jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_webrtc_room on webrtc_signals (room_id, created_at desc);

-- Auto-clean old signals (keep last 10 minutes)
-- Run via pg_cron or app job:
-- delete from webrtc_signals where created_at < now() - interval '10 minutes';

-- Enable Realtime for instant chat (Supabase Dashboard → Database → Replication)
-- alter publication supabase_realtime add table chat_messages;
-- alter publication supabase_realtime add table webrtc_signals;
-- alter publication supabase_realtime add table notifications;

-- Storage buckets (create in Dashboard if missing):
-- 1) files-bucket  (private) — media, documents, voice notes
-- 2) avatars       (public)  — profile pictures
