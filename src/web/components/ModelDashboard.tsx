// KCode - Model Dashboard Component (React)
// Shows active model, registered models, and hardware info.

import { useCallback, useEffect, useState } from "react";

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

interface ModelData {
  models: ModelEntry[];
  active: string;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

export function ModelDashboard({ authToken }: { authToken: string }) {
  const [data, setData] = useState<ModelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    fetch("/api/v1/models", { headers })
      .then((res) => res.json())
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [authToken]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (error) {
    return (
      <div style={styles.panel}>
        <h2 style={styles.title}>Models</h2>
        <div style={styles.error}>Failed to load models: {error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={styles.panel}>
        <h2 style={styles.title}>Models</h2>
        <div style={styles.empty}>Loading...</div>
      </div>
    );
  }

  const activeEntry = data.models.find(
    (m) => m.id === data.active || m.name === data.active,
  );

  return (
    <div style={styles.panel}>
      <h2 style={styles.title}>Models</h2>

      {/* Active model card */}
      <div style={styles.activeCard}>
        <div style={styles.activeLabel}>Active Model</div>
        <div style={styles.activeName}>{data.active}</div>
        {activeEntry && (
          <>
            <span style={styles.providerBadge}>{activeEntry.provider}</span>
            {activeEntry.contextWindow && (
              <span style={styles.contextSize}>
                {formatNumber(activeEntry.contextWindow)} ctx
              </span>
            )}
          </>
        )}
      </div>

      {/* Model list */}
      {data.models.length > 0 ? (
        <>
          <h3 style={styles.listTitle}>
            Registered Models ({data.models.length})
          </h3>
          <div style={styles.list}>
            {data.models.map((m) => {
              const isActive =
                m.id === data.active || m.name === data.active;
              return (
                <div
                  key={m.id}
                  style={{
                    ...styles.row,
                    ...(isActive ? styles.rowActive : {}),
                  }}
                >
                  <span style={styles.rowName}>{m.name || m.id}</span>
                  <span style={styles.providerBadge}>{m.provider}</span>
                  <span
                    style={
                      isActive ? styles.statusActive : styles.statusAvailable
                    }
                  >
                    {isActive ? "active" : "available"}
                  </span>
                  {m.contextWindow && (
                    <span style={styles.rowCtx}>
                      {formatNumber(m.contextWindow)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div style={styles.empty}>
          No models registered. Use kcode models to configure.
        </div>
      )}
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
  activeCard: {
    background: "#24283b",
    border: "1px solid #7aa2f7",
    borderRadius: 12,
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 16,
  },
  activeLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#565f89",
  },
  activeName: {
    fontFamily: "monospace",
    fontSize: 18,
    fontWeight: 600,
    color: "#7aa2f7",
  },
  providerBadge: {
    fontFamily: "monospace",
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    background: "rgba(122, 162, 247, 0.15)",
    color: "#7aa2f7",
    width: "fit-content",
    textTransform: "uppercase",
  },
  contextSize: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#565f89",
  },
  listTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#a9b1d6",
    marginTop: 8,
    marginBottom: 8,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 12px",
    background: "#24283b",
    border: "1px solid #2a2e3e",
    borderRadius: 8,
  },
  rowActive: {
    borderColor: "#7aa2f7",
    background: "rgba(122, 162, 247, 0.05)",
  },
  rowName: {
    flex: 1,
    fontFamily: "monospace",
    fontSize: 13,
  },
  statusActive: {
    fontSize: 11,
    fontWeight: 500,
    textTransform: "uppercase",
    color: "#9ece6a",
  },
  statusAvailable: {
    fontSize: 11,
    fontWeight: 500,
    textTransform: "uppercase",
    color: "#565f89",
  },
  rowCtx: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#565f89",
    minWidth: 40,
    textAlign: "right",
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
