// ─────────────────────────────────────────────────────────────────────────────
//  Cross-platform haptics
//
//  Android / Chromium / Firefox on Android → real navigator.vibrate() patterns.
//  iOS Safari 17.4+                        → hidden `<input type="checkbox" switch>`
//                                            trick, which produces a subtle haptic
//                                            tick every time it toggles inside a
//                                            user-gesture. Apple has never shipped
//                                            navigator.vibrate, so this is the only
//                                            way to get real haptic feedback in
//                                            mobile Safari.
//  Everywhere else (desktop, older iOS)    → silent no-op.
//
//  All entry points are safe to call at any time; browsers that require a user
//  gesture will silently ignore pre-gesture calls, and the switch element is
//  only ever "clicked" from inside actual event handlers.
// ─────────────────────────────────────────────────────────────────────────────

/** Preference key — flip to `false` to globally silence haptics without
 *  touching call sites. Written from Homepage settings if we ever add a UI. */
const PREF_KEY = "hb_haptics_enabled";

function isEnabled(): boolean {
  try {
    const v = localStorage.getItem(PREF_KEY);
    // default = enabled
    return v === null ? true : v !== "false";
  } catch { return true; }
}

export function setHapticsEnabled(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? "true" : "false"); } catch { /* noop */ }
}

// ── iOS detection ────────────────────────────────────────────────────────────
const IS_IOS = typeof navigator !== "undefined" &&
  (/iP(hone|od|ad)/.test(navigator.platform) ||
   (/Mac/.test(navigator.platform) && "ontouchend" in document));

const HAS_VIBRATE = typeof navigator !== "undefined" &&
  typeof navigator.vibrate === "function";

// ── iOS "switch" haptic helper ───────────────────────────────────────────────
//   A hidden <label> wrapping <input type="checkbox" switch> is mounted once
//   on first use. Calling `.click()` on the label from inside a user-gesture
//   event triggers a subtle haptic on iOS 17.4+. On older iOS or non-iOS this
//   is a completely invisible no-op (the `switch` attribute is ignored).
let iosSwitchLabel: HTMLLabelElement | null = null;
function ensureIosSwitch(): HTMLLabelElement | null {
  if (typeof document === "undefined") return null;
  if (iosSwitchLabel) return iosSwitchLabel;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "width:1px",
    "height:1px",
    "opacity:0",
    "pointer-events:none",
    "overflow:hidden",
    "clip:rect(0 0 0 0)",
    "z-index:-1",
  ].join(";");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");     // iOS 17.4+ switch control
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  label.appendChild(input);
  document.body.appendChild(label);
  iosSwitchLabel = label;
  return label;
}

function iosTick(): void {
  const label = ensureIosSwitch();
  if (!label) return;
  // Fire on next frame so we don't cause a synchronous layout jump inside
  // the user-gesture handler we were called from.
  try { label.click(); } catch { /* noop */ }
}

// ── Vibration patterns (ms) ──────────────────────────────────────────────────
//   iOS gets one tick per top-level call (it only supports a single haptic),
//   so multi-step patterns collapse to a single tick on iPhone but keep their
//   nuance on Android.
const PATTERNS = {
  selection: 5,                     // extremely soft — used for text-input feels
  light:     10,                    // key tap, menu open
  medium:    20,                    // primary action confirmation
  heavy:     40,                    // strong emphasis
  success:   [15, 40, 25] as const, // rising success bounce
  error:     [55, 80, 55] as const, // stern buzz-buzz
  celebrate: [50, 30, 50, 30, 100] as const, // party
} as const;

function fire(pattern: number | readonly number[]): void {
  if (!isEnabled()) return;
  if (HAS_VIBRATE) {
    try { navigator.vibrate(pattern as number | number[]); } catch { /* noop */ }
    return;
  }
  if (IS_IOS) iosTick();
}

// ── Public API ──────────────────────────────────────────────────────────────
export const haptics = {
  /** Feather-soft — for character-level events (typing, dot-per-digit) */
  selection() { fire(PATTERNS.selection); },
  /** Standard tap — for buttons, cards, non-critical taps */
  light()     { fire(PATTERNS.light); },
  /** Solid tap — primary CTA confirmation */
  medium()    { fire(PATTERNS.medium); },
  /** Heavy — reserved for irreversible / weighty moments */
  heavy()     { fire(PATTERNS.heavy); },
  /** Rising bounce — used on unlock / correct answer / success */
  success()   { fire(PATTERNS.success); },
  /** Stern buzz-buzz — wrong passcode / failed answer */
  error()     { fire(PATTERNS.error); },
  /** Party pattern — reserved for the cake→homepage moment */
  celebrate() { fire(PATTERNS.celebrate); },
  /** Toggle on/off (kept for future settings UI) */
  setEnabled: setHapticsEnabled,
  /** Read current pref */
  enabled(): boolean { return isEnabled(); },
};

export default haptics;
