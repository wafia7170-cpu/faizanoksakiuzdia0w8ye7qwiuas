-- ─────────────────────────────────────────────────────────────────────────
--  RELIABLE DELIVERY: server-side push trigger + idempotency
--
--  Problem solved: the client-side trigger only runs while the sender's app is
--  open. If the sender closes the app the instant after sending, the push may
--  never fire. This Postgres AFTER INSERT trigger calls the Edge Function
--  SERVER-SIDE (via pg_net) for EVERY new chat message, so delivery no longer
--  depends on the sender's browser staying alive.
--
--  We keep BOTH triggers (instant client path + reliable server path). The
--  push_log table + the Edge Function's idempotency claim guarantee EXACTLY
--  ONE notification per message, so there are no duplicates.
--
--  Run this ONCE in the Supabase SQL editor. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) pg_net — Supabase's async HTTP client used to call the Edge Function.
create extension if not exists pg_net;

-- 2) Idempotency ledger. One row per message that has been "claimed" for push.
--    Only the service-role Edge Function touches this (RLS on, no anon policy).
create table if not exists public.push_log (
  message_id text primary key,
  created_at timestamptz not null default now()
);

alter table public.push_log enable row level security;
-- No anon/authenticated policies on purpose → browsers cannot read/write it.
grant all on public.push_log to service_role;
-- (Safety) ensure the Edge Function's service role can read/prune subscriptions.
grant select, delete on public.push_subscriptions to service_role;

-- 3) Trigger function: POST the new row to the Edge Function.
--    • SECURITY DEFINER so it can call net.* no matter which role inserted.
--    • Wrapped in EXCEPTION so a push-infra hiccup can NEVER fail the INSERT
--      (the chat message stays the source of truth).
create or replace function public.notify_push_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform net.http_post(
      url     := 'https://suwdzoycyeihbkhmpxay.supabase.co/functions/v1/send-push-notification',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1d2R6b3ljeWVpaGJraG1weGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NDkzOTMsImV4cCI6MjEwMDEyNTM5M30.uGcrKuyvZbBk87h4-G83AFPPe__0egJSi50xZ2nmLLs',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1d2R6b3ljeWVpaGJraG1weGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NDkzOTMsImV4cCI6MjEwMDEyNTM5M30.uGcrKuyvZbBk87h4-G83AFPPe__0egJSi50xZ2nmLLs'
      ),
      body    := jsonb_build_object(
        'type', 'INSERT',
        'record', row_to_json(NEW)
      )
    );
  exception when others then
    -- Never block the chat insert because of a push problem.
    raise warning 'notify_push_on_message failed: %', sqlerrm;
  end;
  return NEW;
end;
$$;

-- 4) Attach the trigger (drop-if-exists → re-create for clean re-runs).
drop trigger if exists trg_notify_push_on_message on public.chat_messages;
create trigger trg_notify_push_on_message
  after insert on public.chat_messages
  for each row execute function public.notify_push_on_message();
