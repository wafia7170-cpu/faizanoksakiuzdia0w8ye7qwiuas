-- Run this ONCE in the Supabase SQL editor (Project → SQL → New query).
-- It creates the chat_messages table, enables real-time streaming on it,
-- and sets permissive RLS policies for anon read / insert / update / delete.
--
-- NOTE: This site is a private birthday gift; the anon key is effectively
-- shared between two people, so a permissive policy is fine. If you ever
-- want tighter rules, restrict UPDATE / DELETE to a `session_id` claim.

-- 1) Table
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) <= 2000),
  sender text not null check (sender in ('habiba', 'faizan')),
  timestamp bigint not null,
  session_id text,
  edited boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_timestamp_idx
  on public.chat_messages (timestamp desc);

-- 2) Enable Row-Level Security
alter table public.chat_messages enable row level security;

-- 3) Permissive policies for the anon role (drop-if-exists → re-create pattern)
drop policy if exists "anon_read_chat"   on public.chat_messages;
drop policy if exists "anon_insert_chat" on public.chat_messages;
drop policy if exists "anon_update_chat" on public.chat_messages;
drop policy if exists "anon_delete_chat" on public.chat_messages;

create policy "anon_read_chat"
  on public.chat_messages
  for select
  to anon, authenticated
  using (true);

create policy "anon_insert_chat"
  on public.chat_messages
  for insert
  to anon, authenticated
  with check (
    char_length(text) between 1 and 2000
    and sender in ('habiba', 'faizan')
  );

create policy "anon_update_chat"
  on public.chat_messages
  for update
  to anon, authenticated
  using (true)
  with check (char_length(text) between 1 and 2000);

create policy "anon_delete_chat"
  on public.chat_messages
  for delete
  to anon, authenticated
  using (true);

-- 4) Enable Realtime (publish INSERT / UPDATE / DELETE)
--    If the publication doesn't exist yet, create it first.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

alter publication supabase_realtime add table public.chat_messages;

-- 5) Ensure UPDATE events include the full row (needed for edit sync)
alter table public.chat_messages replica identity full;


-- =====================================================================
-- GAME SCORES TABLE
-- =====================================================================
-- Stores every completed game run so Faizan & Habiba can compete across
-- devices. The app maintains a local cache too, so this table is a
-- best-effort cross-device sync layer, not a strict source of truth.

-- 1) Table
create table if not exists public.game_scores (
  id uuid primary key default gen_random_uuid(),
  player text not null check (player in ('Faizan', 'Habiba')),
  game_id text not null check (game_id in (
    'heart-catcher',
    'love-tap',
    'find-teddy',
    'jigsaw-puzzle',
    'heart-maze',
    'ring-catcher',
    'piano-love-notes',
    'constellation',
    'heart-stack',
    'tic-tac-toe',
    'rock-paper-scissors'
  )),
  score integer not null check (score >= 0),
  is_new_record boolean not null default false,
  played_at timestamptz not null default now()
);

create index if not exists game_scores_played_at_idx
  on public.game_scores (played_at desc);
create index if not exists game_scores_game_player_idx
  on public.game_scores (game_id, player, score desc);

-- 2) Enable Row-Level Security
alter table public.game_scores enable row level security;

-- 3) Permissive policies for the anon role
drop policy if exists "anon_read_scores"   on public.game_scores;
drop policy if exists "anon_insert_scores" on public.game_scores;
drop policy if exists "anon_update_scores" on public.game_scores;
drop policy if exists "anon_delete_scores" on public.game_scores;

create policy "anon_read_scores"
  on public.game_scores
  for select
  to anon, authenticated
  using (true);

create policy "anon_insert_scores"
  on public.game_scores
  for insert
  to anon, authenticated
  with check (
    player in ('Faizan', 'Habiba')
    and score >= 0
    and game_id in (
      'heart-catcher','love-tap','find-teddy','jigsaw-puzzle',
      'heart-maze','ring-catcher','piano-love-notes','constellation','heart-stack',
      'tic-tac-toe','rock-paper-scissors'
    )
  );

create policy "anon_update_scores"
  on public.game_scores
  for update
  to anon, authenticated
  using (true)
  with check (score >= 0);

create policy "anon_delete_scores"
  on public.game_scores
  for delete
  to anon, authenticated
  using (true);

-- 4) Enable Realtime for cross-device live sync
alter publication supabase_realtime add table public.game_scores;

-- 5) Ensure UPDATE events include the full row
alter table public.game_scores replica identity full;


-- =====================================================================
-- CHAT MEDIA STORAGE BUCKET (for photos & voice messages)
-- =====================================================================
-- The chat overlay uploads images + voice notes to a public bucket named
-- "chat-media". Without this bucket the uploads silently fail and the
-- optimistic preview vanishes with no feedback.

-- 1) Create the bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  true,
  52428800,  -- 50 MB per file
  array['image/jpeg','image/png','image/gif','image/webp','image/heic',
        'audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/wav']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) Anon RLS policies for storage.objects (scoped to this bucket)
drop policy if exists "chat_media_anon_read"   on storage.objects;
drop policy if exists "chat_media_anon_insert" on storage.objects;
drop policy if exists "chat_media_anon_update" on storage.objects;
drop policy if exists "chat_media_anon_delete" on storage.objects;

create policy "chat_media_anon_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'chat-media');

create policy "chat_media_anon_insert"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'chat-media');

create policy "chat_media_anon_update"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'chat-media')
  with check (bucket_id = 'chat-media');

create policy "chat_media_anon_delete"
  on storage.objects for delete
  to anon, authenticated
  using (bucket_id = 'chat-media');


-- =====================================================================
-- UPDATE chat-media BUCKET to also allow VIDEO uploads
-- =====================================================================
-- Adds mp4/webm/quicktime/mkv to the MIME whitelist so the new video-camera
-- + video-gallery buttons in chat can send videos up to 50 MB.

update storage.buckets
   set allowed_mime_types = array[
     'image/jpeg','image/png','image/gif','image/webp','image/heic',
     'audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/wav',
     'video/mp4','video/webm','video/quicktime','video/x-matroska','video/x-m4v','video/3gpp'
   ]
 where id = 'chat-media';

-- (No change needed to chat_messages table — the `type` column and
--  `reactions` jsonb column already exist and 'video' is a valid string.)
