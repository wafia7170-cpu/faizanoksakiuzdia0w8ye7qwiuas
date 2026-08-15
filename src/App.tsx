import { useState, useCallback, useEffect } from "react";
import { DefaultProviders } from "./components/providers/default.tsx";
import { ErrorBoundary } from "./components/error-boundary.tsx";
import Lockscreen from "./pages/lock/page.tsx";
import ChatPage from "./pages/chat/page.tsx";
import { prefetchMessages } from "./lib/cloud-chat.ts";
import { initBadgeAutoClear } from "./lib/badge.ts";

// Lightweight private chat app: passcode gate → chat. Nothing else runs.
export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const unlock = useCallback(() => setUnlocked(true), []);
  const lock = useCallback(() => setUnlocked(false), []);

  // Warm the chat history the moment the app mounts — while the user is still
  // entering the passcode — so messages are already in flight (often fully
  // loaded) by the time they unlock. This removes the "wait after passcode".
  useEffect(() => { void prefetchMessages(); }, []);

  // Clear the app-icon unread badge whenever the user is looking at the app
  // again (window becomes visible / focused). The service worker sets/counts
  // the badge while the app is backgrounded or closed.
  useEffect(() => initBadgeAutoClear(), []);

  return (
    <ErrorBoundary>
      <DefaultProviders>
        {unlocked ? <ChatPage onExit={lock} /> : <Lockscreen onUnlock={unlock} />}
      </DefaultProviders>
    </ErrorBoundary>
  );
}
