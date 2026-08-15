-- ─────────────────────────────────────────────────────────────────────────────
--  push_subscriptions — stores one row per browser/device push endpoint.
--
--  Identity model: the app has NO Supabase Auth. Each device is tied to a
--  "persona" ('faizan' | 'habiba') and a per-device session_id (localStorage).
--  A user may have MANY devices/browsers, so persona is NOT unique; endpoint is.
--
--  Security posture (write-only for the browser):
--    • anon may INSERT / UPDATE / DELETE (register + cleanup its endpoint)
--    • anon may NOT SELECT (cannot read anyone's subscriptions)
--    • the send-push-notification Edge Function uses the SERVICE ROLE key,
--      which bypasses RLS, to read subscriptions and deliver pushes.
--  Run this ONCE in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  persona     text not null check (persona in ('faizan', 'habiba')),
  session_id  text not null,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_persona_idx
  on public.push_subscriptions (persona);

alter table public.push_subscriptions enable row level security;

-- Clean re-run
drop policy if exists "anon_insert_push_sub" on public.push_subscriptions;
drop policy if exists "anon_update_push_sub" on public.push_subscriptions;
drop policy if exists "anon_delete_push_sub" on public.push_subscriptions;

create policy "anon_insert_push_sub"
  on public.push_subscriptions
  for insert
  to anon, authenticated
  with check (
    persona in ('faizan', 'habiba')
    and char_length(session_id) between 6 and 200
    and char_length(endpoint) between 10 and 1000
  );

create policy "anon_update_push_sub"
  on public.push_subscriptions
  for update
  to anon, authenticated
  using (true)
  with check (persona in ('faizan', 'habiba'));

create policy "anon_delete_push_sub"
  on public.push_subscriptions
  for delete
  to anon, authenticated
  using (true);

-- No SELECT policy on purpose: browsers cannot read subscriptions.
revoke select on public.push_subscriptions from anon, authenticated;
grant insert, update, delete on public.push_subscriptions to anon, authenticated;
