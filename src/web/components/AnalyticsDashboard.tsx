// KCode - Analytics Dashboard Component (React)
// Shows session stats: total tokens, cost, tool usage breakdown with CSS bar charts.

import { useCallback, useEffect, useState } from "react";

interface StatsData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  turnCosts: Array<number | { cost?: number; tokens?: number }>;
  model: string;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function AnalyticsDashboard({ authToken }: { authToken: string }) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [toolUsage, setToolUsage] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    fetch("/api/v1/stats", { headers })
      .then((res) => res.json())
      .then((d) => {
        setStats(d);
        setError(null);
      })
      .catch((err) => setError(err.message));

    fetch("/api/v1/messages?limit=500", { headers })
      .then((res) => res.json())
      .then((data) => {
        const usage: Record<string, number> = {};
        for (const msg of data.messages || []) {
          const content = msg.content || "";
          const re = /\[tool:\s*(\w+)\]/g;
          let match;
          while ((match = re.exec(content)) !== null) {
            const tool = match[1]!;
            usage[tool] = (usage[tool] || 0) + 1;
          }
        }
        setToolUsage(usage);
      })
      .catch(() => {});
  }, [authToken]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (error) {
    return (
      <div style={styles.panel}>
        <h2 style={styles.title}>Analytics</h2>
        <div style={styles.error}>Failed to load stats: {error}</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div style={styles.panel}>
        <h2 style={styles.title}>Analytics</h2>
        <div style={styles.empty}>Loading statistics...</div>
      </div>
    );
  }

  const turnValues = stats.turnCosts.map((tc) =>
    typeof tc === "number" ? tc : tc.cost || tc.tokens || 0,
  );
  const maxTurn = Math.max(...turnValues, 1);

  const toolKeys = Object.keys(toolUsage).sort((a, b) => (toolUsage[b] ?? 0) - (toolUsage[a] ?? 0));
  const maxTool = toolKeys.length > 0 ? (toolUsage[toolKeys[0]!] ?? 1) : 1;

  return (
    <div style={styles.panel}>
      <h2 style={styles.title}>Analytics</h2>

      <div style={styles.cards}>
        <StatCard label="Model" value={stats.model || "--"} />
        <StatCard label="Total Tokens" value={formatNumber(stats.totalTokens)} />
        <StatCard label="Input Tokens" value={formatNumber(stats.inputTokens)} />
        <StatCard label="Output Tokens" value={formatNumber(stats.outputTokens)} />
        <StatCard label="Cost" value={`$${stats.costUsd.toFixed(4)}`} />
      </div>

      {turnValues.length > 0 && (
        <>
          <h3 style={styles.sectionTitle}>Recent Turn Costs</h3>
          <div>
            {turnValues.map((val, i) => (
              <BarRow
                key={i}
                label={`Turn ${i + 1}`}
                value={val < 1 ? val.toFixed(4) : formatNumber(val)}
                pct={(val / maxTurn) * 100}
              />
            ))}
          </div>
        </>
      )}

      {toolKeys.length > 0 && (
        <>
          <h3 style={styles.sectionTitle}>Tool Usage Breakdown</h3>
          <div>
            {toolKeys.map((name) => (
              <BarRow
                key={name}
                label={name}
                value={String(toolUsage[name] ?? 0)}
                pct={((toolUsage[name] ?? 0) / maxTool) * 100}
                color="#7dcfff"
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statValue}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

function BarRow({
  label,
  value,
  pct,
  color,
}: {
  label: string;
  value: string;
  pct: number;
  color?: string;
}) {
  return (
    <div style={styles.barRow}>
      <span style={styles.barLabel}>{label}</span>
      <div style={styles.barOuter}>
        <div
          style={{
            ...styles.barInner,
            width: `${pct}%`,
            ...(color ? { background: color } : {}),
          }}
        />
      </div>
      <span style={styles.barValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    padding: 24,
    maxWidth: 900,
    margin: "0 auto",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#c0caf5",
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 16,
    paddingBottom: 8,
    borderBottom: "1px solid #3b4261",
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
    marginBottom: 16,
  },
  statCard: {
    background: "#24283b",
    border: "1px solid #2a2e3e",
    borderRadius: 8,
    padding: 16,
    textAlign: "center",
  },
  statValue: {
    fontFamily: "monospace",
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#565f89",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#a9b1d6",
    marginTop: 16,
    marginBottom: 8,
  },
  barRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "4px 0",
  },
  barLabel: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#a9b1d6",
    minWidth: 80,
    textAlign: "right",
    flexShrink: 0,
  },
  barOuter: {
    flex: 1,
    height: 18,
    background: "#2f3350",
    borderRadius: 4,
    overflow: "hidden",
  },
  barInner: {
    height: "100%",
    background: "#7aa2f7",
    borderRadius: 4,
    minWidth: 2,
    transition: "width 0.3s ease",
  },
  barValue: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#565f89",
    minWidth: 50,
    textAlign: "right",
    flexShrink: 0,
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
