// KCode - Configuration Panel Component (React)
// Shows current config in read-only view with redacted secrets.

import { useCallback, useEffect, useState } from "react";

interface ConfigData {
  model?: string;
  maxTokens?: number;
  permissionMode?: string;
  workingDirectory?: string;
  effortLevel?: string;
  compactThreshold?: number;
  contextWindowSize?: number;
  theme?: string;
  fallbackModel?: string | null;
  pro?: boolean;
  apiKey?: string;
  anthropicApiKey?: string;
  proKey?: string;
}

interface ConfigField {
  key: keyof ConfigData;
  label: string;
  sensitive: boolean;
}

const CONFIG_FIELDS: ConfigField[] = [
  { key: "model", label: "Model", sensitive: false },
  { key: "permissionMode", label: "Permission Mode", sensitive: false },
  { key: "effortLevel", label: "Effort Level", sensitive: false },
  { key: "maxTokens", label: "Max Tokens", sensitive: false },
  { key: "contextWindowSize", label: "Context Window", sensitive: false },
  { key: "compactThreshold", label: "Compact Threshold", sensitive: false },
  { key: "workingDirectory", label: "Working Directory", sensitive: false },
  { key: "theme", label: "Theme", sensitive: false },
  { key: "fallbackModel", label: "Fallback Model", sensitive: false },
  { key: "pro", label: "Pro", sensitive: false },
  { key: "apiKey", label: "API Key", sensitive: true },
  { key: "anthropicApiKey", label: "Anthropic API Key", sensitive: true },
  { key: "proKey", label: "Pro Key", sensitive: true },
];

function formatConfigNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  if (n < 1 && n > 0) return n.toFixed(2);
  return String(n);
}

export function ConfigPanel({ authToken }: { authToken: string }) {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    fetch("/api/v1/config", { headers })
      .then((res) => res.json())
      .then((d) => {
        setConfig(d);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [authToken]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 20000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (error) {
    return (
      <div style={styles.panel}>
        <h2 style={styles.title}>Configuration</h2>
        <div style={styles.error}>Failed to load config: {error}</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div style={styles.panel}>
        <h2 style={styles.title}>Configuration</h2>
        <div style={styles.empty}>Loading configuration...</div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <h2 style={styles.title}>Configuration</h2>
      <div style={styles.note}>
        Read-only view. Edit settings via kcode setup or settings.json.
      </div>
      <table style={styles.table}>
        <tbody>
          {CONFIG_FIELDS.map((field) => {
            const value = config[field.key];
            if (value === undefined) return null;

            return (
              <tr key={field.key} style={styles.row}>
                <td style={styles.label}>{field.label}</td>
                <td style={styles.value}>
                  <ConfigValue
                    value={value}
                    sensitive={field.sensitive}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConfigValue({
  value,
  sensitive,
}: {
  value: unknown;
  sensitive: boolean;
}) {
  if (sensitive && value) {
    return <span style={styles.redacted}>***</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span
        style={value ? styles.badgeOn : styles.badgeOff}
      >
        {value ? "Enabled" : "Disabled"}
      </span>
    );
  }
  if (value === null) {
    return <span style={styles.null}>Not set</span>;
  }
  if (typeof value === "number") {
    return (
      <span style={styles.number}>{formatConfigNumber(value)}</span>
    );
  }
  return <span>{String(value)}</span>;
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
  note: {
    fontSize: 12,
    color: "#565f89",
    marginBottom: 12,
    padding: "8px 12px",
    background: "rgba(224, 175, 104, 0.08)",
    borderLeft: "3px solid #e0af68",
    borderRadius: "0 4px 4px 0",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  row: {
    borderBottom: "1px solid #2a2e3e",
  },
  label: {
    fontWeight: 500,
    color: "#a9b1d6",
    padding: "10px 16px 10px 0",
    width: 180,
    verticalAlign: "top",
  },
  value: {
    fontFamily: "monospace",
    color: "#c0caf5",
    padding: "10px 0",
    wordBreak: "break-all",
  },
  redacted: {
    color: "#565f89",
    fontStyle: "italic",
  },
  null: {
    color: "#565f89",
    fontStyle: "italic",
  },
  number: {
    color: "#ff9e64",
  },
  badgeOn: {
    fontFamily: "monospace",
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    background: "rgba(158, 206, 106, 0.15)",
    color: "#9ece6a",
    textTransform: "uppercase",
  },
  badgeOff: {
    fontFamily: "monospace",
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    background: "rgba(86, 95, 137, 0.2)",
    color: "#565f89",
    textTransform: "uppercase",
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
