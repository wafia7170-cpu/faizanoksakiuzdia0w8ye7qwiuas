import { Component, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          position: "fixed", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", padding: 24,
          background: "radial-gradient(ellipse at 50% 30%, #fce4ec 0%, #fff0f8 50%, #fff8fc 100%)",
          fontFamily: "'Cormorant Garamond', serif", textAlign: "center", zIndex: 9999,
        }}
      >
        <div style={{ fontSize: 56, marginBottom: 16 }}>💗</div>
        <p style={{ fontFamily: "'Great Vibes', cursive", fontSize: 36, color: "#c9184a", marginBottom: 12 }}>
          oops, a little hiccup
        </p>
        <p style={{ color: "#7a2040", fontSize: 15, maxWidth: 360, marginBottom: 22, lineHeight: 1.6 }}>
          Something didn&rsquo;t load quite right. Just tap below and we&rsquo;ll start over — everything you love is still here.
        </p>
        <button
          onClick={() => { this.reset(); window.location.reload(); }}
          style={{
            background: "linear-gradient(135deg, #ff4d7a, #c9184a)",
            color: "white", border: "none", padding: "12px 32px",
            borderRadius: 20, fontFamily: "'Cormorant Garamond', serif",
            fontSize: 16, letterSpacing: "0.12em", cursor: "pointer",
            boxShadow: "0 6px 24px rgba(255,77,122,0.4)",
          }}
        >
          try again ✨
        </button>
        {this.state.error && (
          <details style={{ marginTop: 28, color: "#94526c", fontSize: 11, maxWidth: 400, opacity: 0.5 }}>
            <summary style={{ cursor: "pointer" }}>details</summary>
            <pre style={{ whiteSpace: "pre-wrap", textAlign: "left", marginTop: 8 }}>
              {this.state.error.message}
            </pre>
          </details>
        )}
      </div>
    );
  }
}
