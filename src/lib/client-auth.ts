// Client-side auth library — 100 % local, no backend calls.
//
// Why no backend?
//   The site is deployed on Netlify as a fully static build. Keeping auth
//   100% local means there is no backend dependency that could sleep or
//   fail and surface as a "connection issue" on the lockscreen.
//
// Trade-offs (accepted by the user):
//   • The passcode strings are in the JS bundle. Anyone who inspects the
//     bundle can find them. This is fine because the site is a personal
//     romantic gift, not a security app.
//   • localStorage-based attempt/block tracking can be reset by clearing
//     site data. The 10-wrong-attempt lockout still deters casual poking.

// ── Secrets (visible in bundle, but that's OK for this app) ──────────────────
const PASSCODE = "2407";
export const MAX_ATTEMPTS = 10;

// ── localStorage keys ────────────────────────────────────────────────────────
// We store the fingerprint the value is TIED to, so switching browsers on the
// same physical device won't accidentally unlock — the fingerprint has to match.
const KEY_ATTEMPTS  = "hb_auth_attempts";   // number of wrong tries (integer)
const KEY_BLOCKED   = "hb_auth_blocked_fp"; // fingerprint that is blocked
const KEY_UNLOCKED  = "hb_auth_unlocked_fp"; // fingerprint that is unlocked

export interface AuthStatus {
  blocked: boolean;
  attempts: number;
  unlocked: boolean;
}

export interface AttemptResult {
  success: boolean;
  blocked: boolean;
  attempts: number;
  unlocked: boolean;
}

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota / private mode */ }
}

function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* noop */ }
}

/**
 * Return the current auth state for a device fingerprint.
 * Always synchronous under the hood, but async in signature to keep the
 * call-site identical to the previous server-based version.
 */
export async function checkAuthStatus(fp: string): Promise<AuthStatus> {
  const blockedFp = safeGet(KEY_BLOCKED);
  const unlockedFp = safeGet(KEY_UNLOCKED);
  const attemptsRaw = safeGet(KEY_ATTEMPTS);
  const attempts = attemptsRaw ? parseInt(attemptsRaw, 10) || 0 : 0;
  return {
    blocked: blockedFp === fp,
    attempts,
    unlocked: unlockedFp === fp,
  };
}

/**
 * Try a passcode. Increments attempt count on wrong, blocks after 10 wrongs.
 * On success, marks the device as permanently unlocked (persists across reloads).
 */
export async function attemptPasscode(fp: string, code: string): Promise<AttemptResult> {
  const status = await checkAuthStatus(fp);
  if (status.blocked) {
    return { success: false, blocked: true, attempts: status.attempts, unlocked: false };
  }

  if (code === PASSCODE) {
    // Reset attempt counter on success and mark this fingerprint as unlocked.
    safeRemove(KEY_ATTEMPTS);
    safeSet(KEY_UNLOCKED, fp);
    return { success: true, blocked: false, attempts: 0, unlocked: true };
  }

  const newAttempts = Math.min(status.attempts + 1, MAX_ATTEMPTS);
  safeSet(KEY_ATTEMPTS, String(newAttempts));
  const blocked = newAttempts >= MAX_ATTEMPTS;
  if (blocked) safeSet(KEY_BLOCKED, fp);
  return { success: false, blocked, attempts: newAttempts, unlocked: false };
}
