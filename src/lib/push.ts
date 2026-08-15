// ─────────────────────────────────────────────────────────────────────────────
//  Web Push (VAPID) client library — iOS PWA compatible.
//
//  Responsibilities:
//   • Detect push support + iOS Home-Screen (standalone) requirement.
//   • Register the service worker at '/sw.js' (scope '/').
//   • Request Notification permission (must be called from a user gesture).
//   • Create a PushManager subscription with the VAPID public key.
//   • Store/refresh the subscription in Supabase (write-only table).
//   • Trigger the send-push-notification Edge Function after a message insert.
//
//  Identity model matches the existing chat: a "persona" ('faizan' | 'habiba')
//  in localStorage + a per-device SESSION_ID. The recipient of a message is
//  simply the OTHER persona, so the sender is never notified.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase, isSupabaseConfigured } from "./supabase";
import type { Sender } from "./cloud-chat";

const VAPID_PUBLIC_KEY =
  (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? "";

// Reuse the SAME session id key the chat uses, so the Edge Function can exclude
// the sender's own device when broadcasting.
const SESSION_ID_KEY = "hb_chat_session_id";

export function getSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_ID_KEY);
    if (existing) return existing;
    const fresh =
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_ID_KEY, fresh);
    return fresh;
  } catch {
    return "unknown-session";
  }
}

function other(persona: Sender): Sender {
  return persona === "faizan" ? "habiba" : "faizan";
}

// ── Capability detection ─────────────────────────────────────────────────────
export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window &&
    Boolean(VAPID_PUBLIC_KEY)
  );
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Mac/.test(navigator.platform) && "ontouchend" in document)
  );
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

export function getNotificationPermission():
  | "default"
  | "granted"
  | "denied"
  | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function base64UrlToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return reg;
}

// ── Status ───────────────────────────────────────────────────────────────────
export async function hasActiveSubscription(): Promise<boolean> {
  try {
    if (!isPushSupported()) return false;
    if (Notification.permission !== "granted") return false;
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return Boolean(sub);
  } catch {
    return false;
  }
}

// ── Enable (call from a click handler) ───────────────────────────────────────
export async function enablePush(persona: Sender): Promise<void> {
  if (!isSupabaseConfigured) throw new Error("Chat backend not configured.");
  if (!isPushSupported())
    throw new Error("This browser can\u2019t receive push notifications.");

  if (isIOS() && !isStandalone()) {
    throw new Error(
      "On iPhone: tap the Share icon \u2192 Add to Home Screen, open that icon, then tap \ud83d\udd14 again.",
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked. Enable them in your device settings."
        : "Notification permission was not granted.",
    );
  }

  const reg = await registerServiceWorker();
  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(VAPID_PUBLIC_KEY),
    }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Incomplete push subscription from the browser.");
  }

  // Save via a SECURITY DEFINER RPC so the browser needs only EXECUTE on the
  // function — NOT direct table privileges. This permanently fixes the
  // "permission denied for table push_subscriptions" error and keeps the table
  // unreadable to the client.
  const { error } = await supabase.rpc("save_push_subscription", {
    p_persona: persona,
    p_session_id: getSessionId(),
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  });
  if (error) throw new Error(error.message || "Failed to save subscription.");
}

// Keep the stored persona in sync if the user switches persona while enabled.
export async function syncPersona(persona: Sender): Promise<void> {
  try {
    if (!(await hasActiveSubscription())) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    const json = sub?.toJSON();
    if (!json?.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
    await supabase.rpc("save_push_subscription", {
      p_persona: persona,
      p_session_id: getSessionId(),
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    });
  } catch {
    /* best-effort */
  }
}

// ── Disable ──────────────────────────────────────────────────────────────────
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      if (isSupabaseConfigured) {
        await supabase
          .rpc("delete_push_subscription", { p_endpoint: endpoint })
          .then(() => {}, () => {});
      }
    }
  } catch {
    /* ignore */
  }
}

// ── Trigger a push after a message is inserted (fire-and-forget) ─────────────
// NEVER throws — a push failure must not break message sending.
export async function notifyNewMessage(message: {
  id: string;
  sender: Sender;
  text?: string | null;
  type?: string | null;
}): Promise<void> {
  try {
    if (!isSupabaseConfigured || !VAPID_PUBLIC_KEY) return;
    const recipient = other(message.sender);
    await supabase.functions.invoke("send-push-notification", {
      body: {
        message_id: message.id,
        sender: message.sender,
        recipient,
        text: message.text ?? null,
        type: message.type ?? "text",
        url: "/",
        exclude_session_id: getSessionId(),
      },
    });
  } catch (err) {
    // Swallow — chat must keep working even if push delivery fails.
    console.warn("[push] notifyNewMessage failed (non-fatal)", err);
  }
}
