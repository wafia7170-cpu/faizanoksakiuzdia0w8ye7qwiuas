import ChatOverlay from "../homepage/_components/chat-overlay.tsx";

// ─────────────────────────────────────────────────────────────────────────────
//  Chat page — mounts the full-featured chat full-screen (always open) as the
//  whole app. A static blush backdrop sits behind the chat's translucent veil
//  so there is never a white flash.
// ─────────────────────────────────────────────────────────────────────────────

export default function ChatPage({ onExit }: { onExit: () => void }) {
  return (
    <>
      <div
        className="fixed inset-0"
        style={{ background: "radial-gradient(ellipse at 50% -10%, #fce4ec 0%, #fff0f5 30%, #fff5fa 60%, #ffffff 100%)" }}
      />
      <ChatOverlay open onClose={onExit} />
    </>
  );
}
