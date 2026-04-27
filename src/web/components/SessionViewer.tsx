// KCode - Session Viewer Component (React)
// Shows conversation messages with syntax highlighting and expandable tool calls.

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";

interface MessageEntry {
  index: number;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface MessagesData {
  messages: MessageEntry[];
  total: number;
  limit: number;
  offset: number;
}

export function SessionViewer({ authToken }: { authToken: string }) {
  const [data, setData] = useState<MessagesData | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const limit = 50;

  const fetchData = useCallback(() => {
    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    fetch(`/api/v1/messages?limit=${limit}&offset=${offset}`, { headers })
      .then((res) => res.json())
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [authToken, offset]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (error) {
    return (
      <div style={styles.panel}>
        <h2 style={styles.title}>Session Viewer</h2>
        <div style={styles.error}>Failed to load messages: {error}</div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <h2 style={styles.title}>Session Viewer</h2>
        <button style={styles.refreshBtn} onClick={fetchData}>
          Refresh
        </button>
      </div>

      {!data || data.messages.length === 0 ? (
        <div style={styles.empty}>No messages in this session yet.</div>
      ) : (
        <>
          {data.messages.map((msg) => (
            <MessageBlock key={msg.index} msg={msg} />
          ))}

          <div style={styles.pagination}>
            <span style={styles.paginationInfo}>
              Showing {offset + 1}-{Math.min(offset + data.messages.length, data.total)} of{" "}
              {data.total}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              {offset > 0 && (
                <button
                  style={styles.pageBtn}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  Previous
                </button>
              )}
              {offset + limit < data.total && (
                <button style={styles.pageBtn} onClick={() => setOffset(offset + limit)}>
                  Next
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MessageBlock({ msg }: { msg: MessageEntry }) {
  const isUser = msg.role === "user";

  return (
    <div
      style={{
        ...styles.message,
        ...(isUser ? styles.userMsg : styles.assistantMsg),
      }}
    >
      <div style={styles.msgHeader}>
        <span style={styles.role}>{isUser ? "You" : "Assistant"}</span>
        <span style={styles.index}>#{msg.index}</span>
      </div>
      <div style={styles.msgBody}>
        <MessageContent content={msg.content} />
      </div>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  if (!content) {
    return <span style={{ color: "#565f89", fontStyle: "italic" }}>Empty message</span>;
  }

  // Split on code blocks and tool patterns
  const parts: Array<{
    type: "text" | "code" | "tool";
    value: string;
    lang?: string;
    result?: string;
    isError?: boolean;
  }> = [];
  const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
  const toolRe = /\[tool:\s*(\w+)\]/g;

  let lastIdx = 0;
  let match: RegExpExecArray | null;

  // First pass: extract code blocks
  const withCodePlaceholders: string[] = [];
  const codeBlocks: Array<{ lang: string; code: string }> = [];
  const tempContent = content;
  while ((match = codeBlockRe.exec(content)) !== null) {
    if (match.index > lastIdx) {
      withCodePlaceholders.push(content.slice(lastIdx, match.index));
    }
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    withCodePlaceholders.push(placeholder);
    codeBlocks.push({ lang: match[1], code: match[2] });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < content.length) {
    withCodePlaceholders.push(content.slice(lastIdx));
  }
  const joined = withCodePlaceholders.join("");

  // Simple render: split text and code
  const segments = joined.split(/(__CODE_BLOCK_\d+__)/);
  const elements: JSX.Element[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const codeMatch = seg.match(/^__CODE_BLOCK_(\d+)__$/);
    if (codeMatch) {
      const idx = parseInt(codeMatch[1], 10);
      const block = codeBlocks[idx];
      elements.push(
        <div key={`code-${i}`} style={styles.codeBlock}>
          {block.lang && <div style={styles.codeLang}>{block.lang}</div>}
          <pre style={styles.pre}>
            <code>{block.code}</code>
          </pre>
        </div>,
      );
    } else if (seg) {
      elements.push(
        <span key={`text-${i}`} style={{ whiteSpace: "pre-wrap" }}>
          {seg}
        </span>,
      );
    }
  }

  return <>{elements}</>;
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    padding: 24,
    maxWidth: 900,
    margin: "0 auto",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#c0caf5",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    paddingBottom: 8,
    borderBottom: "1px solid #3b4261",
    margin: 0,
  },
  refreshBtn: {
    fontSize: 12,
    padding: "4px 12px",
    background: "#2f3350",
    color: "#c0caf5",
    border: "1px solid #3b4261",
    borderRadius: 8,
    cursor: "pointer",
  },
  message: {
    padding: "12px 16px",
    borderRadius: 8,
    marginBottom: 8,
  },
  userMsg: {
    background: "#2a4a7f",
    borderLeft: "3px solid #7aa2f7",
  },
  assistantMsg: {
    background: "#2a2e3e",
    borderLeft: "3px solid #9ece6a",
  },
  msgHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  role: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#565f89",
  },
  index: {
    fontFamily: "monospace",
    fontSize: 10,
    color: "#565f89",
  },
  msgBody: {
    fontSize: 13,
    lineHeight: 1.6,
    wordWrap: "break-word",
    overflowWrap: "break-word",
  },
  codeBlock: {
    margin: "8px 0",
  },
  codeLang: {
    fontFamily: "monospace",
    fontSize: 10,
    color: "#565f89",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  pre: {
    background: "#16171f",
    border: "1px solid #2a2e3e",
    borderRadius: 8,
    padding: "12px 16px",
    overflowX: "auto",
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 1.5,
    color: "#a9b1d6",
    margin: 0,
  },
  pagination: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 0",
    borderTop: "1px solid #2a2e3e",
    marginTop: 12,
  },
  paginationInfo: {
    fontSize: 12,
    color: "#565f89",
  },
  pageBtn: {
    fontSize: 12,
    padding: "4px 12px",
    background: "#2f3350",
    color: "#c0caf5",
    border: "1px solid #3b4261",
    borderRadius: 8,
    cursor: "pointer",
  },
  empty: {
    textAlign: "center",
    padding: 32,
    color: "#565f89",
  },
  error: {
    padding: "12px 16px",
    background: "rgba(247, 118, 142, 0.1)",
    border: "1px solid #f7768e",
    borderRadius: 8,
    color: "#f7768e",
  },
};
