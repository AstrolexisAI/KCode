// KCode Web UI — React entry point
// This is the modern React SPA that replaces the vanilla JS static UI.
// Connects to the KCode web server via WebSocket for streaming responses.

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ─── Types ──────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface WebSocketEvent {
  type: string;
  [key: string]: unknown;
}

// ─── WebSocket Hook ─────────────────────────────────────────────

function useWebSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<WebSocketEvent[]>([]);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WebSocketEvent;
        setEvents((prev) => [...prev, event]);
      } catch {
        /* ignore non-JSON messages */
      }
    };

    return () => {
      ws.close();
    };
  }, [url]);

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { connected, events, send };
}

// ─── App Component ──────────────────────────────────────────────

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState("--");
  const [tokenCount, setTokenCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
  const { connected, events, send } = useWebSocket(wsUrl);

  // Process WebSocket events
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1]!;

    switch (latest.type) {
      case "text_delta":
        setStreaming(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + (latest.text as string) },
            ];
          }
          return [
            ...prev,
            { role: "assistant", content: latest.text as string, timestamp: Date.now() },
          ];
        });
        break;

      case "message_end":
        setStreaming(false);
        if (typeof latest.tokens === "number") setTokenCount((p) => p + (latest.tokens as number));
        break;

      case "status":
        if (typeof latest.model === "string") setModel(latest.model);
        break;
    }
  }, [events]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) return;

    setMessages((prev) => [...prev, { role: "user", content: text, timestamp: Date.now() }]);
    send({ type: "message.send", content: text });
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#1a1a2e",
        color: "#e0e0e0",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid #333",
          background: "#16213e",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: "bold", color: "#6c63ff" }}>KCode</span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: connected ? "#4caf50" : "#f44336",
            }}
          />
          <span style={{ fontSize: 12, color: "#888" }}>{model}</span>
        </div>
        <div style={{ fontSize: 12, color: "#888" }}>
          {tokenCount > 0 && <span>{tokenCount.toLocaleString()} tokens</span>}
        </div>
      </header>

      {/* Messages */}
      <main style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", marginTop: "20vh", color: "#666" }}>
            <h2 style={{ color: "#6c63ff" }}>KCode Web UI</h2>
            <p>Connected to your local KCode session. Type a message below to get started.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              margin: "8px 0",
              padding: "12px 16px",
              borderRadius: 8,
              background: msg.role === "user" ? "#1e3a5f" : "#2a2a4a",
              borderLeft: msg.role === "user" ? "3px solid #6c63ff" : "3px solid #4caf50",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: msg.role === "assistant" ? "'Fira Code', monospace" : "inherit",
              fontSize: 14,
            }}
          >
            {msg.content}
          </div>
        ))}
        {streaming && <div style={{ color: "#6c63ff", padding: 8 }}>...</div>}
        <div ref={messagesEndRef} />
      </main>

      {/* Input */}
      <footer style={{ padding: "12px 16px", borderTop: "1px solid #333", background: "#16213e" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connected ? "Type a message..." : "Connecting..."}
            disabled={!connected}
            rows={1}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: 8,
              background: "#1a1a2e",
              color: "#e0e0e0",
              border: "1px solid #444",
              resize: "none",
              fontFamily: "inherit",
              fontSize: 14,
              outline: "none",
            }}
          />
          <button
            onClick={handleSend}
            disabled={!connected || streaming || !input.trim()}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              background: connected && !streaming && input.trim() ? "#6c63ff" : "#444",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontWeight: "bold",
              fontSize: 14,
            }}
          >
            Send
          </button>
        </div>
      </footer>
    </div>
  );
}

// ─── Mount ──────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
