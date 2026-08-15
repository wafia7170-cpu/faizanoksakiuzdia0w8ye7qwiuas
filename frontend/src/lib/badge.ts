// ─────────────────────────────────────────────────────────────────────────────
//  App-icon unread badge (Web Badging API).
//
//  • The SERVICE WORKER increments the badge on every push it *shows* (i.e. a
//    message that arrived while the app was backgrounded / closed) and persists
//    the running count in IndexedDB so it survives the worker being killed.
//  • The APP (this module) CLEARS the badge + resets that stored count the
//    moment the user is looking at the app again (window becomes visible /
//    focused). "You've been away → here's how many were waiting; now you're
//    back → cleared."
//
//  navigator.setAppBadge / clearAppBadge is supported on installed PWAs,
//  including iOS/iPadOS 16.4+ Home-Screen apps. Everything is best-effort and
//  never throws.
// ─────────────────────────────────────────────────────────────────────────────

type BadgeNavigator = Navigator & {
  clearAppBadge?: () => Promise<void>;
  setAppBadge?: (count?: number) => Promise<void>;
};

/** Clear the OS app-icon badge and tell the service worker to reset its count. */
export async function resetAppBadge(): Promise<void> {
  try {
    await (navigator as BadgeNavigator).clearAppBadge?.();
  } catch {
    /* unsupported / not installed — ignore */
  }
  try {
    if ("serviceWorker" in navigator) {
      // Prefer the controlling worker; fall back to the ready registration.
      const controller = navigator.serviceWorker.controller;
      if (controller) {
        controller.postMessage({ type: "reset-badge" });
      } else {
        const reg = await navigator.serviceWorker.ready;
        reg.active?.postMessage({ type: "reset-badge" });
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Start auto-clearing the badge whenever the app is in the foreground.
 * Returns a cleanup function. Safe to call in a React effect.
 */
export function initBadgeAutoClear(): () => void {
  const handler = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") void resetAppBadge();
  };

  // Clear immediately if we're already visible on mount.
  handler();

  document.addEventListener("visibilitychange", handler);
  window.addEventListener("focus", handler);

  return () => {
    document.removeEventListener("visibilitychange", handler);
    window.removeEventListener("focus", handler);
  };
}
