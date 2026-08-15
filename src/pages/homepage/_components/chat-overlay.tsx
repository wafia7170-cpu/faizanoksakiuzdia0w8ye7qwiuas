import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  listMessages as cloudListMessages,
  fetchOlderMessages as cloudFetchOlderMessages,
  MESSAGE_PAGE_SIZE,
  takePrefetchedMessages,
  createMessage as cloudCreateMessage,
  createMediaMessage as cloudCreateMediaMessage,
  editMessage as cloudEditMessage,
  deleteMessage as cloudDeleteMessage,
  toggleReaction as cloudToggleReaction,
  uploadChatMedia,
  subscribeToChat as cloudSubscribeToChat,
  broadcastTyping,
  subscribeToTyping,
  type ChatMessage,
  type Sender,
  type ReplySnapshot,
  type ReactionsMap,
} from "@/lib/cloud-chat.ts";
import { haptics } from "@/lib/haptics.ts";
import NotificationBell from "@/components/notification-bell.tsx";

// ─── Persistent session identity ─────────────────────────────────────────────
const SESSION_ID_KEY = "hb_chat_session_id";
const LAST_READ_KEY = "hb_chat_last_read";
const SENDER_KEY = "hb_chat_sender";

function getSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_ID_KEY);
    if (existing) return existing;
    const fresh = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_ID_KEY, fresh);
    return fresh;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}
const SESSION_ID = getSessionId();

// ─── Time helpers ────────────────────────────────────────────────────────────
function fmt12(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function smartTimeLabel(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffH = diffMs / 3_600_000;
  if (diffH < 24) return fmt12(ts);
  if (diffH < 48) return `Yesterday at ${fmt12(ts)}`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  }) + " · " + fmt12(ts);
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Image compression (client-side before upload) ───────────────────────────
async function compressImage(file: File, maxSide = 1920, quality = 0.85): Promise<{ blob: Blob; width: number; height: number } | null> {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = url;
    });
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let w = iw, h = ih;
    if (Math.max(iw, ih) > maxSide) {
      const scale = maxSide / Math.max(iw, ih);
      w = Math.round(iw * scale);
      h = Math.round(ih * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const blob: Blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", quality);
    });
    return { blob, width: w, height: h };
  } catch {
    return null;
  }
}

// ─── Video metadata probe (client-side before upload) ───────────────────────
async function probeVideoMeta(file: File): Promise<{ width: number; height: number; durationMs: number } | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      const done = (result: { width: number; height: number; durationMs: number } | null) => {
        try { URL.revokeObjectURL(url); } catch { /* noop */ }
        resolve(result);
      };
      v.onloadedmetadata = () => {
        const w = v.videoWidth || 0;
        const h = v.videoHeight || 0;
        const d = isFinite(v.duration) ? Math.round(v.duration * 1000) : 0;
        done({ width: w, height: h, durationMs: d });
      };
      v.onerror = () => done(null);
      v.src = url;
    } catch {
      resolve(null);
    }
  });
}

// ─── Video compression (browser-native) ─────────────────────────────────────
// Re-encodes the video via canvas.captureStream() + MediaRecorder, scaling
// the long edge to a max of 1280 and targeting a total file size ≲ 40 MB
// (audio preserved via WebAudio graph). Only runs when the source is large.
// Returns null on failure — caller should fall back to the original file.
async function compressVideo(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ blob: Blob; width: number; height: number; durationMs: number; mime: string } | null> {
  let url = "";
  let audioCtx: AudioContext | null = null;
  let raf = 0;
  try {
    url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.playsInline = true;
    video.preload = "auto";
    video.volume = 0; // no audible playback; audio still flows through WebAudio graph
    video.crossOrigin = "anonymous";

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("metadata failed"));
    });

    const srcW = video.videoWidth || 0;
    const srcH = video.videoHeight || 0;
    const durationSec = isFinite(video.duration) ? video.duration : 0;
    if (srcW < 2 || srcH < 2 || durationSec < 0.05) {
      throw new Error("invalid dimensions or duration");
    }
    const durationMs = Math.round(durationSec * 1000);

    // Scale long edge to at most MAX_SIDE_ACTUAL — 1920 preserves detail
    // for motion clips (raised from 1280 to reduce mid-recording softness).
    const MAX_SIDE_ACTUAL = 1920;

    // Scale long edge to at most MAX_SIDE_ACTUAL, preserving aspect ratio, round to even
    let w = srcW, h = srcH;
    if (Math.max(srcW, srcH) > MAX_SIDE_ACTUAL) {
      const scale = MAX_SIDE_ACTUAL / Math.max(srcW, srcH);
      w = Math.round(srcW * scale);
      h = Math.round(srcH * scale);
    }
    w = w - (w % 2);
    h = h - (h % 2);
    if (w < 2 || h < 2) throw new Error("target dims degenerate");

    // Target size ≈ 45 MB total; carve out 128 kbps for audio.
    // Larger cap on video bitrate (8 Mbps) preserves detail during motion.
    const TARGET_BYTES = 45 * 1024 * 1024;
    const audioBps = 128_000;
    const gross = (TARGET_BYTES * 8) / Math.max(1, durationSec);
    const videoBps = Math.max(1_500_000, Math.min(8_000_000, gross - audioBps));

    // Choose an output MIME the browser can encode
    const mimeCandidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4;codecs=avc1,mp4a",
      "video/mp4",
    ];
    let outMime = "";
    for (const m of mimeCandidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
        outMime = m; break;
      }
    }
    if (!outMime) throw new Error("no supported MediaRecorder mime");

    // Canvas + video track
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    const videoStream = (canvas as HTMLCanvasElement & {
      captureStream: (fps?: number) => MediaStream;
    }).captureStream(30);

    // Extract audio via WebAudio. NOTE: MediaElementSource disconnects the
    // element's default output → user won't hear anything. We only route to
    // a MediaStreamDestination so the recorder picks it up.
    let combinedStream: MediaStream = videoStream;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AC();
      const srcNode = audioCtx.createMediaElementSource(video);
      const destNode = audioCtx.createMediaStreamDestination();
      srcNode.connect(destNode);
      const aTracks = destNode.stream.getAudioTracks();
      if (aTracks.length > 0) {
        combinedStream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...aTracks,
        ]);
      }
    } catch {
      // No audio (or MediaElementSource unavailable) — proceed video-only
    }

    const recorder = new MediaRecorder(combinedStream, {
      mimeType: outMime,
      videoBitsPerSecond: videoBps,
      audioBitsPerSecond: audioBps,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    const drawLoop = () => {
      if (video.paused || video.ended) return;
      ctx.drawImage(video, 0, 0, w, h);
      if (onProgress && durationSec > 0) {
        try { onProgress(Math.min(0.99, video.currentTime / durationSec)); } catch { /* noop */ }
      }
      raf = requestAnimationFrame(drawLoop);
    };

    recorder.start(500);
    await video.play();
    raf = requestAnimationFrame(drawLoop);

    await new Promise<void>((resolve) => {
      const onEnd = () => resolve();
      video.addEventListener("ended", onEnd, { once: true });
    });
    // Cover the last frame
    try { ctx.drawImage(video, 0, 0, w, h); } catch { /* noop */ }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }

    recorder.stop();
    await new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

    const outType = outMime.split(";")[0];
    const blob = new Blob(chunks, { type: outType });
    if (onProgress) { try { onProgress(1); } catch { /* noop */ } }

    // Cleanup audio graph
    try { await audioCtx?.close(); } catch { /* noop */ }
    audioCtx = null;
    try { URL.revokeObjectURL(url); } catch { /* noop */ }

    // If compression somehow made the file bigger, bail
    if (blob.size >= file.size) return null;
    return { blob, width: w, height: h, durationMs, mime: outType };
  } catch (err) {
    console.warn("[chat] compressVideo failed", err);
    if (raf) { try { cancelAnimationFrame(raf); } catch { /* noop */ } }
    if (audioCtx) { try { await audioCtx.close(); } catch { /* noop */ } }
    if (url) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
    return null;
  }
}

// ─── Reply snapshot builder ──────────────────────────────────────────────────
function makeReplySnapshot(msg: ChatMessage): ReplySnapshot {
  return {
    id: msg.id,
    sender: msg.sender,
    type: msg.type,
    text: msg.type === "text" ? (msg.text ?? "").slice(0, 400) : null,
    mediaUrl: msg.mediaUrl ?? null,
    durationMs: msg.durationMs ?? null,
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface ChatOverlayProps {
  open: boolean;
  onClose: () => void;
  onUnreadChange?: (hasUnread: boolean) => void;
}

interface ReplyDraft {
  id: string;
  snapshot: ReplySnapshot;
}

interface ActionMenuState {
  msg: ChatMessage;
  x: number;
  y: number;
}

interface ImageViewerState {
  url: string;
  width?: number | null;
  height?: number | null;
}

interface EditModalState {
  msg: ChatMessage;
  text: string;
}

// ═════════════════════════════════════════════════════════════════════════════

export default function ChatOverlay({
  open,
  onClose,
  onUnreadChange,
}: ChatOverlayProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // True until the first history fetch resolves — drives the loading spinner
  // so we never flash the "Nothing here yet" empty state while loading.
  const [loading, setLoading] = useState(true);
  // Windowed rendering: only mount the most recent `renderLimit` bubbles in the
  // DOM. All messages stay in `messages` (memory) so replies/realtime/search
  // keep working, but we avoid painting ~900 animated bubbles on first open.
  const RENDER_STEP = 150;
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  // Server-backed pagination: whether older messages still exist in the DB
  // beyond what we've loaded into memory, and whether an older-page fetch is
  // in flight. This lets the chat hold UNLIMITED history — we only keep the
  // newest page in memory and page older ones in on scroll-up.
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [input, setInput] = useState("");
  const [sender, setSender] = useState<Sender>(() => {
    try {
      const s = localStorage.getItem(SENDER_KEY);
      return s === "faizan" ? "faizan" : "habiba";
    } catch { return "habiba"; }
  });

  // Dark-mode toggle — scoped ONLY to the chat overlay (persisted in
  // localStorage). Every other page of the app stays in its normal palette.
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem("hb_chat_dark_mode") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("hb_chat_dark_mode", darkMode ? "1" : "0"); } catch { /* noop */ }
  }, [darkMode]);
  const [sending, setSending] = useState(false);
  const [replyDraft, setReplyDraft] = useState<ReplyDraft | null>(null);
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const [imageViewer, setImageViewer] = useState<ImageViewerState | null>(null);
  const [editModal, setEditModal] = useState<EditModalState | null>(null);
  const [confirmUnsend, setConfirmUnsend] = useState<ChatMessage | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [otherTyping, setOtherTyping] = useState<Sender | null>(null);

  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recStartTs, setRecStartTs] = useState<number>(0);
  const [recLevels, setRecLevels] = useState<number[]>([]);
  const [recElapsed, setRecElapsed] = useState(0);

  // Video compression progress (per optimistic message id)
  const [compressingId, setCompressingId] = useState<string | null>(null);
  const [compressingPct, setCompressingPct] = useState(0);

  // Attachment bottom-sheet (Gallery / Camera / Video)
  const [attachOpen, setAttachOpen] = useState(false);

  // In-app video recorder modal
  const [videoRecorderOpen, setVideoRecorderOpen] = useState(false);

  // Keyboard/viewport handling
  const [kbInset, setKbInset] = useState(0);

  // Auto-scroll behavior
  const [atBottom, setAtBottom] = useState(true);
  const [hasNewAway, setHasNewAway] = useState(false);
  // True when the user has scrolled a long way up — drives the floating
  // "jump to newest" button.
  const [farFromBottom, setFarFromBottom] = useState(false);

  // Refs
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Pending scroll-height snapshot used to keep the viewport anchored when we
  // prepend older messages via "Load earlier".
  const preserveScrollRef = useRef<number | null>(null);
  // Guards infinite-scroll so a burst of scroll events can't reveal several
  // batches at once. Cleared once the anchored scroll restore has run.
  const loadingMoreRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const videoCameraInputRef = useRef<HTMLInputElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const openRef = useRef(false);
  const onUnreadChangeRef = useRef(onUnreadChange);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const otherTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRafRef = useRef<number>(0);
  const recStreamRef = useRef<MediaStream | null>(null);
  const swipeStartXRef = useRef<Record<string, number>>({});
  const swipeDxRef = useRef<Record<string, number>>({});
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always-current sender so realtime handlers (registered once) can filter
  // against the latest persona instead of a stale closure value.
  const senderRef = useRef<Sender>("faizan");

  // ── Sync refs
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { onUnreadChangeRef.current = onUnreadChange; }, [onUnreadChange]);
  useEffect(() => {
    senderRef.current = sender;
    try { localStorage.setItem(SENDER_KEY, sender); } catch { /* noop */ }
  }, [sender]);

  // ── Initial load + realtime subscription
  useEffect(() => {
    let alive = true;
    (async () => {
      // Consume the promise the lockscreen already started; fall back to a
      // fresh fetch if there wasn't one (e.g. after re-lock/unlock).
      const pending = takePrefetchedMessages();
      const fresh = await (pending ?? cloudListMessages());
      if (!alive) return;
      if (fresh === null) { setLoading(false); return; }
      setMessages(fresh);
      // If the first page came back full, there is older history in the DB
      // that we'll page in on scroll-up (keyset pagination).
      setHasMoreOlder(fresh.length >= MESSAGE_PAGE_SIZE);
      setLoading(false);
      if (!openRef.current) {
        const lastRead = parseInt(localStorage.getItem(LAST_READ_KEY) ?? "0", 10);
        const hasNew = fresh.some(
          (m) => (m.sessionId ?? "") !== SESSION_ID && m.timestamp > lastRead,
        );
        onUnreadChangeRef.current?.(hasNew);
      }
    })();

    const unsubChat = cloudSubscribeToChat(({ type, message }) => {
      if (!alive) return;
      setMessages((prev) => {
        if (type === "DELETE") {
          // Also blank out any replies pointing to this message so
          // "Original message unavailable" shows properly (snapshot stays
          // but we treat missing-in-list as unavailable).
          return prev.filter((m) => m.id !== message.id);
        }
        const idx = prev.findIndex((m) => m.id === message.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = message;
          return next;
        }
        // Reconcile optimistic (opt-*) by matching sender+text+~time
        const optIdx = prev.findIndex(
          (m) =>
            m.id.startsWith("opt-") &&
            m.sender === message.sender &&
            m.type === message.type &&
            ((m.text ?? "") === (message.text ?? "")) &&
            ((m.mediaUrl ?? "") === (message.mediaUrl ?? "")) &&
            Math.abs(m.timestamp - message.timestamp) < 20000,
        );
        if (optIdx >= 0) {
          const next = prev.slice();
          next[optIdx] = message;
          return next;
        }
        const next = [...prev, message];
        next.sort((a, b) => a.timestamp - b.timestamp);
        return next;
      });

      if (type === "INSERT" && (message.sessionId ?? "") !== SESSION_ID) {
        if (openRef.current) {
          // If user is not at bottom, mark hasNewAway
          if (!atBottomRef.current) setHasNewAway(true);
        } else {
          onUnreadChangeRef.current?.(true);
        }
      }
    });

    const unsubTyping = subscribeToTyping((ev) => {
      if (!alive) return;
      // Suppress typing bubble for whichever persona the viewer currently is —
      // people should never see their own typing status. This works whether
      // the two clients are on different devices OR the same tab has just
      // switched personas (Faizan ↔ Umme Habiba).
      if (ev.sender === senderRef.current) return;
      if (otherTypingTimerRef.current) clearTimeout(otherTypingTimerRef.current);
      if (ev.isTyping) {
        setOtherTyping(ev.sender);
        otherTypingTimerRef.current = setTimeout(() => setOtherTyping(null), 4000);
      } else {
        setOtherTyping(null);
      }
    });

    // ── Realtime fallback: poll + refetch on focus/visibility/online ────────
    // iOS PWAs frequently drop the realtime websocket when backgrounded, which
    // made new messages appear only after a manual refresh. This keeps the chat
    // live (within a few seconds) even if the socket is temporarily down.
    const reconcile = (
      prev: ChatMessage[],
      fresh: ChatMessage[],
    ): ChatMessage[] => {
      if (!fresh.length) return prev;
      const oldestFreshTs = fresh[0].timestamp;
      // Preserve older history already paged in (not part of the latest page).
      const older = prev.filter(
        (m) => m.timestamp < oldestFreshTs && !m.id.startsWith("opt-"),
      );
      // Preserve optimistic messages not yet confirmed by the server.
      const pendingOpt = prev.filter(
        (m) =>
          m.id.startsWith("opt-") &&
          !fresh.some(
            (f) =>
              f.sender === m.sender &&
              f.type === m.type &&
              (f.text ?? "") === (m.text ?? "") &&
              (f.mediaUrl ?? "") === (m.mediaUrl ?? "") &&
              Math.abs(f.timestamp - m.timestamp) < 20000,
          ),
      );
      const merged = [...older, ...fresh, ...pendingOpt];
      merged.sort((a, b) => a.timestamp - b.timestamp);
      return merged;
    };

    const refetch = async () => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.hidden) return;
      const fresh = await cloudListMessages();
      if (!alive || fresh === null) return;
      setMessages((prev) => reconcile(prev, fresh));
    };

    const pollId = window.setInterval(refetch, 5000);
    const onFocus = () => { void refetch(); };
    const onVisible = () => { if (!document.hidden) void refetch(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      unsubChat();
      unsubTyping();
      window.clearInterval(pollId);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Track atBottom via a ref for the realtime handler
  const atBottomRef = useRef(true);
  useEffect(() => { atBottomRef.current = atBottom; }, [atBottom]);

  // ── Mark as read whenever the panel opens
  useEffect(() => {
    if (open) {
      try { localStorage.setItem(LAST_READ_KEY, String(Date.now())); } catch { /* noop */ }
      onUnreadChange?.(false);
    }
  }, [open, onUnreadChange]);

  // ── Auto-scroll to bottom when messages change AND user is at bottom
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Prefer scrollTop set for perfect anchoring under sticky elements
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      // Also fire the ref for good measure
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }, []);

  // Keep the latest renderLimit / message count available to the (stable)
  // scroll listener without re-subscribing on every change.
  const renderLimitRef = useRef(renderLimit);
  useEffect(() => { renderLimitRef.current = renderLimit; }, [renderLimit]);
  const messagesLenRef = useRef(0);
  useEffect(() => { messagesLenRef.current = messages.length; }, [messages.length]);
  // Latest "has older in DB" flag + the oldest loaded timestamp (pagination
  // cursor), mirrored into refs for the stable scroll listener / loadEarlier.
  const hasMoreOlderRef = useRef(false);
  useEffect(() => { hasMoreOlderRef.current = hasMoreOlder; }, [hasMoreOlder]);
  const oldestTsRef = useRef<number | null>(null);
  useEffect(() => {
    oldestTsRef.current = messages.length > 0 ? messages[0].timestamp : null;
  }, [messages]);

  // Reveal / load an older batch of messages. Two cases:
  //   A) There are still messages in memory hidden by the render window →
  //      just widen the window (instant, no network).
  //   B) The window already shows everything in memory but the DB has older
  //      messages → keyset-fetch the next older page and prepend it.
  // In both cases we snapshot scrollHeight so a layout effect can re-anchor
  // the viewport on the same message (no jarring jump) after rows mount.
  const loadEarlier = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const el = messagesContainerRef.current;

    // Case A — reveal more already in memory.
    if (renderLimitRef.current < messagesLenRef.current) {
      loadingMoreRef.current = true;
      preserveScrollRef.current = el ? el.scrollHeight - el.scrollTop : null;
      setRenderLimit((n) => n + RENDER_STEP);
      return;
    }

    // Case B — fetch an older page from Supabase.
    if (!hasMoreOlderRef.current || oldestTsRef.current == null) return;
    loadingMoreRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await cloudFetchOlderMessages(oldestTsRef.current);
      if (res === null) {
        // Network/DB error — release the lock so the user can retry.
        loadingMoreRef.current = false;
        setLoadingOlder(false);
        return;
      }
      setHasMoreOlder(res.hasMore);
      // Snapshot scroll position right before we grow the list.
      preserveScrollRef.current = el ? el.scrollHeight - el.scrollTop : null;
      let prependedCount = 0;
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const older = res.messages.filter((m) => !known.has(m.id));
        prependedCount = older.length;
        return older.length ? [...older, ...prev] : prev;
      });
      setLoadingOlder(false);
      if (prependedCount > 0) {
        // Widen the window to include the newly prepended older rows; the
        // layout effect (keyed on renderLimit) re-anchors scroll + releases
        // the lock.
        setRenderLimit((n) => n + prependedCount);
      } else {
        // Nothing new (all duplicates) → nothing to render, release lock now.
        preserveScrollRef.current = null;
        loadingMoreRef.current = false;
      }
    } catch {
      loadingMoreRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  // Restore scroll position right after older rows are prepended.
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (el && preserveScrollRef.current != null) {
      el.scrollTop = el.scrollHeight - preserveScrollRef.current;
      preserveScrollRef.current = null;
    }
    loadingMoreRef.current = false;
  }, [renderLimit]);

  useEffect(() => {
    if (!open) return;
    if (atBottomRef.current) {
      scrollToBottom("smooth");
      setHasNewAway(false);
    }
  }, [messages, open, scrollToBottom]);

  // On open, jump to the newest message instantly
  useEffect(() => {
    if (open) {
      setTimeout(() => scrollToBottom("auto"), 40);
    }
  }, [open, scrollToBottom]);

  // ── Scroll listener: track bottom proximity + infinite-scroll older msgs
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const threshold = 60;
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      const isAtBottom = distanceFromBottom < threshold;
      setAtBottom(isAtBottom);
      if (isAtBottom) setHasNewAway(false);
      // Show the floating "jump to newest" button once well away from bottom.
      setFarFromBottom(distanceFromBottom > 400);
      // Infinite scroll: as the user nears the top, auto-reveal the next older
      // batch (no button tap needed). Guarded so a scroll burst loads once.
      // Triggers for both in-memory reveal AND server-side older pages.
      if (
        el.scrollTop < 280 &&
        !loadingMoreRef.current &&
        (messagesLenRef.current > renderLimitRef.current ||
          hasMoreOlderRef.current)
      ) {
        void loadEarlier();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [open, loadEarlier]);

  // ── Visual viewport for keyboard handling
  useEffect(() => {
    if (!open) { setKbInset(0); return; }
    const vv = (window as unknown as { visualViewport?: VisualViewport })
      .visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbInset(inset);
      // If we're at the bottom while keyboard shows, keep pinned
      if (atBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom("auto"));
      }
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [open, scrollToBottom]);

  // ── Auto-resize textarea
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const max = 140; // px
    const nh = Math.min(max, ta.scrollHeight);
    ta.style.height = nh + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, []);
  useEffect(() => { autoResize(); }, [input, autoResize]);

  const autoResizeEdit = useCallback(() => {
    const ta = editTextareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(360, ta.scrollHeight) + "px";
  }, []);
  useEffect(() => { autoResizeEdit(); }, [editModal, autoResizeEdit]);

  // ── Typing indicator broadcast (debounced stop)
  const sendTypingSignal = useCallback(() => {
    broadcastTyping(sender, SESSION_ID, true);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      broadcastTyping(sender, SESSION_ID, false);
    }, 2500);
  }, [sender]);

  // ── Send text message
  const sendText = async () => {
    const text = input.trim();
    if (!text || sending) return;
    haptics.light();
    setSending(true);
    const reply = replyDraft
      ? { id: replyDraft.id, snapshot: replyDraft.snapshot }
      : null;
    const optimistic: ChatMessage = {
      id: `opt-${Date.now()}`,
      type: "text",
      text,
      sender,
      timestamp: Date.now(),
      sessionId: SESSION_ID,
      edited: false,
      replyToId: reply?.id ?? null,
      replySnapshot: reply?.snapshot ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput("");
    setReplyDraft(null);
    setAtBottom(true);
    // Stop typing signal immediately
    broadcastTyping(sender, SESSION_ID, false);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);

    const saved = await cloudCreateMessage(text, sender, SESSION_ID, reply);
    setSending(false);
    if (saved) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === saved.id)) {
          return prev.filter((m) => m.id !== optimistic.id);
        }
        return prev.map((m) => (m.id === optimistic.id ? saved : m));
      });
    } else {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setInput(text);
    }
  };

  // ── Send media message (image or video, from gallery/camera)
  const sendMediaFile = async (file: File) => {
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) return;
    haptics.light();

    // Hard sanity cap — no more than 500 MB source (browser can't chew larger)
    if (file.size > 500 * 1024 * 1024) {
      console.warn("[chat] file too big even to compress", file.size);
      return;
    }

    const kind: "image" | "video" = isImage ? "image" : "video";
    const reply = replyDraft
      ? { id: replyDraft.id, snapshot: replyDraft.snapshot }
      : null;
    const optId = `opt-${Date.now()}`;
    // Optimistic placeholder using local object URL
    const localUrl = URL.createObjectURL(file);
    const optimistic: ChatMessage = {
      id: optId,
      type: kind,
      text: null,
      sender,
      timestamp: Date.now(),
      sessionId: SESSION_ID,
      edited: false,
      mediaUrl: localUrl,
      mediaWidth: null,
      mediaHeight: null,
      replyToId: reply?.id ?? null,
      replySnapshot: reply?.snapshot ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);
    setReplyDraft(null);
    setAtBottom(true);

    let uploadBlob: Blob = file;
    let width: number | null = null;
    let height: number | null = null;
    let durationMs: number | null = null;

    if (isImage) {
      const compressed = await compressImage(file);
      if (compressed) {
        uploadBlob = compressed.blob;
        width = compressed.width;
        height = compressed.height;
      }
    } else {
      // Probe metadata
      const meta = await probeVideoMeta(file);
      if (meta) {
        width = meta.width;
        height = meta.height;
        durationMs = meta.durationMs;
      }
      // Only compress if source > 45 MB (near Supabase 50 MB limit) OR
      // long edge > 1920. Under those thresholds, phone camera clips are
      // already well-compressed by the OS and re-encoding just degrades
      // quality (visible as blur/artefacts after a few seconds of motion).
      const longSide = meta ? Math.max(meta.width, meta.height) : 0;
      const needsCompression = file.size > 45 * 1024 * 1024 || longSide > 1920;
      if (needsCompression) {
        setCompressingId(optId);
        setCompressingPct(0);
        const compressed = await compressVideo(file, (pct) => setCompressingPct(pct));
        setCompressingId(null);
        if (compressed) {
          uploadBlob = compressed.blob;
          width = compressed.width;
          height = compressed.height;
          durationMs = compressed.durationMs;
          console.log(
            `[chat] video compressed ${(file.size/1_048_576).toFixed(1)}MB → ${(compressed.blob.size/1_048_576).toFixed(1)}MB`,
          );
        } else {
          // Compression failed — fall back to original if it fits under 50 MB
          if (file.size > 52_428_800) {
            console.warn("[chat] compression failed and file > 50 MB; aborting");
            setMessages((prev) => prev.filter((m) => m.id !== optId));
            try { URL.revokeObjectURL(localUrl); } catch { /* noop */ }
            return;
          }
        }
      }
    }

    // Final size gate (in case compression didn't shrink enough)
    if (uploadBlob.size > 52_428_800) {
      console.warn("[chat] final blob still > 50 MB after compression; aborting", uploadBlob.size);
      setMessages((prev) => prev.filter((m) => m.id !== optId));
      try { URL.revokeObjectURL(localUrl); } catch { /* noop */ }
      return;
    }

    const url = await uploadChatMedia(uploadBlob, kind, sender);
    if (!url) {
      setMessages((prev) => prev.filter((m) => m.id !== optId));
      return;
    }
    const saved = await cloudCreateMediaMessage(kind, url, sender, SESSION_ID, {
      width,
      height,
      durationMs,
      reply,
    });
    if (saved) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === saved.id)) return prev.filter((m) => m.id !== optId);
        return prev.map((m) => (m.id === optId ? saved : m));
      });
    } else {
      setMessages((prev) => prev.filter((m) => m.id !== optId));
    }
    try { URL.revokeObjectURL(localUrl); } catch { /* noop */ }
  };

  const onPickGallery = () => {
    haptics.light();
    setAttachOpen(false);
    // Clear stale value so iOS doesn't refuse a re-click after cancel
    if (galleryInputRef.current) galleryInputRef.current.value = "";
    galleryInputRef.current?.click();
  };
  const onOpenCamera = () => {
    haptics.light();
    setAttachOpen(false);
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    cameraInputRef.current?.click();
  };
  const onOpenVideoCamera = () => {
    haptics.light();
    setAttachOpen(false);
    setVideoRecorderOpen(true);
  };
  // Fallback: if getUserMedia isn't available, still let the user pick an
  // existing video from their gallery via the OS picker.
  const openVideoFileFallback = () => {
    setVideoRecorderOpen(false);
    if (videoCameraInputRef.current) videoCameraInputRef.current.value = "";
    videoCameraInputRef.current?.click();
  };

  const handleGalleryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((f) => { void sendMediaFile(f); });
    e.target.value = ""; // reset for next pick
  };

  // ── Voice recording
  const startRecording = async () => {
    if (recording) return;
    try {
      haptics.medium();
      // Explicit constraints yield cleaner voice capture across browsers:
      // echo/noise processing on, mono (voice needs no stereo), and a stable
      // 48 kHz sample rate. autoGainControl is left ON so quiet speakers are
      // audible; the playback limiter guards against any resulting clipping.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
      });
      recStreamRef.current = stream;
      const mimeCandidates = [
        // Prefer AAC/MP4 first — iOS Safari, Chrome (v116+), and Firefox all
        // decode this natively. Fallback to opus/webm for older Chromium.
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/aac",
        "audio/mpeg",
        "audio/webm;codecs=opus",
        "audio/webm",
      ];
      let mime = "";
      for (const m of mimeCandidates) {
        if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
      }
      const mr = new MediaRecorder(
        stream,
        mime
          ? { mimeType: mime, audioBitsPerSecond: 128000 }
          : { audioBitsPerSecond: 128000 },
      );
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.start(200);
      const startTs = Date.now();
      setRecStartTs(startTs);
      setRecording(true);
      setRecLevels([]);
      setRecElapsed(0);

      // Audio analyzer for waveform
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      audioContextRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        // RMS energy
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const lvl = Math.min(1, rms * 3.5);
        setRecLevels((prev) => {
          const next = prev.length > 40 ? prev.slice(-40).concat(lvl) : prev.concat(lvl);
          return next;
        });
        setRecElapsed(Date.now() - startTs);
        recRafRef.current = requestAnimationFrame(tick);
      };
      recRafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.error("[voice] start failed", err);
      setRecording(false);
    }
  };

  const stopAllRecordingResources = () => {
    if (recRafRef.current) cancelAnimationFrame(recRafRef.current);
    recRafRef.current = 0;
    if (recStreamRef.current) {
      recStreamRef.current.getTracks().forEach((t) => t.stop());
      recStreamRef.current = null;
    }
    if (audioContextRef.current) {
      try { void audioContextRef.current.close(); } catch { /* noop */ }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  };

  const cancelRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") { try { mr.stop(); } catch { /* noop */ } }
    mediaRecorderRef.current = null;
    stopAllRecordingResources();
    audioChunksRef.current = [];
    setRecording(false);
    setRecLevels([]);
    setRecElapsed(0);
  };

  const stopAndSendRecording = async () => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    haptics.light();
    const startTs = recStartTs;
    const finishedChunks: Blob[] = audioChunksRef.current;
    const mime = mr.mimeType || "audio/webm";
    const p = new Promise<Blob>((resolve) => {
      mr.onstop = () => {
        const blob = new Blob(finishedChunks, { type: mime });
        resolve(blob);
      };
    });
    try { mr.stop(); } catch { /* noop */ }
    const blob = await p;
    stopAllRecordingResources();
    mediaRecorderRef.current = null;
    const durationMs = Date.now() - startTs;
    if (durationMs < 400 || blob.size < 500) {
      // too short, discard
      setRecording(false);
      setRecLevels([]);
      setRecElapsed(0);
      return;
    }
    // Optimistic placeholder
    const reply = replyDraft ? { id: replyDraft.id, snapshot: replyDraft.snapshot } : null;
    const optId = `opt-${Date.now()}`;
    const localUrl = URL.createObjectURL(blob);
    const optimistic: ChatMessage = {
      id: optId,
      type: "voice",
      text: null,
      sender,
      timestamp: Date.now(),
      sessionId: SESSION_ID,
      edited: false,
      mediaUrl: localUrl,
      durationMs,
      replyToId: reply?.id ?? null,
      replySnapshot: reply?.snapshot ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);
    setReplyDraft(null);
    setRecording(false);
    setRecLevels([]);
    setRecElapsed(0);
    setAtBottom(true);

    const url = await uploadChatMedia(blob, "voice", sender);
    if (!url) {
      setMessages((prev) => prev.filter((m) => m.id !== optId));
      return;
    }
    const saved = await cloudCreateMediaMessage("voice", url, sender, SESSION_ID, {
      durationMs,
      reply,
    });
    if (saved) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === saved.id)) return prev.filter((m) => m.id !== optId);
        return prev.map((m) => (m.id === optId ? saved : m));
      });
    } else {
      setMessages((prev) => prev.filter((m) => m.id !== optId));
    }
    try { URL.revokeObjectURL(localUrl); } catch { /* noop */ }
  };

  // ── Long-press to open action menu
  const startLongPress = (msg: ChatMessage, ev: React.PointerEvent<HTMLDivElement>) => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    const clientX = ev.clientX;
    const clientY = ev.clientY;
    longPressTimerRef.current = setTimeout(() => {
      haptics.medium();
      setActionMenu({ msg, x: clientX, y: clientY });
    }, 450);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  };

  // ── Swipe-to-reply (touch handlers)
  const onSwipeStart = (msgId: string, x: number) => {
    swipeStartXRef.current[msgId] = x;
    swipeDxRef.current[msgId] = 0;
  };
  const onSwipeMove = (msgId: string, x: number, el: HTMLElement) => {
    const start = swipeStartXRef.current[msgId];
    if (start === undefined) return;
    const dx = Math.max(0, x - start);
    swipeDxRef.current[msgId] = dx;
    const clamped = Math.min(80, dx);
    el.style.transform = `translateX(${clamped}px)`;
  };
  const onSwipeEnd = (msgId: string, el: HTMLElement) => {
    const dx = swipeDxRef.current[msgId] ?? 0;
    el.style.transition = "transform 260ms cubic-bezier(0.22,1,0.36,1)";
    el.style.transform = "translateX(0)";
    setTimeout(() => { el.style.transition = ""; }, 300);
    delete swipeStartXRef.current[msgId];
    delete swipeDxRef.current[msgId];
    if (dx > 55) {
      const msg = messages.find((m) => m.id === msgId);
      if (msg) beginReply(msg);
    }
  };

  // ── Reply / Edit / Unsend actions
  const beginReply = useCallback((msg: ChatMessage) => {
    haptics.light();
    setReplyDraft({ id: msg.id, snapshot: makeReplySnapshot(msg) });
    setActionMenu(null);
    // Focus input after a beat
    setTimeout(() => textareaRef.current?.focus(), 60);
  }, []);

  const beginEdit = useCallback((msg: ChatMessage) => {
    if (msg.type !== "text") return;
    // No session_id gate — either partner can edit any message in this shared chat
    setEditModal({ msg, text: msg.text ?? "" });
    setActionMenu(null);
    setTimeout(() => editTextareaRef.current?.focus(), 60);
  }, []);

  const saveEdit = async () => {
    if (!editModal) return;
    const trimmed = editModal.text.trim();
    if (!trimmed) return;
    const id = editModal.msg.id;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: trimmed, edited: true } : m)));
    setEditModal(null);
    await cloudEditMessage(id, trimmed, SESSION_ID);
  };

  const unsendMessage = async (msg: ChatMessage) => {
    setActionMenu(null);
    // No session_id gate — either partner can unsend any message
    haptics.medium();
    // Optimistic remove
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    const ok = await cloudDeleteMessage(msg.id, SESSION_ID, msg.mediaUrl ?? null);
    if (!ok) {
      // If failed, re-fetch to restore accurate state
      const fresh = await cloudListMessages();
      if (fresh) setMessages(fresh);
    }
  };

  const copyMessage = async (msg: ChatMessage) => {
    setActionMenu(null);
    if (msg.type !== "text" || !msg.text) return;
    try {
      await navigator.clipboard.writeText(msg.text);
      haptics.light();
    } catch { /* noop */ }
  };

  // ── React with emoji (from long-press menu)
  const handleReact = useCallback(async (msg: ChatMessage, emoji: string) => {
    setActionMenu(null);
    haptics.light();
    // Reactions are attributed to the current sender ("faizan" | "habiba") so
    // we can show "Faizan reacted ❤️" / "Habiba reacted ❤️" under the message.
    const me = senderRef.current;
    const current = msg.reactions ?? {};
    const users = new Set<string>(current[emoji] ?? []);
    if (users.has(me)) users.delete(me);
    else users.add(me);
    const nextMap: ReactionsMap = { ...current };
    if (users.size === 0) delete nextMap[emoji];
    else nextMap[emoji] = Array.from(users);
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, reactions: nextMap } : m)));
    // Persist (best-effort — realtime will bring in the authoritative state)
    const saved = await cloudToggleReaction(msg.id, me, emoji);
    if (saved) {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, reactions: saved } : m)));
    }
  }, []);

  // Map each device session id -> the persona that used it most, so OLD
  // reactions (stored as raw session ids before this feature) still resolve
  // to "Faizan"/"Habiba" instead of "Someone".
  const sessionToSender = useMemo(() => {
    const counts: Record<string, { faizan: number; habiba: number }> = {};
    for (const m of messages) {
      const sid = m.sessionId;
      if (!sid) continue;
      if (!counts[sid]) counts[sid] = { faizan: 0, habiba: 0 };
      if (m.sender === "faizan") counts[sid].faizan++;
      else if (m.sender === "habiba") counts[sid].habiba++;
    }
    const map: Record<string, Sender> = {};
    for (const [sid, c] of Object.entries(counts)) {
      map[sid] = c.faizan > c.habiba ? "faizan" : "habiba";
    }
    return map;
  }, [messages]);

  const resolveReactor = useCallback(
    (u: string): string => {
      if (u === "faizan") return "Faizan";
      if (u === "habiba") return "Habiba";
      if (u === SESSION_ID) return senderRef.current === "faizan" ? "Faizan" : "Habiba";
      const s = sessionToSender[u];
      if (s === "faizan") return "Faizan";
      if (s === "habiba") return "Habiba";
      return "Someone";
    },
    [sessionToSender],
  );

  // ── Jump to a message (tap on reply preview)
  const jumpToMessage = useCallback((id: string) => {
    const node = messageRefs.current.get(id);
    if (node && messagesContainerRef.current) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightId(id);
      setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 1600);
    }
  }, []);

  // ── Close handling
  const closeAll = () => {
    setActionMenu(null);
    setImageViewer(null);
    setEditModal(null);
    onClose();
  };

  // ── Voice message playback component (declared here to share sender styling)
  const messageIdSet = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        key="chat-overlay"
        className="fixed inset-0 z-50 flex items-stretch justify-center hb-chat-container"
        data-hb-chat-theme={darkMode ? "dark" : "light"}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] as const }}
        style={{
          background: "#ffd7e6",
        }}
      >
        {/* Dark-mode overrides \u2014 use descendant selectors + !important so
            inline pink defaults are surgically flipped when dark mode is on.
            Only the chat overlay is affected, nothing else on the site. */}
        <style>{`
          /* Smooth theme-switch transitions on all themed elements */
          .hb-chat-sheet,
          .hb-chat-header,
          .hb-chat-messages,
          .hb-chat-bubble-mine,
          .hb-chat-bubble-other,
          .hb-chat-bubble-reply,
          .hb-chat-composer,
          .hb-chat-input,
          .hb-chat-attach-btn,
          .hb-chat-sender-select,
          .hb-chat-sender-label,
          .hb-chat-reply-preview,
          .hb-chat-reply-preview-cancel,
          .hb-chat-typing,
          .hb-chat-empty-heading,
          .hb-chat-empty-sub {
            transition: background 320ms ease, color 320ms ease, border-color 320ms ease, box-shadow 320ms ease;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] {
            background: rgba(0,0,0,0.55) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-sheet {
            background: #0a0a0a !important;
            border: 1px solid rgba(255,255,255,0.06) !important;
            box-shadow: 0 -4px 12px rgba(0,0,0,0.5), 0 -12px 40px rgba(0,0,0,0.4) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-header {
            background: linear-gradient(135deg, #ff4d7a, #c9184a) !important;
            box-shadow: 0 2px 12px rgba(201,24,74,0.35), inset 0 -1px 0 rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.14) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-messages {
            background: transparent !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-messages-viewport {
            background: radial-gradient(ellipse at 50% 0%, #14060b 0%, #0a0407 60%, #050203 100%) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-empty-heading {
            color: #ff8fab !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-empty-sub {
            color: rgba(220,220,220,0.55) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-bubble-other {
            background: linear-gradient(160deg,#2a2a2c 0%,#232326 100%) !important;
            color: #ececec !important;
            border: 1px solid rgba(255,255,255,0.07) !important;
            box-shadow: 0 1px 1px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.28), 0 12px 28px -12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-bubble-mine {
            background: linear-gradient(160deg,#ff5f8a 0%,#e83671 55%,#c9184a 100%) !important;
            color: #fff !important;
            border: 1px solid rgba(255,120,150,0.4) !important;
            box-shadow: 0 1px 1px rgba(0,0,0,0.35), 0 2px 10px rgba(201,24,74,0.35), 0 16px 34px -12px rgba(255,80,130,0.5), inset 0 1px 0 rgba(255,255,255,0.22) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-bubble-other .hb-chat-bubble-reply {
            background: rgba(255,255,255,0.05) !important;
            border-color: rgba(255,255,255,0.09) !important;
            color: #ececec !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-composer {
            background: #0a0a0a !important;
            border-top: 1px solid rgba(255,255,255,0.06) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-input {
            background: #1a1a1a !important;
            color: #f5f5f5 !important;
            border: 1.5px solid rgba(255,255,255,0.08) !important;
            box-shadow: none !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-input::placeholder {
            color: rgba(220,220,220,0.4) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-attach-btn {
            background: #1a1a1a !important;
            color: #ff8fab !important;
            border: 1.5px solid rgba(255,77,122,0.3) !important;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-sender-label {
            color: rgba(220,220,220,0.55) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-sender-select {
            background: #1a1a1a !important;
            color: #f5f5f5 !important;
            border: 1px solid rgba(255,255,255,0.1) !important;
            box-shadow: none !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-typing {
            background: #0a0a0a !important;
            color: rgba(220,220,220,0.6) !important;
            border-top: 1px solid rgba(255,255,255,0.06) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-reply-preview {
            background: rgba(255,255,255,0.04) !important;
            border: 1px solid rgba(255,255,255,0.06) !important;
            box-shadow: none !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-reply-preview-cancel {
            background: rgba(255,255,255,0.08) !important;
            color: #e5e5e5 !important;
            border: 1px solid rgba(255,255,255,0.14) !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-reply-preview .hb-chat-reply-label {
            color: #ff8fab !important;
          }
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-reply-preview .hb-chat-reply-body,
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-reply-preview .hb-chat-reply-body p {
            color: rgba(220,220,220,0.7) !important;
          }
          /* Action menu (long-press) */
          .hb-chat-action-menu[data-hb-chat-theme="dark"] {
            background: #1c1c1c !important;
            border: 1px solid rgba(255,255,255,0.1) !important;
            box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
          }
          .hb-chat-action-menu[data-hb-chat-theme="dark"] .hb-menu-divider {
            border-bottom: 1px solid rgba(255,255,255,0.08) !important;
          }
          .hb-chat-action-menu[data-hb-chat-theme="dark"] button {
            color: #e5e5e5 !important;
          }
          .hb-chat-action-menu[data-hb-chat-theme="dark"] button.hb-menu-danger {
            color: #ff6b9d !important;
          }
          .hb-chat-action-menu[data-hb-chat-theme="dark"] button:hover {
            background: rgba(255,255,255,0.06) !important;
          }
          /* Ensure the whole surface \u2014 including the safe-area padding \u2014
             is dark on iOS/Android so the header pink doesn't peek behind
             the status bar area on darker phones. */
          .hb-chat-container[data-hb-chat-theme="dark"] .hb-chat-empty-heading {
            text-shadow: 0 2px 12px rgba(255,80,130,0.35) !important;
          }
        `}</style>

        {/* Sheet */}
        <motion.div
          initial={{ y: "100%", opacity: 0.85, scale: 0.98 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: "100%", opacity: 0.9, scale: 0.99 }}
          transition={{
            y: { type: "spring", stiffness: 210, damping: 26, mass: 0.85 },
            scale: { duration: 0.55, ease: [0.16, 1, 0.3, 1] as const },
            opacity: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const },
          }}
          className="relative flex flex-col gpu-layer hb-chat-sheet"
          style={{
            // Full-screen fill \u2014 no centered card, no rounded top corners,
            // safely covers the ENTIRE viewport on both iOS and Android.
            width: "100vw",
            height: "100dvh",
            maxWidth: "none",
            background: "rgba(255,255,255,0.98)",
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            boxShadow:
              "0 -4px 12px rgba(201,24,74,0.10), 0 -12px 40px rgba(255,80,130,0.22)",
            border: "1.5px solid rgba(255,150,180,0.35)",
            overflow: "hidden",
          }}
        >
          {/* Header shine sweep */}
          <motion.div
            aria-hidden
            className="absolute pointer-events-none gpu-layer"
            style={{
              top: 0,
              left: "-40%",
              width: "50%",
              height: 70,
              background:
                "linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.55) 50%, transparent 80%)",
              zIndex: 5,
            }}
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: "260%", opacity: [0, 1, 0] }}
            transition={{ duration: 1.4, delay: 0.35, ease: [0.16, 1, 0.3, 1] as const }}
          />

          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-4 relative hb-chat-header"
            style={{
              background: "linear-gradient(135deg, #ff8fab, #ff4d7a, #c9184a)",
              flexShrink: 0,
              paddingTop: `calc(env(safe-area-inset-top, 0px) + 16px)`,
              boxShadow:
                "0 4px 20px rgba(255,80,130,0.28), inset 0 -1px 0 rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.4)",
            }}
          >
            {/* Message push-notification toggle (bell) */}
            <NotificationBell sender={sender} />
            {/* Dark-mode toggle \u2014 chat-only, does NOT affect other pages */}
            <motion.button
              data-testid="chat-dark-toggle"
              onClick={() => { haptics.light(); setDarkMode((d) => !d); }}
              whileHover={{ scale: 1.1, backgroundColor: "rgba(255,255,255,0.4)" }}
              whileTap={{ scale: 0.88 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] as const }}
              className="cursor-pointer rounded-full flex items-center justify-center"
              style={{
                width: 36,
                height: 36,
                background: "rgba(255,255,255,0.28)",
                border: "1px solid rgba(255,255,255,0.4)",
                fontSize: 17,
                lineHeight: 1,
                color: "white",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
                willChange: "transform",
                flexShrink: 0,
                marginRight: 12,
              }}
              aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              title={darkMode ? "Light mode" : "Dark mode"}
            >
              <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
                {darkMode ? "\u2600\ufe0f" : "\ud83c\udf19"}
              </span>
            </motion.button>

            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <p
                  style={{
                    fontFamily: "'Great Vibes', cursive",
                    fontSize: 28,
                    color: "white",
                    lineHeight: 1,
                    textShadow: "0 2px 10px rgba(0,0,0,0.15)",
                  }}
                >
                  Our Chat 💌
                </p>
                <motion.button
                  onClick={closeAll}
                  whileHover={{ scale: 1.1, backgroundColor: "rgba(255,255,255,0.4)" }}
                  whileTap={{ scale: 0.88 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] as const }}
                  className="cursor-pointer rounded-full flex items-center justify-center"
                  style={{
                    width: 30,
                    height: 30,
                    background: "rgba(255,255,255,0.28)",
                    border: "1px solid rgba(255,255,255,0.4)",
                    fontSize: 15,
                    color: "white",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
                    willChange: "transform",
                    flexShrink: 0,
                  }}
                  aria-label="Close chat"
                >
                  ✕
                </motion.button>
              </div>
              <p
                style={{
                  fontFamily: "'Cormorant Garamond', serif",
                  fontSize: 12,
                  color: "rgba(255,255,255,0.86)",
                  letterSpacing: "0.02em",
                  marginTop: 3,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                • end-to-end encrypted • messages stay forever unless you unsend
              </p>
            </div>
          </div>

          {/* Messages viewport — wraps the scrollable list AND the hearts
              wallpaper.  The wallpaper is pinned to THIS wrapper (not the
              inner scroll container) so it always fills the visible viewport
              regardless of scroll position.  Previously the hearts sat
              inside the scroller and got scrolled off-screen along with
              content whenever the chat auto-scrolled to the newest message. */}
          <div
            className="flex-1 relative hb-chat-messages-viewport"
            style={{
              minHeight: 0,
              background:
                "linear-gradient(180deg, #fff2f7 0%, #ffe7f0 50%, #ffdaea 100%)",
            }}
          >
            {/* Hearts wallpaper removed for max performance on low-end devices */}
            <div
              ref={messagesContainerRef}
              className="absolute inset-0 overflow-y-auto px-4 py-5 flex flex-col gap-3 hb-chat-messages"
              style={{
                WebkitOverflowScrolling: "touch",
                overscrollBehavior: "contain",
                background: "transparent",
              }}
            >
            {loading && messages.length === 0 && (
              <div
                className="flex-1 flex flex-col items-center justify-center gap-4"
                data-testid="chat-loading"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: "50%",
                    border: "3px solid rgba(255,140,170,0.35)",
                    borderTopColor: "#e8275e",
                  }}
                />
                <p
                  style={{
                    fontFamily: "'Dancing Script', cursive",
                    fontSize: 21,
                    color: "rgba(122,32,64,0.7)",
                  }}
                >
                  Loading your chat…
                </p>
              </div>
            )}

            {!loading && messages.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <motion.div
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ duration: 0.4 }}
                  style={{ fontSize: 56, textShadow: "0 4px 12px rgba(255,80,130,0.35)" }}
                >
                  💌
                </motion.div>
                <p
                  className="hb-chat-empty-heading"
                  style={{
                    fontFamily: "'Great Vibes', cursive",
                    fontSize: 30,
                    color: "#c9184a",
                    textAlign: "center",
                    lineHeight: 1.1,
                    textShadow: "0 2px 12px rgba(255,80,130,0.15)",
                  }}
                >
                  Nothing here yet
                </p>
                <p
                  className="hb-chat-empty-sub"
                  style={{
                    fontFamily: "'Dancing Script', cursive",
                    fontSize: 19,
                    color: "rgba(122,32,64,0.6)",
                    textAlign: "center",
                    maxWidth: 260,
                    lineHeight: 1.5,
                  }}
                >
                  Say something sweet — it&rsquo;ll show up here 💕
                </p>
              </div>
            )}

            {/* "Load earlier" — reveals the next older batch (from memory, or
                fetched from Supabase for unlimited history). Kept out of the
                DOM until needed so first paint stays fast. */}
            {(messages.length > renderLimit || hasMoreOlder) && (
              <div className="flex justify-center" style={{ padding: "2px 0 8px" }}>
                <button
                  onClick={() => { void loadEarlier(); }}
                  disabled={loadingOlder}
                  data-testid="load-earlier-btn"
                  style={{
                    fontFamily: "'Dancing Script', cursive",
                    fontSize: 16,
                    color: "#c9184a",
                    background: "rgba(255,255,255,0.7)",
                    border: "1px solid rgba(255,150,180,0.5)",
                    borderRadius: 999,
                    padding: "6px 18px",
                    cursor: loadingOlder ? "default" : "pointer",
                    opacity: loadingOlder ? 0.7 : 1,
                    boxShadow: "0 4px 14px -6px rgba(255,80,130,0.4)",
                  }}
                >
                  {loadingOlder ? "Loading…" : "↑ Load earlier messages"}
                </button>
              </div>
            )}

            {messages
              .slice(Math.max(0, messages.length - renderLimit))
              .map((msg, i) => {
                const idx = Math.max(0, messages.length - renderLimit) + i;
                return (
                  <MessageRow
                    key={msg.id}
                    msg={msg}
                    idx={idx}
                    highlighted={highlightId === msg.id}
                    setRef={(el) => {
                      if (el) messageRefs.current.set(msg.id, el);
                      else messageRefs.current.delete(msg.id);
                    }}
                    onLongPressStart={(e) => startLongPress(msg, e)}
                    onLongPressEnd={cancelLongPress}
                    onSwipeStart={(x) => onSwipeStart(msg.id, x)}
                    onSwipeMove={(x, el) => onSwipeMove(msg.id, x, el)}
                    onSwipeEnd={(el) => onSwipeEnd(msg.id, el)}
                    onOpenImage={(url, w, h) => setImageViewer({ url, width: w, height: h })}
                    onJumpToReplied={(id) => {
                      if (messageIdSet.has(id)) jumpToMessage(id);
                    }}
                    repliedExists={(id) => messageIdSet.has(id)}
                    mySender={sender}
                    resolveReactor={resolveReactor}
                    onToggleReaction={(m, emoji) => { void handleReact(m, emoji); }}
                    compressing={compressingId === msg.id}
                    compressPct={compressingId === msg.id ? compressingPct : 0}
                  />
                );
              })}

            <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Typing indicator */}
          {otherTyping && otherTyping !== sender && (
            <div
              className="hb-chat-typing"
              style={{
                padding: "2px 20px 6px",
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 13,
                color: "rgba(122,32,64,0.75)",
                fontStyle: "italic",
                letterSpacing: "0.02em",
                background: "rgba(255,250,252,0.6)",
                borderTop: "1px solid rgba(255,150,180,0.16)",
              }}
            >
              {otherTyping === "faizan" ? "Faizan" : "Umme Habiba"} is typing
              <TypingDots />
            </div>
          )}

          {/* "New message ↓" pill when user is scrolled up */}
          <AnimatePresence>
            {hasNewAway && (
              <motion.button
                key="jump-pill"
                initial={{ opacity: 0, y: 8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.9 }}
                onClick={() => { setHasNewAway(false); scrollToBottom("smooth"); }}
                style={{
                  position: "absolute",
                  bottom: 108 + kbInset,
                  left: "50%",
                  transform: "translateX(-50%)",
                  padding: "6px 14px",
                  background: "linear-gradient(135deg, #ff4d7a, #c9184a)",
                  color: "white",
                  borderRadius: 999,
                  border: "none",
                  fontFamily: "'Cormorant Garamond', serif",
                  fontSize: 13,
                  boxShadow: "0 6px 20px rgba(255,77,122,0.5)",
                  zIndex: 20,
                  cursor: "pointer",
                }}
              >
                New message ↓
              </motion.button>
            )}
          </AnimatePresence>

          {/* Floating "jump to newest" button — appears whenever the user has
              scrolled a long way up into old chats. Hidden while the centered
              "New message" pill is showing (that already offers a jump). */}
          <AnimatePresence>
            {farFromBottom && !hasNewAway && (
              <motion.button
                key="jump-latest-fab"
                initial={{ opacity: 0, y: 10, scale: 0.85 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.85 }}
                transition={{ duration: 0.2 }}
                onClick={() => { setHasNewAway(false); scrollToBottom("smooth"); }}
                aria-label="Jump to latest messages"
                data-testid="jump-latest-btn"
                style={{
                  position: "absolute",
                  bottom: 104 + kbInset,
                  right: 18,
                  width: 44,
                  height: 44,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "linear-gradient(135deg, #ffffff, #fff0f5)",
                  color: "#c9184a",
                  borderRadius: 999,
                  border: "1px solid rgba(255,150,180,0.5)",
                  fontSize: 20,
                  lineHeight: 1,
                  boxShadow: "0 8px 22px -6px rgba(255,80,130,0.55)",
                  zIndex: 20,
                  cursor: "pointer",
                }}
              >
                ↓
              </motion.button>
            )}
          </AnimatePresence>

          {/* Composer */}
          <div
            className="px-4 pb-4 pt-3 flex flex-col gap-2 hb-chat-composer"
            style={{
              borderTop: "1px solid rgba(255,150,180,0.24)",
              flexShrink: 0,
              background: "rgba(255,250,252,0.85)",
              // Keep composer above the on-screen keyboard on iOS/Android
              paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 16px + ${kbInset}px)`,
              transition: "padding-bottom 220ms cubic-bezier(0.22,1,0.36,1)",
            }}
          >
            {/* Reply preview */}
            <AnimatePresence initial={false}>
              {replyDraft && (
                <motion.div
                  key="reply-draft"
                  initial={{ opacity: 0, y: 12, scaleY: 0.85 }}
                  animate={{ opacity: 1, y: 0, scaleY: 1 }}
                  exit={{ opacity: 0, y: 8, scaleY: 0.85 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] as const }}
                  className="hb-chat-reply-preview"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 16,
                    background:
                      "linear-gradient(135deg, rgba(255,244,248,0.95) 0%, rgba(255,225,236,0.75) 100%)",
                    border: "1px solid rgba(255,150,180,0.42)",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.7), 0 4px 14px -6px rgba(255,80,130,0.24)",
                    transformOrigin: "bottom center",
                  }}
                >
                  <div style={{
                    width: 4,
                    alignSelf: "stretch",
                    background: "linear-gradient(180deg, #ff6b9d, #c9184a)",
                    borderRadius: 4,
                    flexShrink: 0,
                    boxShadow: "0 0 8px rgba(255,80,130,0.35)",
                  }} />
                  <div className="hb-chat-reply-body" style={{ flex: 1, minWidth: 0 }}>
                    <p
                      className="hb-chat-reply-label"
                      style={{
                        fontFamily: "'Cormorant Garamond', serif",
                        fontSize: 12,
                        color: "#c9184a",
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        margin: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <span aria-hidden style={{ opacity: 0.75 }}>↩</span>
                      Replying to {replyDraft.snapshot.sender === "faizan" ? "Faizan" : "Umme Habiba"}
                    </p>
                    <ReplyPreviewLine snap={replyDraft.snapshot} muted />
                  </div>
                  <motion.button
                    onClick={() => setReplyDraft(null)}
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.92 }}
                    className="hb-chat-reply-preview-cancel"
                    style={{
                      background: "rgba(255,255,255,0.85)",
                      border: "1px solid rgba(255,150,180,0.42)",
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      fontSize: 14,
                      color: "#7a2040",
                      cursor: "pointer",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 1px 3px rgba(201,24,74,0.12)",
                    }}
                    aria-label="Cancel reply"
                  >
                    ✕
                  </motion.button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Sender toggle */}
            <div className="flex items-center gap-2">
              <span className="hb-chat-sender-label" style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 13, color: "rgba(180,80,120,0.75)", letterSpacing: "0.05em" }}>
                sending as:
              </span>
              <select
                value={sender}
                onChange={(e) => {
                  const next = e.target.value as Sender;
                  // Cancel any pending "typing" broadcast under the OLD
                  // persona so viewers don't keep seeing e.g. "Faizan is
                  // typing…" after Faizan switched to Habiba.
                  if (next !== sender) {
                    broadcastTyping(sender, SESSION_ID, false);
                    if (typingTimerRef.current) {
                      clearTimeout(typingTimerRef.current);
                      typingTimerRef.current = null;
                    }
                  }
                  setSender(next);
                }}
                className="cursor-pointer rounded-full px-3.5 py-1.5 hb-chat-sender-select"
                style={{
                  fontFamily: "'Cormorant Garamond', serif",
                  fontSize: 14,
                  background: "linear-gradient(135deg, rgba(255,220,235,0.5), rgba(255,180,200,0.28))",
                  border: "1px solid rgba(255,150,180,0.4)",
                  color: "#7a2040",
                  outline: "none",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5), 0 2px 8px rgba(255,80,130,0.08)",
                  letterSpacing: "0.02em",
                }}
              >
                <option value="habiba">Umme Habiba → Faizan</option>
                <option value="faizan">Faizan → Umme Habiba</option>
              </select>
            </div>

            {/* Composer row: either recording UI or normal composer */}
            {recording ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: 22,
                  background: "rgba(255,255,255,0.85)",
                  border: "1.5px solid rgba(255,150,180,0.5)",
                  boxShadow: "inset 0 1px 3px rgba(201,24,74,0.06), 0 2px 8px rgba(255,80,130,0.06)",
                }}
              >
                <button
                  onClick={cancelRecording}
                  style={{
                    background: "rgba(255,255,255,0.9)",
                    border: "1px solid rgba(255,150,180,0.4)",
                    borderRadius: 999,
                    width: 34,
                    height: 34,
                    fontSize: 16,
                    color: "#c9184a",
                    cursor: "pointer",
                  }}
                  aria-label="Cancel recording"
                  title="Cancel"
                >
                  🗑
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: "#ff4d7a",
                      boxShadow: "0 0 12px rgba(255,77,122,0.7)",
                      animation: "hb-pulse 1s ease-in-out infinite",
                      flexShrink: 0,
                    }}
                    aria-hidden
                  />
                  <span
                    style={{
                      fontFamily: "'Cormorant Garamond', serif",
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#c9184a",
                      minWidth: 42,
                      flexShrink: 0,
                    }}
                  >
                    {fmtDuration(recElapsed)}
                  </span>
                  <RecordingWaveform levels={recLevels} />
                </div>
                <motion.button
                  onClick={stopAndSendRecording}
                  whileTap={{ scale: 0.88 }}
                  className="cursor-pointer rounded-2xl px-4 py-2.5"
                  style={{
                    background: "linear-gradient(135deg, #ff6b9d, #ff4d7a, #c9184a)",
                    border: "none",
                    color: "white",
                    fontSize: 18,
                    flexShrink: 0,
                    boxShadow: "0 4px 18px rgba(255,77,122,0.4), inset 0 1px 0 rgba(255,255,255,0.3)",
                  }}
                  aria-label="Send voice message"
                >
                  ➤
                </motion.button>
              </div>
            ) : (
              <div className="flex gap-2 items-end">
                {/* Circular "+" attachment trigger — opens bottom sheet */}
                <motion.button
                  data-testid="chat-attach-plus-btn"
                  onClick={() => { haptics.light(); setAttachOpen(true); }}
                  whileHover={{ scale: 1.06 }}
                  whileTap={{ scale: 0.88 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }}
                  aria-label="Add attachment"
                  title="Attach"
                  className="hb-chat-attach-btn"
                  style={{
                    width: 42,
                    height: 42,
                    minHeight: 42,
                    borderRadius: 999,
                    border: "1.5px solid rgba(255,150,180,0.42)",
                    background: "rgba(255,255,255,0.85)",
                    color: "#c9184a",
                    fontSize: 22,
                    lineHeight: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    boxShadow: "0 3px 10px rgba(255,80,130,0.22), inset 0 1px 0 rgba(255,255,255,0.7)",
                    cursor: "pointer",
                    flexShrink: 0,
                    marginBottom: 2,
                    fontWeight: 500,
                    willChange: "transform",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      display: "block",
                      lineHeight: 1,
                      fontSize: 22,
                      transform: "translateY(-1px)",
                      fontFamily: "system-ui, -apple-system, sans-serif",
                    }}
                  >
                    +
                  </span>
                </motion.button>

                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    sendTypingSignal();
                  }}
                  onKeyDown={(e) => {
                    // Enter to send, Shift+Enter for newline
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void sendText();
                    }
                  }}
                  onFocus={() => {
                    // On focus, ensure we scroll to bottom so input stays visible
                    setTimeout(() => scrollToBottom("smooth"), 250);
                  }}
                  placeholder="type something sweet 💕"
                  rows={1}
                  className="flex-1 rounded-2xl px-4 py-3 hb-chat-input"
                  style={{
                    fontFamily: "'Dancing Script', cursive",
                    fontSize: "clamp(17px, 4vw, 20px)",
                    background: "rgba(255,255,255,0.75)",
                    border: "1.5px solid rgba(255,150,180,0.32)",
                    color: "#7a2040",
                    outline: "none",
                    boxShadow: "inset 0 1px 3px rgba(201,24,74,0.06), 0 2px 8px rgba(255,80,130,0.06)",
                    resize: "none",
                    maxHeight: 140,
                    lineHeight: 1.4,
                    minHeight: 46,
                    overflowY: "hidden",
                  }}
                />

                {/* Send OR mic button */}
                {input.trim() ? (
                  <motion.button
                    onClick={sendText}
                    whileHover={{ scale: 1.06, boxShadow: "0 8px 28px rgba(255,77,122,0.55)" }}
                    whileTap={{ scale: 0.88 }}
                    transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] as const }}
                    className="cursor-pointer rounded-2xl px-5"
                    style={{
                      background: "linear-gradient(135deg, #ff6b9d, #ff4d7a, #c9184a)",
                      border: "none",
                      color: "white",
                      fontSize: 20,
                      flexShrink: 0,
                      minHeight: 46,
                      boxShadow: "0 4px 18px rgba(255,77,122,0.4), inset 0 1px 0 rgba(255,255,255,0.3)",
                      willChange: "transform",
                    }}
                    aria-label="Send message"
                  >
                    ➤
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={startRecording}
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.88 }}
                    transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] as const }}
                    className="cursor-pointer rounded-2xl px-5"
                    style={{
                      background: "linear-gradient(135deg, #ff6b9d, #ff4d7a, #c9184a)",
                      border: "none",
                      color: "white",
                      fontSize: 20,
                      flexShrink: 0,
                      minHeight: 46,
                      boxShadow: "0 4px 18px rgba(255,77,122,0.4), inset 0 1px 0 rgba(255,255,255,0.3)",
                      willChange: "transform",
                    }}
                    aria-label="Record voice message"
                    title="Tap to record"
                  >
                    🎙️
                  </motion.button>
                )}
              </div>
            )}
          </div>

          {/* Hidden inputs for gallery + camera + video */}
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleGalleryChange}
            style={{ display: "none" }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleGalleryChange}
            style={{ display: "none" }}
          />
          <input
            ref={videoCameraInputRef}
            type="file"
            accept="video/*"
            capture="environment"
            onChange={handleGalleryChange}
            style={{ display: "none" }}
          />
        </motion.div>

        {/* Attachment bottom sheet — Gallery / Camera / Video */}
        <AnimatePresence>
          {attachOpen && (
            <motion.div
              key="attach-backdrop"
              className="fixed inset-0 z-[65]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
              onClick={() => setAttachOpen(false)}
              style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
            >
              <motion.div
                data-testid="chat-attach-sheet"
                key="attach-sheet"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 34 }}
                onClick={(e) => e.stopPropagation()}
                className="absolute left-0 right-0 bottom-0 rounded-t-3xl"
                style={{
                  background: "linear-gradient(180deg, rgba(255,244,248,0.98), rgba(255,232,240,0.98))",
                  boxShadow: "0 -14px 40px rgba(255,80,130,0.28)",
                  padding: "18px 22px calc(28px + env(safe-area-inset-bottom, 0px))",
                  border: "1px solid rgba(255,150,180,0.4)",
                  borderBottom: "none",
                }}
              >
                {/* Grip */}
                <div style={{ width: 40, height: 4, borderRadius: 999, background: "rgba(201,24,74,0.25)", margin: "0 auto 14px" }} />
                <h4
                  style={{
                    fontFamily: "'Cormorant Garamond', serif",
                    color: "#7a2040",
                    fontSize: 15,
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    textAlign: "center",
                    margin: "0 0 16px 0",
                  }}
                >
                  Attach
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  <AttachTile emoji="🖼️" label="Gallery" testid="attach-gallery" onClick={onPickGallery} />
                  <AttachTile emoji="📷" label="Camera"  testid="attach-camera"  onClick={onOpenCamera} />
                  <AttachTile emoji="🎥" label="Video"   testid="attach-video"   onClick={onOpenVideoCamera} />
                </div>
                <button
                  onClick={() => setAttachOpen(false)}
                  style={{
                    display: "block",
                    margin: "18px auto 0",
                    background: "transparent",
                    border: "none",
                    color: "#c9184a",
                    fontFamily: "'Cormorant Garamond', serif",
                    fontSize: 13,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    opacity: 0.8,
                  }}
                >
                  Cancel
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* In-app video recorder (getUserMedia + MediaRecorder) */}
        <InAppVideoRecorder
          open={videoRecorderOpen}
          onClose={() => setVideoRecorderOpen(false)}
          onCapture={(file) => {
            setVideoRecorderOpen(false);
            void sendMediaFile(file);
          }}
          onUnavailable={openVideoFileFallback}
        />

        {/* Action menu (long-press) */}
        <AnimatePresence>
          {actionMenu && (
            <ActionMenu
              key="action-menu"
              state={actionMenu}
              darkMode={darkMode}
              onReact={(emoji) => { void handleReact(actionMenu.msg, emoji); }}
              onReply={() => beginReply(actionMenu.msg)}
              onEdit={() => beginEdit(actionMenu.msg)}
              onUnsend={() => { const m = actionMenu.msg; setActionMenu(null); setConfirmUnsend(m); }}
              onCopy={() => copyMessage(actionMenu.msg)}
              onClose={() => setActionMenu(null)}
            />
          )}
        </AnimatePresence>

        {/* Unsend confirmation prompt */}
        <AnimatePresence>
          {confirmUnsend && (
            <motion.div
              key="unsend-confirm"
              data-testid="unsend-confirm"
              className="fixed inset-0 z-[70] flex items-center justify-center p-5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ background: "rgba(0,0,0,0.45)" }}
              onClick={() => setConfirmUnsend(null)}
            >
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ scale: 0.92, y: 10 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] as const }}
                style={{
                  width: "100%",
                  maxWidth: 320,
                  borderRadius: 22,
                  padding: "24px 22px 18px",
                  background: darkMode ? "#161016" : "#ffffff",
                  border: darkMode ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,150,180,0.35)",
                  boxShadow: "0 20px 60px rgba(201,24,74,0.35)",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 34, marginBottom: 8 }}>🗑️</div>
                <p style={{
                  fontFamily: "'Cormorant Garamond', serif",
                  fontSize: 20, fontWeight: 600, margin: 0,
                  color: darkMode ? "#ffd7e6" : "#c9184a",
                }}>
                  Unsend this message?
                </p>
                <p style={{
                  fontFamily: "'Cormorant Garamond', serif",
                  fontSize: 14, marginTop: 6, marginBottom: 18,
                  color: darkMode ? "rgba(255,255,255,0.6)" : "#9a6072",
                }}>
                  Are you sure you want to unsend this message? This can't be undone.
                </p>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    data-testid="unsend-confirm-cancel"
                    onClick={() => { haptics.light(); setConfirmUnsend(null); }}
                    style={{
                      flex: 1, height: 44, borderRadius: 14, cursor: "pointer",
                      border: darkMode ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(201,24,74,0.2)",
                      background: darkMode ? "rgba(255,255,255,0.06)" : "rgba(255,240,245,0.9)",
                      color: darkMode ? "#ffd7e6" : "#c9184a",
                      fontFamily: "'Cormorant Garamond', serif", fontSize: 16, fontWeight: 600,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="unsend-confirm-yes"
                    onClick={() => { const m = confirmUnsend; setConfirmUnsend(null); if (m) void unsendMessage(m); }}
                    style={{
                      flex: 1, height: 44, borderRadius: 14, cursor: "pointer", border: "none",
                      background: "linear-gradient(135deg, #ff5f8a, #c9184a)",
                      color: "white",
                      fontFamily: "'Cormorant Garamond', serif", fontSize: 16, fontWeight: 700,
                    }}
                  >
                    Unsend
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Image viewer */}
        <AnimatePresence>
          {imageViewer && (
            <ImageViewer
              key="img-viewer"
              url={imageViewer.url}
              onClose={() => setImageViewer(null)}
            />
          )}
        </AnimatePresence>

        {/* Edit modal */}
        <AnimatePresence>
          {editModal && (
            <motion.div
              key="edit-modal"
              className="fixed inset-0 z-[60] flex items-center justify-center p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)" }}
              onClick={() => setEditModal(null)}
            >
              <motion.div
                initial={{ scale: 0.92, y: 12, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1 }}
                exit={{ scale: 0.94, opacity: 0 }}
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] as const }}
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: "linear-gradient(180deg, #fff, #fff5f8)",
                  borderRadius: 24,
                  width: "100%",
                  maxWidth: 520,
                  border: "1.5px solid rgba(255,150,180,0.45)",
                  boxShadow: "0 24px 80px rgba(255,80,130,0.35)",
                  padding: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <p style={{ fontFamily: "'Great Vibes', cursive", fontSize: 26, color: "#c9184a", lineHeight: 1 }}>
                    Edit message
                  </p>
                  <button
                    onClick={() => setEditModal(null)}
                    style={{
                      background: "rgba(255,240,246,0.9)",
                      border: "1px solid rgba(255,150,180,0.4)",
                      borderRadius: 999,
                      width: 32,
                      height: 32,
                      fontSize: 16,
                      color: "#7a2040",
                      cursor: "pointer",
                    }}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  ref={editTextareaRef}
                  value={editModal.text}
                  onChange={(e) => setEditModal({ ...editModal, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditModal(null);
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveEdit(); }
                  }}
                  style={{
                    fontFamily: "'Dancing Script', cursive",
                    fontSize: 19,
                    lineHeight: 1.55,
                    color: "#7a2040",
                    background: "rgba(255,255,255,0.9)",
                    border: "1.5px solid rgba(255,150,180,0.5)",
                    borderRadius: 16,
                    padding: "12px 14px",
                    minHeight: 140,
                    maxHeight: 360,
                    resize: "none",
                    outline: "none",
                    boxShadow: "inset 0 1px 3px rgba(201,24,74,0.06)",
                    overflowY: "auto",
                    width: "100%",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button
                    onClick={() => setEditModal(null)}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 999,
                      background: "rgba(255,240,246,0.9)",
                      border: "1px solid rgba(255,150,180,0.4)",
                      color: "#7a2040",
                      fontFamily: "'Cormorant Garamond', serif",
                      fontSize: 14,
                      letterSpacing: "0.04em",
                      cursor: "pointer",
                    }}
                  >
                    cancel
                  </button>
                  <button
                    onClick={saveEdit}
                    disabled={!editModal.text.trim()}
                    style={{
                      padding: "8px 20px",
                      borderRadius: 999,
                      background: "linear-gradient(135deg, #ff4d7a, #c9184a)",
                      border: "none",
                      color: "white",
                      fontFamily: "'Cormorant Garamond', serif",
                      fontSize: 14,
                      letterSpacing: "0.04em",
                      cursor: editModal.text.trim() ? "pointer" : "default",
                      opacity: editModal.text.trim() ? 1 : 0.5,
                      boxShadow: "0 4px 18px rgba(255,77,122,0.4)",
                    }}
                  >
                    save
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Sub-components

function TypingDots() {
  return (
    <span style={{ display: "inline-block", marginLeft: 4 }}>
      <span className="hb-typing-dot" style={{ animationDelay: "0ms" }}>.</span>
      <span className="hb-typing-dot" style={{ animationDelay: "150ms" }}>.</span>
      <span className="hb-typing-dot" style={{ animationDelay: "300ms" }}>.</span>
    </span>
  );
}

function AttachTile({
  emoji,
  label,
  onClick,
  testid,
}: {
  emoji: string;
  label: string;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <motion.button
      data-testid={testid}
      onClick={onClick}
      whileHover={{ scale: 1.05, y: -2 }}
      whileTap={{ scale: 0.9 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "18px 6px",
        borderRadius: 22,
        border: "1px solid rgba(255,150,180,0.4)",
        background: "linear-gradient(180deg, rgba(255,255,255,0.9), rgba(255,232,240,0.9))",
        cursor: "pointer",
        boxShadow: "0 3px 12px rgba(255,80,130,0.14), inset 0 1px 0 rgba(255,255,255,0.7)",
        fontFamily: "'Cormorant Garamond', serif",
        willChange: "transform",
      }}
      aria-label={label}
    >
      <span
        style={{
          fontSize: 34,
          lineHeight: 1,
          filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.14))",
        }}
      >
        {emoji}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#7a2040",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
    </motion.button>
  );
}

function RecordingWaveform({ levels }: { levels: number[] }) {
  // Show last 40 bars
  const view = levels.length > 40 ? levels.slice(-40) : levels;
  const bars = view.length > 0 ? view : [0.1];
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 2,
        height: 26,
        overflow: "hidden",
      }}
    >
      {bars.map((v, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: `${Math.max(6, v * 100)}%`,
            background: "linear-gradient(180deg, #ff6b9d, #c9184a)",
            borderRadius: 2,
            flexShrink: 0,
            transition: "height 80ms linear",
          }}
        />
      ))}
    </div>
  );
}

function ReplyPreviewLine({ snap, muted }: { snap: ReplySnapshot; muted?: boolean }) {
  const color = muted ? "rgba(122,32,64,0.75)" : "#7a2040";
  const style: React.CSSProperties = {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 13,
    color,
    letterSpacing: "0.02em",
    lineHeight: 1.3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 2,
  };
  if (snap.type === "image") return <p style={style}>🖼️ Photo</p>;
  if (snap.type === "voice") return <p style={style}>🎙️ Voice message {snap.durationMs ? `· ${fmtDuration(snap.durationMs)}` : ""}</p>;
  return <p style={style}>{snap.text || ""}</p>;
}

const REACTION_EMOJIS = ["❤️", "🥰", "😂", "🔥", "😭", "😘"] as const;
// Curated set used by the "+" popup — grouped so the picker feels like a
// mini emoji keyboard rather than a random dump. Ordered by usefulness for
// chat reactions.
const EXTRA_EMOJI_PICKER: string[] = [
  // Faces & love
  "😀","😁","😆","😅","🤣","😊","😍","😻","🥹","😳","🥺","😢","🤭","😤","😴","🫡","🤍","🥳","😎","🤔",
  // Gestures & hearts
  "👍","👎","👌","🤞","🙌","👏","🙏","💪","💖","💕","💘","💝","💯","✨","⭐","🌟","💫","💥","🎉","🎊",
  // Fun & extras
  "🌸","🌹","🌺","🌷","🌼","🍫","🎂","🎁","🍦","☕","🎀","💌","💐","🕊️","🦋","🐣","🐥","💋","☀️","🌙",
];

function ActionMenu({
  state,
  darkMode,
  onReact,
  onReply,
  onEdit,
  onUnsend,
  onCopy,
  onClose,
}: {
  state: ActionMenuState;
  darkMode: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onUnsend: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  // Position the menu near the tap point but keep on-screen
  const menuW = 260;
  const menuH = 56 /* emoji row */ + 44 * 4 + 12;
  const x = Math.max(12, Math.min(state.x - menuW / 2, window.innerWidth - menuW - 12));
  const y = Math.max(80, Math.min(state.y - menuH - 16, window.innerHeight - menuH - 24));
  // Emoji-keyboard popup — appears above the emoji row when the user taps the
  // "+" chip. Uses a curated set so it feels like a lightweight keyboard.
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <motion.div
      className="fixed inset-0 z-[70]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{ background: "rgba(0,0,0,0.25)", backdropFilter: "blur(4px)" }}
    >
      <motion.div
        className="hb-chat-action-menu"
        data-hb-chat-theme={darkMode ? "dark" : "light"}
        initial={{ opacity: 0, y: 6, scale: 0.92 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.94 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: menuW,
          borderRadius: 22,
          background: "rgba(255,255,255,0.98)",
          border: "1px solid rgba(255,150,180,0.45)",
          boxShadow: "0 12px 40px rgba(255,80,130,0.28), inset 0 1px 0 rgba(255,255,255,0.6)",
          padding: 4,
          overflow: "hidden",
        }}
      >
        {/* Emoji reactions row */}
        <div
          data-testid="reaction-picker"
          className="hb-menu-divider"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-around",
            padding: "8px 6px",
            marginBottom: 4,
            borderBottom: "1px solid rgba(255,150,180,0.28)",
            gap: 2,
            position: "relative",
          }}
        >
          {REACTION_EMOJIS.map((emoji) => (
            <motion.button
              key={emoji}
              data-testid={`reaction-pick-${emoji}`}
              whileHover={{ scale: 1.25 }}
              whileTap={{ scale: 0.85 }}
              transition={{ duration: 0.15 }}
              onClick={() => onReact(emoji)}
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                border: "none",
                background: "transparent",
                fontSize: 22,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </motion.button>
          ))}
          {/* "+" opens the mini emoji keyboard for reactions that aren't in
              the quick-picks strip. */}
          <motion.button
            data-testid="reaction-pick-more"
            whileHover={{ scale: 1.2 }}
            whileTap={{ scale: 0.85 }}
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="More reactions"
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              border: "1px solid rgba(255,150,180,0.55)",
              background: pickerOpen
                ? "linear-gradient(135deg,#ffe3ec,#ffc4d6)"
                : "rgba(255,240,246,0.9)",
              color: "#c9184a",
              fontSize: 18,
              fontWeight: 900,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              boxShadow: pickerOpen
                ? "inset 0 1px 0 rgba(255,255,255,0.6), 0 4px 10px rgba(255,80,130,0.28)"
                : "inset 0 1px 0 rgba(255,255,255,0.6)",
            }}
          >
            {pickerOpen ? "×" : "+"}
          </motion.button>
        </div>

        {/* Emoji keyboard popup — renders INLINE below the reaction row so
            the menu grows naturally. Absolute positioning was clipped by
            the parent's `overflow: hidden`, hence this layout approach. */}
        <AnimatePresence initial={false}>
          {pickerOpen && (
            <motion.div
              data-testid="reaction-emoji-keyboard"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }}
              onClick={(e) => e.stopPropagation()}
              style={{
                overflow: "hidden",
                borderBottom: "1px solid rgba(255,150,180,0.28)",
              }}
            >
              <div
                style={{
                  padding: "8px 6px 10px",
                  display: "grid",
                  gridTemplateColumns: "repeat(8, 1fr)",
                  gap: 2,
                  maxHeight: 168,
                  overflowY: "auto",
                  overscrollBehavior: "contain",
                }}
              >
                {EXTRA_EMOJI_PICKER.map((emoji) => (
                  <button
                    key={emoji}
                    data-testid={`reaction-picker-emoji-${emoji}`}
                    onClick={() => {
                      onReact(emoji);
                      setPickerOpen(false);
                    }}
                    aria-label={`React with ${emoji}`}
                    style={{
                      width: "100%",
                      aspectRatio: "1 / 1",
                      borderRadius: 8,
                      border: "none",
                      background: "transparent",
                      fontSize: 20,
                      cursor: "pointer",
                      lineHeight: 1,
                      padding: 0,
                      transition: "transform 120ms ease, background 120ms ease",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "rgba(255,220,232,0.7)";
                      (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.14)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <MenuItem icon="↩️" label="Reply" onClick={onReply} />
        {state.msg.type === "text" && (
          <MenuItem icon="📋" label="Copy" onClick={onCopy} />
        )}
        {/* Shared journal — either partner can edit any text message
            or unsend any message on both devices. */}
        {state.msg.type === "text" && (
          <MenuItem icon="✏️" label="Edit" onClick={onEdit} />
        )}
        <MenuItem icon="🗑" label="Unsend" onClick={onUnsend} danger />
      </motion.div>
    </motion.div>
  );
}

function MenuItem({
  icon, label, onClick, danger,
}: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={danger ? "hb-menu-danger" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "10px 14px",
        border: "none",
        background: "transparent",
        color: danger ? "#c9184a" : "#7a2040",
        fontFamily: "'Cormorant Garamond', serif",
        fontSize: 15,
        letterSpacing: "0.02em",
        cursor: "pointer",
        borderRadius: 12,
        textAlign: "left",
      }}
      onMouseEnter={(e) => { (e.currentTarget.style.background = "rgba(255,240,246,0.85)"); }}
      onMouseLeave={(e) => { (e.currentTarget.style.background = "transparent"); }}
    >
      <span style={{ fontSize: 17, width: 22, textAlign: "center" }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function ImageViewer({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] as const }}
      onClick={onClose}
      style={{ background: "rgba(0,0,0,0.9)", backdropFilter: "blur(10px)" }}
    >
      <motion.img
        src={url}
        alt=""
        initial={{ scale: 0.94, opacity: 0.6 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.94, opacity: 0.6 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] as const }}
        style={{
          maxWidth: "94%",
          maxHeight: "88%",
          objectFit: "contain",
          borderRadius: 12,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={onClose}
        data-testid="chat-image-close"
        style={{
          position: "absolute",
          top: "max(24px, env(safe-area-inset-top))",
          left: 20,
          width: 40,
          height: 40,
          borderRadius: 999,
          background: "rgba(255,255,255,0.2)",
          border: "1px solid rgba(255,255,255,0.35)",
          color: "white",
          fontSize: 18,
          cursor: "pointer",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          zIndex: 2,
        }}
        aria-label="Close image"
      >
        ✕
      </button>
    </motion.div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Individual message row with long-press, swipe-to-reply, and content rendering
function MessageRow({
  msg,
  idx,
  highlighted,
  setRef,
  onLongPressStart,
  onLongPressEnd,
  onSwipeStart,
  onSwipeMove,
  onSwipeEnd,
  onOpenImage,
  onJumpToReplied,
  repliedExists,
  mySender,
  resolveReactor,
  onToggleReaction,
  compressing = false,
  compressPct = 0,
}: {
  msg: ChatMessage;
  idx: number;
  highlighted: boolean;
  setRef: (el: HTMLDivElement | null) => void;
  onLongPressStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  onLongPressEnd: () => void;
  onSwipeStart: (x: number) => void;
  onSwipeMove: (x: number, el: HTMLElement) => void;
  onSwipeEnd: (el: HTMLElement) => void;
  onOpenImage: (url: string, w?: number | null, h?: number | null) => void;
  onJumpToReplied: (id: string) => void;
  repliedExists: (id: string) => boolean;
  mySender: string;
  resolveReactor: (u: string) => string;
  onToggleReaction: (msg: ChatMessage, emoji: string) => void;
  compressing?: boolean;
  compressPct?: number;
}) {
  const isHabiba = msg.sender === "habiba";
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Touch handlers for swipe-to-reply
  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    onSwipeStart(e.touches[0].clientX);
  };
  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!bubbleRef.current) return;
    onSwipeMove(e.touches[0].clientX, bubbleRef.current);
  };
  const onTouchEnd = () => {
    if (!bubbleRef.current) return;
    onSwipeEnd(bubbleRef.current);
  };

  // ── Double-tap a TEXT message to react with ❤️ (Instagram-style) ──────────
  // Pointer-based so it works on touch AND mouse. We ignore taps that moved
  // (swipe-to-reply) or that were part of a long-press.
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const downPosRef = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    downPosRef.current = { x: e.clientX, y: e.clientY };
    onLongPressStart(e);
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    onLongPressEnd();
    if (msg.type !== "text") { lastTapRef.current = null; return; }
    const down = downPosRef.current;
    const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
    if (moved > 12) { lastTapRef.current = null; return; } // a swipe/drag, not a tap
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
      lastTapRef.current = null;
      onToggleReaction(msg, "❤️");
    } else {
      lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
    }
  };

  return (
    <motion.div
      ref={setRef}
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        boxShadow: highlighted
          ? "0 0 0 3px rgba(255,105,135,0.6), 0 10px 30px rgba(255,80,130,0.35)"
          : "none",
      }}
      transition={{ duration: 0.42, delay: Math.min(idx, 6) * 0.028, ease: [0.22, 1, 0.36, 1] as const }}
      className={`flex ${isHabiba ? "justify-start" : "justify-end"} gpu-layer`}
      style={{ borderRadius: 22, transition: "box-shadow 260ms ease" }}
    >
      <div
        ref={bubbleRef}
        className={isHabiba ? "hb-chat-bubble-other" : "hb-chat-bubble-mine"}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={onLongPressEnd}
        onPointerCancel={onLongPressEnd}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          maxWidth: "80%",
          padding: msg.type === "image" ? 4 : "11px 15px 9px",
          borderRadius: isHabiba ? "8px 24px 24px 24px" : "24px 8px 24px 24px",
          background: isHabiba
            ? "linear-gradient(160deg, #ffffff 0%, #fff4f7 45%, #ffe1ec 100%)"
            : "linear-gradient(160deg, #ff90b3 0%, #ff5f8a 55%, #d8285d 100%)",
          color: isHabiba ? "#7a2040" : "white",
          boxShadow: isHabiba
            ? "0 1px 1px rgba(201,24,74,0.04), 0 2px 6px rgba(201,24,74,0.06), 0 10px 24px -8px rgba(255,100,140,0.18), inset 0 1px 0 rgba(255,255,255,0.85)"
            : "0 1px 1px rgba(201,24,74,0.14), 0 2px 8px rgba(201,24,74,0.18), 0 14px 32px -10px rgba(255,80,130,0.42), inset 0 1px 0 rgba(255,255,255,0.32)",
          border: isHabiba
            ? "1px solid rgba(255,180,200,0.35)"
            : "1px solid rgba(255,255,255,0.22)",
          position: "relative",
          touchAction: "pan-y",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {/* Reply preview inside bubble */}
        {msg.replySnapshot && (
          <button
            onClick={() => {
              if (msg.replyToId && repliedExists(msg.replyToId)) {
                onJumpToReplied(msg.replyToId);
              }
            }}
            className="hb-chat-bubble-reply"
            style={{
              display: "flex",
              alignItems: "stretch",
              gap: 8,
              width: "100%",
              textAlign: "left",
              padding: "6px 10px 6px 8px",
              margin: msg.type === "image" ? "4px 4px 6px 4px" : "0 0 8px 0",
              borderRadius: 12,
              background: isHabiba
                ? "rgba(255,255,255,0.78)"
                : "rgba(255,255,255,0.16)",
              border: isHabiba
                ? "1px solid rgba(255,150,180,0.32)"
                : "1px solid rgba(255,255,255,0.24)",
              boxShadow: isHabiba
                ? "inset 0 1px 0 rgba(255,255,255,0.6)"
                : "inset 0 1px 0 rgba(255,255,255,0.14)",
              cursor: msg.replyToId && repliedExists(msg.replyToId) ? "pointer" : "default",
              color: isHabiba ? "#7a2040" : "white",
              backdropFilter: "blur(4px)",
              WebkitBackdropFilter: "blur(4px)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 3,
                borderRadius: 3,
                flexShrink: 0,
                background: isHabiba
                  ? "linear-gradient(180deg,#ff6b9d,#c9184a)"
                  : "linear-gradient(180deg,#ffe0ec,#ffd0e0)",
                opacity: isHabiba ? 0.9 : 0.95,
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 11,
                opacity: isHabiba ? 0.85 : 0.95,
                letterSpacing: "0.04em",
                margin: 0,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}>
                <span aria-hidden style={{ opacity: 0.75 }}>↩</span>
                {msg.replySnapshot.sender === "faizan" ? "Faizan" : "Umme Habiba"}
              </p>
              {msg.replyToId && !repliedExists(msg.replyToId) ? (
                <p style={{
                  fontFamily: "'Cormorant Garamond', serif",
                  fontSize: 13,
                  opacity: 0.7,
                  fontStyle: "italic",
                  margin: 0,
                }}>
                  Original message unavailable
                </p>
              ) : (
                <ReplyPreviewInBubble snap={msg.replySnapshot} inverse={!isHabiba} />
              )}
            </div>
          </button>
        )}

        {/* Body */}
        {msg.type === "text" && (
          <p
            style={{
              fontFamily: "'Dancing Script', cursive",
              fontSize: "clamp(17px, 4.2vw, 21px)",
              lineHeight: 1.55,
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
              margin: 0,
            }}
          >
            {msg.text}
          </p>
        )}

        {msg.type === "image" && msg.mediaUrl && (
          <div
            onClick={() => onOpenImage(msg.mediaUrl!, msg.mediaWidth, msg.mediaHeight)}
            style={{ cursor: "zoom-in", borderRadius: 18, overflow: "hidden", position: "relative" }}
          >
            <img
              src={msg.mediaUrl}
              alt=""
              loading="lazy"
              style={{
                display: "block",
                maxWidth: 260,
                maxHeight: 340,
                width: "auto",
                height: "auto",
                borderRadius: 18,
                objectFit: "cover",
              }}
            />
          </div>
        )}

        {msg.type === "video" && msg.mediaUrl && (
          <VideoBubble
            url={msg.mediaUrl}
            width={msg.mediaWidth ?? null}
            height={msg.mediaHeight ?? null}
            durationMs={msg.durationMs ?? null}
            inverse={!isHabiba}
            compressing={compressing}
            compressPct={compressPct}
          />
        )}

        {msg.type === "voice" && msg.mediaUrl && (
          <VoicePlayer url={msg.mediaUrl} durationMs={msg.durationMs ?? 0} inverse={!isHabiba} />
        )}

        {/* Meta */}
        <div
          className="flex items-center gap-1.5 mt-1"
          style={{
            justifyContent: isHabiba ? "flex-start" : "flex-end",
            padding: (msg.type === "image" || msg.type === "video") ? "0 8px 6px 8px" : undefined,
          }}
        >
          <p
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 11,
              opacity: isHabiba ? 0.6 : 0.82,
              letterSpacing: "0.04em",
              margin: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "inherit",
            }}
          >
            <span style={{ fontWeight: 600, opacity: 0.9 }}>
              {isHabiba ? "Umme Habiba" : "Faizan"}
            </span>
            <span aria-hidden style={{ opacity: 0.45 }}>·</span>
            <span>{smartTimeLabel(msg.timestamp)}</span>
            {msg.edited ? (
              <>
                <span aria-hidden style={{ opacity: 0.45 }}>·</span>
                <span style={{ fontStyle: "italic", opacity: 0.85 }}>edited</span>
              </>
            ) : null}
          </p>
        </div>

        {/* Reaction chips */}
        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
          <ReactionChips
            reactions={msg.reactions}
            mySender={mySender}
            resolveReactor={resolveReactor}
            onToggle={(emoji) => onToggleReaction(msg, emoji)}
            inverse={!isHabiba}
          />
        )}
      </div>
    </motion.div>
  );
}

function ReplyPreviewInBubble({ snap, inverse }: { snap: ReplySnapshot; inverse?: boolean }) {
  const style: React.CSSProperties = {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 13,
    lineHeight: 1.3,
    margin: 0,
    marginTop: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: inverse ? "rgba(255,255,255,0.9)" : "#7a2040",
  };
  if (snap.type === "image") return <p style={style}>🖼️ Photo</p>;
  if (snap.type === "video") return <p style={style}>🎬 Video {snap.durationMs ? `· ${fmtDuration(snap.durationMs)}` : ""}</p>;
  if (snap.type === "voice") return <p style={style}>🎙️ Voice message {snap.durationMs ? `· ${fmtDuration(snap.durationMs)}` : ""}</p>;
  return <p style={style}>{snap.text || ""}</p>;
}

function VoicePlayer({ url, durationMs, inverse }: { url: string; durationMs: number; inverse?: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [totalMs, setTotalMs] = useState(durationMs);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // We use the Web Audio API exclusively for playback. Native <audio> was
  // unreliable across browsers: iOS Safari silently "played" webm/opus files
  // (currentTime advanced but no sound emitted) and various Chromium builds
  // choked on codec suffixes served from CDNs. `decodeAudioData` guarantees
  // PCM buffers routed straight to ctx.destination, so audio always plays.
  const ctxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<AudioBuffer | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const startTsRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);
  const rafRef = useRef<number>(0);
  const decodePromiseRef = useRef<Promise<boolean> | null>(null);

  // Cleanup on URL change / unmount
  useEffect(() => {
    // Reset local state when URL changes
    bufRef.current = null;
    offsetRef.current = 0;
    setCurrentMs(0);
    setPlaying(false);
    setFailed(false);
    decodePromiseRef.current = null;

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try { srcRef.current?.stop(); } catch { /* noop */ }
      srcRef.current = null;
      bufRef.current = null;
      if (ctxRef.current) {
        try { void ctxRef.current.close(); } catch { /* noop */ }
      }
      ctxRef.current = null;
    };
  }, [url]);

  // Ensure AudioContext + decoded buffer are ready. Idempotent — safe to call
  // repeatedly; the underlying fetch+decode only happens once per URL.
  const ensureBuffer = (): Promise<boolean> => {
    if (bufRef.current && ctxRef.current) return Promise.resolve(true);
    if (decodePromiseRef.current) return decodePromiseRef.current;

    const run = (async (): Promise<boolean> => {
      setLoading(true);
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) throw new Error("Web Audio API not supported");
        const ctx = ctxRef.current ?? new AC();
        ctxRef.current = ctx;
        if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* noop */ } }
        const res = await fetch(url, { mode: "cors", cache: "force-cache" });
        if (!res.ok) throw new Error(`fetch failed ${res.status}`);
        const arr = await res.arrayBuffer();
        // decodeAudioData mutates its input on some old Safari, so slice.
        const buf = await new Promise<AudioBuffer>((resolve, reject) => {
          try {
            const p = ctx.decodeAudioData(arr.slice(0), resolve, reject);
            // Chromium returns a promise; iOS Safari <14.5 uses callbacks.
            if (p && typeof (p as Promise<AudioBuffer>).then === "function") {
              (p as Promise<AudioBuffer>).then(resolve, reject);
            }
          } catch (e) {
            reject(e);
          }
        });
        bufRef.current = buf;
        if (isFinite(buf.duration) && buf.duration > 0) {
          setTotalMs(Math.round(buf.duration * 1000));
        }
        setLoading(false);
        setFailed(false);
        return true;
      } catch (err) {
        console.error("[voice] decode failed", err);
        setLoading(false);
        setFailed(true);
        return false;
      }
    })();

    decodePromiseRef.current = run;
    return run;
  };

  const startPlayback = () => {
    const ctx = ctxRef.current;
    const buf = bufRef.current;
    if (!ctx || !buf) return;
    if (ctx.state === "suspended") { void ctx.resume(); }
    // Stop any previous source
    try { srcRef.current?.stop(); } catch { /* noop */ }
    srcRef.current = null;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    // Modest boost for quiet mobile-mic captures. Previously this was 1.35,
    // which — combined with the browser's default auto-gain during recording
    // (levels already near full scale) — pushed samples past 0 dBFS and caused
    // hard CLIPPING at the destination. That clipping is exactly the harsh,
    // garbled "unclear" sound users heard. We now use a gentler 1.12 boost and
    // route it through a brick-wall limiter so the signal can NEVER clip.
    gain.gain.value = 1.12;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5; // begin limiting just below full scale
    limiter.knee.value = 0;         // hard knee → true peak limiter
    limiter.ratio.value = 20;       // heavy ratio → brick-wall
    limiter.attack.value = 0.003;   // catch transients fast
    limiter.release.value = 0.25;
    src.connect(gain).connect(limiter).connect(ctx.destination);

    // Clamp resume offset to buffer bounds.
    const startOffset = Math.max(0, Math.min(buf.duration - 0.01, offsetRef.current));
    src.start(0, startOffset);
    startTsRef.current = ctx.currentTime - startOffset;
    srcRef.current = src;
    gainRef.current = gain;
    setPlaying(true);

    src.onended = () => {
      if (srcRef.current !== src) return; // manual stop path
      offsetRef.current = 0;
      setCurrentMs(0);
      setPlaying(false);
      srcRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };

    const tick = () => {
      const c = ctxRef.current;
      const b = bufRef.current;
      if (!c || !b || srcRef.current !== src) return;
      const cur = Math.min(b.duration, c.currentTime - startTsRef.current);
      setCurrentMs(Math.round(cur * 1000));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const pausePlayback = () => {
    const ctx = ctxRef.current;
    const src = srcRef.current;
    if (!ctx || !src) return;
    const cur = Math.min(bufRef.current?.duration ?? 0, ctx.currentTime - startTsRef.current);
    offsetRef.current = cur;
    try { src.stop(); } catch { /* noop */ }
    srcRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPlaying(false);
  };

  const toggle = async () => {
    if (playing) {
      pausePlayback();
      return;
    }
    const ready = bufRef.current ? true : await ensureBuffer();
    if (!ready) return;
    startPlayback();
  };

  const seek = async (pct: number) => {
    // Load lazily on first seek too so users can scrub before pressing play.
    if (!bufRef.current) {
      const ok = await ensureBuffer();
      if (!ok) return;
    }
    const buf = bufRef.current;
    if (!buf) return;
    const target = Math.max(0, Math.min(buf.duration, (pct / 100) * buf.duration));
    offsetRef.current = target;
    setCurrentMs(Math.round(target * 1000));
    if (playing) {
      // Restart from new offset (BufferSource can't seek in place).
      try { srcRef.current?.stop(); } catch { /* noop */ }
      srcRef.current = null;
      startPlayback();
    }
  };

  const total = totalMs || durationMs || 1;
  const progress = Math.min(100, (currentMs / Math.max(1, total)) * 100);
  const accent = inverse ? "rgba(255,255,255,0.95)" : "#c9184a";
  const track = inverse ? "rgba(255,255,255,0.35)" : "rgba(255,150,180,0.35)";
  const btnBg = inverse ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.7)";

  // Fake pre-baked waveform bars (24 bars for compact look)
  const bars = 24;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 200 }}>
      <button
        onClick={() => { void toggle(); }}
        aria-label={playing ? "Pause" : loading ? "Loading" : failed ? "Playback failed" : "Play"}
        data-testid="voice-play-btn"
        style={{
          width: 36,
          height: 36,
          borderRadius: 999,
          border: inverse ? "1px solid rgba(255,255,255,0.4)" : "1px solid rgba(255,150,180,0.5)",
          background: btnBg,
          color: accent,
          fontSize: 14,
          cursor: "pointer",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {loading ? "⋯" : failed ? "⚠" : playing ? "⏸" : "▶"}
      </button>
      <div
        style={{ flex: 1, height: 22, display: "flex", alignItems: "center", gap: 2, cursor: "pointer" }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = ((e.clientX - rect.left) / rect.width) * 100;
          void seek(pct);
        }}
      >
        {Array.from({ length: bars }).map((_, i) => {
          const barPct = ((i + 0.5) / bars) * 100;
          const active = barPct <= progress;
          const h = 6 + (Math.sin((i * 12) + 3) + 1) * 6;
          return (
            <span
              key={i}
              style={{
                width: 2.5,
                height: h,
                background: active ? accent : track,
                borderRadius: 2,
                transition: "background 120ms linear",
              }}
            />
          );
        })}
      </div>
      <span
        style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 12,
          fontWeight: 600,
          color: accent,
          minWidth: 40,
          textAlign: "right",
          flexShrink: 0,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtDuration(playing || currentMs > 0 ? currentMs : total)}
      </span>
    </div>
  );
}


// ─── Reaction chips (rendered below the message bubble) ─────────────────────
function ReactionChips({
  reactions,
  mySender,
  onToggle,
  inverse,
  resolveReactor,
}: {
  reactions: ReactionsMap;
  mySender: string;
  onToggle: (emoji: string) => void;
  inverse?: boolean;
  resolveReactor: (u: string) => string;
}) {
  const entries = Object.entries(reactions).filter(([, users]) => users && users.length > 0);
  if (entries.length === 0) return null;

  const formatNames = (users: string[]) => {
    const names = Array.from(new Set(users.map(resolveReactor)));
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        marginTop: 6,
        alignItems: inverse ? "flex-end" : "flex-start",
      }}
    >
      <div
        data-testid="reaction-chips"
        style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: inverse ? "flex-end" : "flex-start" }}
      >
        {entries.map(([emoji, users]) => {
          const mine = users.includes(mySender);
          return (
            <motion.button
              key={emoji}
              data-testid={`reaction-chip-${emoji}`}
              onClick={(e) => { e.stopPropagation(); onToggle(emoji); }}
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.9 }}
              transition={{ duration: 0.14 }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                padding: "2px 8px",
                borderRadius: 999,
                background: mine
                  ? (inverse ? "rgba(255,255,255,0.95)" : "linear-gradient(135deg,#ff8fab,#ff4d7a)")
                  : (inverse ? "rgba(255,255,255,0.22)" : "rgba(255,240,246,0.95)"),
                color: mine
                  ? (inverse ? "#c9184a" : "white")
                  : (inverse ? "white" : "#7a2040"),
                border: mine
                  ? (inverse ? "1px solid rgba(255,255,255,0.9)" : "1px solid rgba(255,77,122,0.5)")
                  : (inverse ? "1px solid rgba(255,255,255,0.35)" : "1px solid rgba(255,150,180,0.45)"),
                fontSize: 13,
                lineHeight: 1.2,
                cursor: "pointer",
                boxShadow: mine
                  ? "0 2px 8px rgba(255,77,122,0.28)"
                  : "0 1px 3px rgba(201,24,74,0.08)",
                fontFamily: "'Cormorant Garamond', serif",
                fontWeight: 600,
                minHeight: 22,
              }}
              aria-label={`${formatNames(users)} reacted with ${emoji}. Tap to ${mine ? "remove" : "add"} your reaction.`}
            >
              <span style={{ fontSize: 14 }}>{emoji}</span>
              {users.length > 1 && (
                <span style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{users.length}</span>
              )}
            </motion.button>
          );
        })}
      </div>

      {/* Small caption showing WHO reacted, e.g. "Faizan reacted ❤️" */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1, alignItems: inverse ? "flex-end" : "flex-start" }}>
        {entries.map(([emoji, users]) => (
          <span
            key={`cap-${emoji}`}
            data-testid={`reaction-caption-${emoji}`}
            style={{
              fontSize: 10,
              lineHeight: 1.25,
              opacity: 0.75,
              fontFamily: "'Cormorant Garamond', serif",
              fontStyle: "italic",
              letterSpacing: "0.02em",
              color: inverse ? "rgba(255,255,255,0.9)" : "#9a6072",
            }}
          >
            {formatNames(users)} reacted {emoji}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Video bubble (with play/pause + poster) ────────────────────────────────
function VideoBubble({
  url,
  width,
  height,
  durationMs,
  inverse: _inverse,
  compressing = false,
  compressPct = 0,
}: {
  url: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  inverse?: boolean;
  compressing?: boolean;
  compressPct?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const aspect = width && height ? width / height : 3 / 4;
  // Constrain the bubble box: max 260 wide, 340 tall
  let boxW = 260;
  let boxH = Math.round(boxW / aspect);
  if (boxH > 340) {
    boxH = 340;
    boxW = Math.round(boxH * aspect);
  }

  const openFull = () => {
    haptics.light();
    setExpanded(true);
  };
  const closeFull = () => setExpanded(false);

  // Lock body scroll while fullscreen is open + Escape closes.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  // Fullscreen viewer node — matches homepage MediaViewer style exactly,
  // rendered via portal so no ancestor stacking / transform can clip it.
  const fullscreenNode = (
    <AnimatePresence>
      {expanded && (
        <motion.div
          className="fixed inset-0 z-[400] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24 }}
          onClick={closeFull}
          data-testid="chat-video-fullscreen"
          style={{
            background: "rgba(12,2,8,0.94)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
          }}
        >
          {/* Top bar — close only (no download in chat) */}
          <div
            className="fixed top-0 left-0 right-0 z-[420] flex items-center justify-between"
            style={{ padding: "max(16px, env(safe-area-inset-top)) 18px 16px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <motion.button
              onClick={closeFull}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              data-testid="chat-video-close"
              aria-label="Close"
              className="cursor-pointer flex items-center justify-center rounded-full"
              style={{
                width: 44,
                height: 44,
                background: "rgba(255,255,255,0.14)",
                border: "1px solid rgba(255,255,255,0.22)",
                color: "white",
                fontSize: 20,
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
            >
              ✕
            </motion.button>
          </div>

          {/* Media stage — same padding as homepage MediaViewer */}
          <div
            className="relative flex items-center justify-center w-full h-full"
            style={{ padding: "72px 8px 64px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <motion.video
              src={url}
              controls
              autoPlay
              playsInline
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] as const }}
              className="block rounded-2xl"
              data-testid="chat-video-fullscreen-player"
              onClick={(e) => e.stopPropagation()}
              controlsList="nodownload noremoteplayback"
              disablePictureInPicture
              style={{
                maxWidth: "min(680px, 94vw)",
                maxHeight: "82vh",
                background: "#000",
                boxShadow: "0 0 80px rgba(255,80,130,0.28)",
              }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <div
        onClick={openFull}
        data-testid="chat-video-bubble"
        style={{
          position: "relative",
          width: boxW,
          height: boxH,
          borderRadius: 18,
          overflow: "hidden",
          background: "#000",
          cursor: "zoom-in",
        }}
      >
        <video
          src={url}
          preload="metadata"
          playsInline
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            pointerEvents: "none",
          }}
        />
        {/* Play button overlay — tapping anywhere on the bubble opens the fullscreen viewer */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 62,
            height: 62,
            borderRadius: 999,
            border: "1.5px solid rgba(255,255,255,0.85)",
            background: "rgba(0,0,0,0.5)",
            color: "white",
            fontSize: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            pointerEvents: "none",
          }}
        >
          ▶
        </div>
        {/* Duration chip */}
        {durationMs != null && (
          <div
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              padding: "2px 8px",
              borderRadius: 999,
              background: "rgba(0,0,0,0.55)",
              color: "white",
              fontSize: 11,
              fontFamily: "'Cormorant Garamond', serif",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.03em",
              backdropFilter: "blur(4px)",
            }}
          >
            🎬 {fmtDuration(durationMs)}
          </div>
        )}

        {/* Compression progress overlay */}
        {compressing && (
          <div
            data-testid="chat-video-compressing"
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(3px)",
              WebkitBackdropFilter: "blur(3px)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: "white",
              fontFamily: "'Cormorant Garamond', serif",
              zIndex: 3,
            }}
          >
            <div
              style={{
                fontSize: 12,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                fontWeight: 700,
                opacity: 0.92,
              }}
            >
              Compressing… {Math.round(compressPct * 100)}%
            </div>
            <div
              style={{
                width: "70%",
                maxWidth: 180,
                height: 5,
                borderRadius: 999,
                background: "rgba(255,255,255,0.22)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.max(3, Math.round(compressPct * 100))}%`,
                  height: "100%",
                  background: "linear-gradient(90deg,#ff8fab,#ff4d7a)",
                  transition: "width 240ms ease",
                }}
              />
            </div>
          </div>
        )}
      </div>

      {typeof document !== "undefined"
        ? createPortal(fullscreenNode, document.body)
        : null}
    </>
  );
}

// ─── In-app video recorder ───────────────────────────────────────────────
// Full-screen modal that streams the device camera via getUserMedia, records
// with MediaRecorder, and hands the resulting File back to the caller. This
// exists because iOS's file-input video mode has an autofocus bug where the
// preview blurs a couple of seconds into recording — controlling the pipeline
// ourselves keeps the frame sharp AND lets us add a front/back camera toggle.
function InAppVideoRecorder({
  open,
  onClose,
  onCapture,
  onUnavailable,
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  onUnavailable: () => void;
}) {
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTsRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const mimeRef = useRef<string>("video/webm");

  // Pick the best MediaRecorder MIME the browser can encode.
  const pickMime = (): string => {
    const candidates = [
      "video/mp4;codecs=avc1,mp4a",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (const m of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
        return m;
      }
    }
    return "";
  };

  const stopStream = () => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
    }
    streamRef.current = null;
    if (videoRef.current) {
      try { videoRef.current.srcObject = null; } catch { /* noop */ }
    }
  };

  const acquireStream = async (which: "user" | "environment") => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Camera not supported on this browser.");
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: which },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      // Fix autofocus hunting: if the browser exposes continuous focus, ask for
      // it explicitly so the preview locks quickly instead of drifting.
      const vTrack = stream.getVideoTracks()[0];
      if (vTrack && typeof vTrack.applyConstraints === "function") {
        try {
          await vTrack.applyConstraints({
            advanced: [
              { focusMode: "continuous" } as MediaTrackConstraintSet,
            ],
          });
        } catch { /* not all browsers support focusMode; ignore */ }
      }
      return stream;
    } catch (err) {
      console.error("[recorder] getUserMedia failed", err);
      const msg =
        (err as DOMException)?.name === "NotAllowedError"
          ? "Camera access was denied. Enable it in your browser settings."
          : (err as DOMException)?.name === "NotFoundError"
          ? "No camera found on this device."
          : "Couldn't open the camera. Try again or pick from gallery.";
      setError(msg);
      return null;
    }
  };

  // Open / close lifecycle
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReady(false);
    setError(null);
    setElapsed(0);
    setRecording(false);
    chunksRef.current = [];

    (async () => {
      const stream = await acquireStream(facing);
      if (cancelled) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!stream) return;
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        try { await videoRef.current.play(); } catch { /* noop */ }
      }
      setReady(true);
    })();

    return () => {
      cancelled = true;
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
      if (recRef.current && recRef.current.state !== "inactive") {
        try { recRef.current.stop(); } catch { /* noop */ }
      }
      recRef.current = null;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Flip camera: reacquire stream with the opposite facing mode without
  // closing the modal.
  const flipCamera = async () => {
    if (recording || switching) return;
    haptics.light();
    setSwitching(true);
    const next: "user" | "environment" = facing === "environment" ? "user" : "environment";
    stopStream();
    const stream = await acquireStream(next);
    if (stream) {
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch { /* noop */ }
      }
      setFacing(next);
    }
    setSwitching(false);
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream || recording) return;
    const mime = pickMime();
    mimeRef.current = mime || "video/webm";
    haptics.light();
    try {
      chunksRef.current = [];
      const rec = new MediaRecorder(
        stream,
        mime
          ? { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 }
          : undefined,
      );
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        const ext = mimeRef.current.includes("mp4") ? "mp4" : "webm";
        const file = new File(
          [blob],
          `chat-video-${Date.now()}.${ext}`,
          { type: mimeRef.current.split(";")[0] || "video/webm" },
        );
        onCapture(file);
      };
      rec.start(500);
      recRef.current = rec;
      setRecording(true);
      startTsRef.current = Date.now();
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTsRef.current) / 1000));
      }, 200);
    } catch (err) {
      console.error("[recorder] start failed", err);
      setError("Couldn't start recording. Try again.");
    }
  };

  const stopRecording = () => {
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return;
    haptics.light();
    try { rec.stop(); } catch { /* noop */ }
    recRef.current = null;
    setRecording(false);
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
  };

  const handleClose = () => {
    if (recording) {
      // Abort the recording — discard buffered chunks so no clip is sent.
      const rec = recRef.current;
      if (rec) rec.onstop = null;
      try { rec?.stop(); } catch { /* noop */ }
      recRef.current = null;
      setRecording(false);
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
      chunksRef.current = [];
    }
    stopStream();
    onClose();
  };

  // Escape key closes the modal
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recording]);

  if (typeof document === "undefined") return null;

  const fmt = (s: number) => {
    const mm = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const node = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[500] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          style={{ background: "#000" }}
          data-testid="inapp-video-recorder"
        >
          {/* Live preview */}
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            data-testid="recorder-preview"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              // Mirror the front camera so it feels like a mirror.
              transform: facing === "user" ? "scaleX(-1)" : "none",
              background: "#000",
            }}
          />

          {/* Top bar */}
          <div
            style={{
              position: "absolute",
              top: 0, left: 0, right: 0,
              padding: "max(16px, env(safe-area-inset-top)) 16px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              zIndex: 2,
              background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)",
            }}
          >
            <motion.button
              onClick={handleClose}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.9 }}
              data-testid="recorder-close"
              aria-label="Close camera"
              style={{
                width: 42, height: 42, borderRadius: 999,
                background: "rgba(255,255,255,0.16)",
                border: "1px solid rgba(255,255,255,0.28)",
                color: "white",
                fontSize: 20,
                cursor: "pointer",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
            >
              ✕
            </motion.button>

            {/* Timer (only visible while recording) */}
            <AnimatePresence>
              {recording && (
                <motion.div
                  key="timer"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  data-testid="recorder-timer"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 14px",
                    borderRadius: 999,
                    background: "rgba(220,32,72,0.9)",
                    color: "white",
                    fontFamily: "'Cormorant Garamond', serif",
                    fontSize: 15,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "0.04em",
                    boxShadow: "0 4px 18px rgba(220,32,72,0.4)",
                  }}
                >
                  <motion.span
                    animate={{ opacity: [1, 0.25, 1] }}
                    transition={{ duration: 1.1, repeat: Infinity }}
                    style={{
                      display: "inline-block",
                      width: 9, height: 9, borderRadius: 999,
                      background: "white",
                    }}
                  />
                  REC {fmt(elapsed)}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Flip camera — disabled while recording so the take doesn't glitch */}
            <motion.button
              onClick={() => { void flipCamera(); }}
              whileHover={{ scale: recording ? 1 : 1.08 }}
              whileTap={{ scale: recording ? 1 : 0.9 }}
              disabled={recording || switching || !ready}
              data-testid="recorder-flip"
              aria-label="Flip camera"
              style={{
                width: 42, height: 42, borderRadius: 999,
                background: "rgba(255,255,255,0.16)",
                border: "1px solid rgba(255,255,255,0.28)",
                color: "white",
                fontSize: 20,
                cursor: recording ? "not-allowed" : "pointer",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
                opacity: recording ? 0.4 : 1,
              }}
            >
              🔄
            </motion.button>
          </div>

          {/* Bottom controls */}
          <div
            style={{
              position: "absolute",
              left: 0, right: 0, bottom: 0,
              padding: "24px 16px max(28px, env(safe-area-inset-bottom))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
              background: "linear-gradient(0deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)",
            }}
          >
            <motion.button
              onClick={() => (recording ? stopRecording() : startRecording())}
              whileTap={{ scale: 0.92 }}
              disabled={!ready}
              data-testid="recorder-record-btn"
              aria-label={recording ? "Stop recording" : "Start recording"}
              style={{
                width: 78, height: 78, borderRadius: 999,
                border: "4px solid white",
                background: recording ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.15)",
                cursor: ready ? "pointer" : "wait",
                position: "relative",
                boxShadow: "0 0 0 4px rgba(255,255,255,0.18), 0 8px 30px rgba(0,0,0,0.4)",
              }}
            >
              <motion.span
                animate={
                  recording
                    ? { borderRadius: 8, width: 34, height: 34 }
                    : { borderRadius: 999, width: 58, height: 58 }
                }
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }}
                style={{
                  position: "absolute",
                  left: "50%", top: "50%",
                  transform: "translate(-50%, -50%)",
                  background: "#ff2b5b",
                  display: "block",
                }}
              />
            </motion.button>
          </div>

          {/* Loading / error states */}
          {!ready && !error && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "rgba(255,255,255,0.7)",
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 16,
                zIndex: 3,
                pointerEvents: "none",
              }}
            >
              Opening camera…
            </div>
          )}
          {error && (
            <div
              data-testid="recorder-error"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 16,
                padding: "0 32px",
                textAlign: "center",
                color: "white",
                fontFamily: "'Cormorant Garamond', serif",
                zIndex: 4,
                background: "rgba(0,0,0,0.9)",
              }}
            >
              <div style={{ fontSize: 40 }}>📷</div>
              <div style={{ fontSize: 16, opacity: 0.9 }}>{error}</div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={onUnavailable}
                  style={{
                    padding: "10px 18px",
                    borderRadius: 999,
                    background: "linear-gradient(135deg,#ff8fab,#ff4d7a)",
                    color: "white",
                    border: "none",
                    fontFamily: "'Cormorant Garamond', serif",
                    fontWeight: 700,
                    fontSize: 13,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  Pick from gallery
                </button>
                <button
                  onClick={handleClose}
                  style={{
                    padding: "10px 18px",
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.14)",
                    color: "white",
                    border: "1px solid rgba(255,255,255,0.28)",
                    fontFamily: "'Cormorant Garamond', serif",
                    fontWeight: 700,
                    fontSize: 13,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(node, document.body);
}

