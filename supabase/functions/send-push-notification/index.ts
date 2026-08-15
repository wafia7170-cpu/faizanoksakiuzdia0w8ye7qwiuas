// ─────────────────────────────────────────────────────────────────────────────
//  Supabase Edge Function: send-push-notification
//
//  Sends a Web Push (VAPID) notification to every device registered for the
//  RECIPIENT persona of a chat message. Reads push_subscriptions with the
//  service-role key (bypasses RLS). Deletes expired endpoints (404/410).
//
//  Accepts EITHER shape:
//   • Client invoke:  { message_id, sender, recipient, text, type, url, exclude_session_id }
//   • DB Webhook:     { type:'INSERT', record:{ id, sender, text, type, session_id, ... } }
//
//  A push failure must never surface to the chat client as a message failure.
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { ApplicationServer, importVapidKeys, Urgency } from "@negrel/webpush";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Lazy, fault-tolerant VAPID init.
// BUG FIX: previously this ran at module load as
//   const vapidKeys = await importVapidKeys(JSON.parse(Deno.env.get("VAPID_KEYS_JSON")!));
// If the secret was missing/empty, Deno.env.get(...) returned undefined and
// JSON.parse(undefined) threw at BOOT with a cryptic
//   SyntaxError: "undefined" is not valid JSON
// crashing EVERY request with a 500. Now we validate + trim the secret and
// surface a clear, actionable error, and only initialise once (memoised).
let appServerPromise: Promise<ApplicationServer> | null = null;
function getAppServer(): Promise<ApplicationServer> {
  if (appServerPromise) return appServerPromise;
  const rawKeys = Deno.env.get("VAPID_KEYS_JSON");
  if (!rawKeys || rawKeys.trim() === "" || rawKeys.trim() === "undefined") {
    throw new Error(
      "Missing VAPID_KEYS_JSON secret. Add it in Supabase \u2192 Edge Functions \u2192 Secrets, then redeploy the function.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys.trim());
  } catch {
    throw new Error("VAPID_KEYS_JSON is set but is not valid JSON.");
  }
  appServerPromise = (async () => {
    const vapidKeys = await importVapidKeys(
      parsed as Parameters<typeof importVapidKeys>[0],
    );
    return await ApplicationServer.new({
      contactInformation:
        Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
      vapidKeys,
    });
  })();
  return appServerPromise;
}

type Persona = "faizan" | "habiba";
const NAMES: Record<Persona, string> = {
  faizan: "Faizan \ud83d\udc97",
  habiba: "Habiba \ud83d\udc97",
};

function other(p: Persona): Persona {
  return p === "faizan" ? "habiba" : "faizan";
}

function buildContent(sender: Persona | undefined, text: unknown, type: unknown) {
  const title = sender && NAMES[sender] ? NAMES[sender] : "New message \ud83d\udc97";
  let body: string;
  const t = typeof text === "string" ? text.trim() : "";
  if (t) body = t.length > 140 ? t.slice(0, 140) + "\u2026" : t;
  else if (type === "image") body = "\ud83d\udcf7 Photo";
  else if (type === "voice") body = "\ud83c\udfa4 Voice message";
  else if (type === "video") body = "\ud83c\udfa5 Video";
  else body = "New message";
  return { title, body };
}

function statusOf(err: unknown): number | undefined {
  const e = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const raw = await req.json().catch(() => ({}));

    // Normalise both invoke + webhook shapes.
    let sender: Persona | undefined;
    let recipient: Persona | undefined;
    let text: unknown;
    let type: unknown;
    let messageId: string | undefined;
    let excludeSession: string | undefined;
    let url = "/";

    if (raw && raw.record && typeof raw.record === "object") {
      const r = raw.record as Record<string, unknown>;
      sender = r.sender as Persona;
      recipient = sender ? other(sender) : undefined;
      text = r.text;
      type = r.type;
      messageId = r.id as string | undefined;
      excludeSession = r.session_id as string | undefined;
    } else {
      sender = raw.sender as Persona | undefined;
      recipient = (raw.recipient as Persona | undefined) ??
        (sender ? other(sender) : undefined);
      text = raw.text;
      type = raw.type;
      messageId = raw.message_id as string | undefined;
      excludeSession = raw.exclude_session_id as string | undefined;
      if (typeof raw.url === "string") url = raw.url;
    }

    if (recipient !== "faizan" && recipient !== "habiba") {
      return json({ error: "Invalid or missing recipient" }, 400);
    }

    // Fail fast on missing/invalid VAPID config with a CLEAR message (this is
    // the fix for the boot-time `JSON.parse("undefined")` crash).
    let appServer: ApplicationServer;
    try {
      appServer = await getAppServer();
    } catch (cfgErr) {
      console.error("[push] config error:", (cfgErr as Error).message);
      return json({ error: (cfgErr as Error).message }, 500);
    }

    // Idempotency: guarantee EXACTLY ONE push per message even when BOTH the
    // instant client trigger and the reliable DB webhook invoke this function.
    // Best-effort: if the push_log table is absent (migration not run yet) we
    // simply continue \u2014 the device notification `tag` still collapses the banner.
    if (messageId) {
      const claim = await admin
        .from("push_log")
        .insert({ message_id: messageId })
        .select("message_id")
        .single();
      if (claim.error) {
        const code = (claim.error as { code?: string }).code;
        if (code === "23505") {
          // unique_violation \u2192 another trigger already handled this message.
          return json({ ok: true, duplicate: true, sent: 0 });
        }
        console.warn("[push] push_log claim skipped:", claim.error.message);
      }
    }

    let query = admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, session_id")
      .eq("persona", recipient);
    if (excludeSession) query = query.neq("session_id", excludeSession);

    const { data: rows, error } = await query;
    if (error) throw error;

    const { title, body } = buildContent(sender, text, type);
    const payload = JSON.stringify({
      title,
      body,
      url,
      tag: messageId || "chat-message",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
    });

    let sent = 0;
    let removed = 0;
    const failed: string[] = [];

    for (const row of rows ?? []) {
      try {
        const subscriber = appServer.subscribe({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        });
        await subscriber.pushTextMessage(payload, {
          urgency: Urgency.High,
          ttl: 86400,
        });
        sent++;
      } catch (err) {
        const s = statusOf(err);
        if (s === 404 || s === 410) {
          await admin.from("push_subscriptions").delete().eq("id", row.id);
          removed++;
        } else {
          console.error("[push] send failed", row.endpoint, err);
          failed.push(row.id);
        }
      }
    }

    return json({ ok: true, recipient, sent, removed, failed: failed.length });
  } catch (err) {
    console.error("[push] fatal", err);
    return json({ error: "Push delivery failed" }, 500);
  }
});
