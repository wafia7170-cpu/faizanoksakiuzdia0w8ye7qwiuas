/**
 * Generates a stable device fingerprint from hardware/browser signals.
 * Survives: incognito mode, clearing cookies/localStorage, new tabs.
 * Does NOT survive: different browser or full OS reinstall.
 */
export async function getDeviceFingerprint(): Promise<string> {
  const signals: string[] = [];

  // Screen geometry (stable across incognito)
  signals.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
  signals.push(`${screen.availWidth}x${screen.availHeight}`);

  // Timezone (stable)
  signals.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  signals.push(String(new Date().getTimezoneOffset()));

  // Language & platform (stable)
  signals.push(navigator.language);
  signals.push(navigator.languages?.join(",") ?? "");
  signals.push(navigator.platform ?? "");
  signals.push(String(navigator.hardwareConcurrency ?? 0));
  signals.push(String((navigator as { deviceMemory?: number }).deviceMemory ?? 0));

  // Canvas fingerprint — unique per GPU/driver/browser combination
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.textBaseline = "top";
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = "#f60";
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = "#069";
      ctx.fillText("Fingerprint🎂", 2, 15);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("Fingerprint🎂", 4, 17);
      signals.push(canvas.toDataURL());
    }
  } catch { /* noop */ }

  // WebGL renderer (unique per GPU)
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) {
        signals.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string);
        signals.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string);
      }
    }
  } catch { /* noop */ }

  // Audio fingerprint — unique per audio hardware
  try {
    const audioCtx = new OfflineAudioContext(1, 44100, 44100);
    const oscillator = audioCtx.createOscillator();
    const analyser = audioCtx.createAnalyser();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    oscillator.type = "triangle";
    oscillator.frequency.value = 10000;
    oscillator.connect(analyser);
    analyser.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start(0);
    const buffer = await audioCtx.startRendering();
    const data = buffer.getChannelData(0).slice(4500, 4600);
    signals.push(data.reduce((a, b) => a + Math.abs(b), 0).toFixed(10));
  } catch { /* noop */ }

  // Hash all signals together
  const raw = signals.join("|||");
  const encoded = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
