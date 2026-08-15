-- ─────────────────────────────────────────────────────────────────────────
--  FIX 1: Push subscription save/delete via SECURITY DEFINER RPCs
--         (fixes "permission denied for table push_subscriptions")
--  FIX 2: Enable Realtime on chat_messages (fixes messages not appearing live)
--
--  Run this ONCE in the Supabase SQL editor. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── FIX 1: RPCs so the browser needs only EXECUTE (not table privileges) ────
create or replace function public.save_push_subscription(
  p_persona    text,
  p_session_id text,
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_persona not in ('faizan', 'habiba') then
    raise exception 'invalid persona';
  end if;
  if coalesce(length(p_endpoint), 0) < 10 then
    raise exception 'invalid endpoint';
  end if;

  insert into public.push_subscriptions
    (persona, session_id, endpoint, p256dh, auth, user_agent, updated_at)
  values
    (p_persona, p_session_id, p_endpoint, p_p256dh, p_auth, p_user_agent, now())
  on conflict (endpoint) do update
    set persona    = excluded.persona,
        session_id = excluded.session_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        user_agent = excluded.user_agent,
        updated_at = now();
end;
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint;
end;
$$;

-- The browser (anon) may only EXECUTE these; it still cannot read the table.
revoke all on function public.save_push_subscription(text,text,text,text,text,text) from public;
revoke all on function public.delete_push_subscription(text) from public;
grant execute on function public.save_push_subscription(text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.delete_push_subscription(text) to anon, authenticated;

-- ── FIX 2: Enable Supabase Realtime on the chat table ───────────────────────
-- Full row images so UPDATE/DELETE events carry data (reactions, unsend).
alter table public.chat_messages replica identity full;

-- Add the table to the realtime publication (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    execute 'alter publication supabase_realtime add table public.chat_messages';
  end if;
end
$$;
