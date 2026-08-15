import { useEffect, useRef, useState, useCallback } from "react";
import { getDeviceFingerprint } from "@/lib/fingerprint.ts";
import { attemptPasscode, checkAuthStatus, MAX_ATTEMPTS } from "@/lib/client-auth.ts";
import { haptics } from "@/lib/haptics.ts";

// ─────────────────────────────────────────────────────────────────────────────
//  Minimal, static passcode screen.
//  • No hints, no intro, no transitions, almost zero animation.
//  • Correct code (2407) → onUnlock() opens the chat instantly.
//  • 10 wrong attempts → device is permanently blocked (client-auth.ts).
// ─────────────────────────────────────────────────────────────────────────────

const PASSCODE_LENGTH = 4;

const BG = "radial-gradient(ellipse at 50% -10%, #ffd7e6 0%, #ff9ebf 45%, #ff5c8d 80%, #e8275e 100%)";

const KEYS: (string | "del" | "")[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];

export default function Lockscreen({ onUnlock }: { onUnlock: () => void }) {
  const [digits, setDigits] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const fpRef = useRef<string | null>(null);

  // Compute the device fingerprint + current auth status once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fp = await getDeviceFingerprint();
        if (cancelled) return;
        fpRef.current = fp;
        const status = await checkAuthStatus(fp);
        if (cancelled) return;
        setAttemptsUsed(status.attempts);
        if (status.blocked) setBlocked(true);
      } catch { /* fingerprint unavailable — allow attempts anyway */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = useCallback(async (code: string) => {
    if (blocked) return;
    setBusy(true);
    let fp = fpRef.current;
    if (!fp) {
      try { fp = await getDeviceFingerprint(); fpRef.current = fp; } catch { fp = "unknown-device"; }
    }
    const res = await attemptPasscode(fp, code);
    setBusy(false);
    if (res.success) {
      haptics.success();
      onUnlock();
      return;
    }
    haptics.error();
    setWrong(true);
    setAttemptsUsed(res.attempts);
    setDigits("");
    if (res.blocked) setBlocked(true);
    window.setTimeout(() => setWrong(false), 500);
  }, [blocked, onUnlock]);

  const press = useCallback((d: string) => {
    if (blocked || busy) return;
    haptics.selection();
    setDigits((prev) => {
      if (prev.length >= PASSCODE_LENGTH) return prev;
      const next = prev + d;
      if (next.length === PASSCODE_LENGTH) window.setTimeout(() => submit(next), 70);
      return next;
    });
  }, [blocked, busy, submit]);

  const del = useCallback(() => {
    if (blocked || busy) return;
    setDigits((p) => p.slice(0, -1));
  }, [blocked, busy]);

  // Physical keyboard support (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") press(e.key);
      else if (e.key === "Backspace") del();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, del]);

  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptsUsed);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: BG, padding: 20 }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 340,
          borderRadius: 28,
          padding: "36px 26px 30px",
          background: "rgba(255,255,255,0.32)",
          border: "1px solid rgba(255,255,255,0.5)",
          boxShadow: "0 12px 40px rgba(201,24,74,0.25)",
          textAlign: "center",
        }}
      >
        {blocked ? (
          <div style={{ padding: "20px 4px" }}>
            <div style={{ fontSize: 46, marginBottom: 14 }}>🔒</div>
            <p style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 24, fontWeight: 600, color: "#fff", margin: 0 }}>
              Access Blocked
            </p>
            <p style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 15, color: "rgba(255,255,255,0.85)", marginTop: 10, lineHeight: 1.4 }}>
              Too many incorrect attempts.<br />This device is permanently blocked.
            </p>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🔒</div>
            <p style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, fontWeight: 600, letterSpacing: "0.04em", color: "#fff", margin: "0 0 22px" }}>
              Enter Passcode
            </p>

            {/* dots */}
            <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 26 }}>
              {Array.from({ length: PASSCODE_LENGTH }).map((_, i) => {
                const filled = i < digits.length;
                return (
                  <span
                    key={i}
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      background: wrong ? "#ffe1e1" : filled ? "#fff" : "transparent",
                      border: `2px solid ${wrong ? "#ffb3b3" : "rgba(255,255,255,0.85)"}`,
                      transition: "background 120ms ease",
                    }}
                  />
                );
              })}
            </div>

            {/* keypad */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, justifyItems: "center" }}>
              {KEYS.map((k, idx) => {
                if (k === "") return <span key={idx} />;
                const isDel = k === "del";
                return (
                  <button
                    key={idx}
                    onClick={() => (isDel ? del() : press(k))}
                    disabled={busy}
                    aria-label={isDel ? "Delete" : `Digit ${k}`}
                    style={{
                      width: 68,
                      height: 68,
                      borderRadius: "50%",
                      border: "1px solid rgba(255,255,255,0.45)",
                      background: isDel ? "transparent" : "rgba(255,255,255,0.18)",
                      color: "#fff",
                      fontSize: isDel ? 22 : 26,
                      fontWeight: 500,
                      cursor: "pointer",
                      WebkitTapHighlightColor: "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {isDel ? "⌫" : k}
                  </button>
                );
              })}
            </div>

            {/* warning (only after a wrong attempt) */}
            <p
              style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 14,
                color: "#fff0f3",
                minHeight: 20,
                marginTop: 20,
                opacity: attemptsUsed > 0 ? 1 : 0,
              }}
            >
              {attemptsUsed > 0
                ? `Wrong passcode · ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left`
                : "·"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
