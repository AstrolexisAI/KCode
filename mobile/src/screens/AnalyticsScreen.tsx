import React, { useCallback, useEffect, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { client, type Analytics } from "../api/client";

export default function AnalyticsScreen() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    try {
      setError(null);
      const data = await client.getAnalytics();
      setAnalytics(data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load analytics");
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAnalytics();
    setRefreshing(false);
  }, [fetchAnalytics]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const formatTokens = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!analytics) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Loading analytics...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Token Usage */}
      <Text style={styles.sectionTitle}>Token Usage</Text>
      <View style={styles.row}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>
            {formatTokens(analytics.tokens.input)}
          </Text>
          <Text style={styles.statLabel}>Input Tokens</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>
            {formatTokens(analytics.tokens.output)}
          </Text>
          <Text style={styles.statLabel}>Output Tokens</Text>
        </View>
      </View>

      {/* Token Bar */}
      <View style={styles.barContainer}>
        <View
          style={[
            styles.barSegment,
            styles.barInput,
            {
              flex: analytics.tokens.input / (analytics.tokens.input + analytics.tokens.output || 1),
            },
          ]}
        />
        <View
          style={[
            styles.barSegment,
            styles.barOutput,
            {
              flex: analytics.tokens.output / (analytics.tokens.input + analytics.tokens.output || 1),
            },
          ]}
        />
      </View>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: "#6366f1" }]} />
          <Text style={styles.legendText}>Input</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: "#a78bfa" }]} />
          <Text style={styles.legendText}>Output</Text>
        </View>
      </View>

      {/* Cost Breakdown */}
      <Text style={styles.sectionTitle}>Cost by Model</Text>
      {analytics.costByModel.map((entry) => (
        <View key={entry.model} style={styles.costRow}>
          <Text style={styles.costModel} numberOfLines={1}>
            {entry.model}
          </Text>
          <Text style={styles.costValue}>{formatCost(entry.costCents)}</Text>
        </View>
      ))}
      <View style={styles.costRow}>
        <Text style={[styles.costModel, styles.totalLabel]}>Total</Text>
        <Text style={[styles.costValue, styles.totalLabel]}>
          {formatCost(analytics.costByModel.reduce((s, e) => s + e.costCents, 0))}
        </Text>
      </View>

      {/* Most Used Tools */}
      <Text style={styles.sectionTitle}>Most Used Tools</Text>
      {analytics.topTools.map((tool, i) => (
        <View key={tool.name} style={styles.toolRow}>
          <Text style={styles.toolRank}>{i + 1}</Text>
          <Text style={styles.toolName}>{tool.name}</Text>
          <Text style={styles.toolCount}>{tool.count}x</Text>
        </View>
      ))}

      {/* Session Count */}
      <Text style={styles.sectionTitle}>Activity</Text>
      <View style={styles.statCard}>
        <Text style={styles.statValue}>{analytics.sessionCountThisMonth}</Text>
        <Text style={styles.statLabel}>Sessions This Month</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  content: { padding: 16 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  errorText: { color: "#ef4444", fontSize: 14 },
  loadingText: { color: "#9ca3af", fontSize: 14 },
  sectionTitle: {
    color: "#e2e8f0",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 20,
    marginBottom: 12,
  },
  row: { flexDirection: "row", gap: 10 },
  statCard: {
    flex: 1,
    backgroundColor: "#1e1e2e",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginBottom: 10,
  },
  statValue: { color: "#a5b4fc", fontSize: 24, fontWeight: "700" },
  statLabel: { color: "#9ca3af", fontSize: 12, marginTop: 4 },
  barContainer: {
    flexDirection: "row",
    height: 12,
    borderRadius: 6,
    overflow: "hidden",
    marginBottom: 6,
  },
  barSegment: { height: "100%" },
  barInput: { backgroundColor: "#6366f1" },
  barOutput: { backgroundColor: "#a78bfa" },
  legendRow: { flexDirection: "row", gap: 16, marginBottom: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: "#9ca3af", fontSize: 12 },
  costRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: "#1e1e2e",
    padding: 12,
    borderRadius: 8,
    marginBottom: 6,
  },
  costModel: { color: "#e2e8f0", fontSize: 14, flex: 1 },
  costValue: { color: "#a5b4fc", fontSize: 14, fontWeight: "600" },
  totalLabel: { fontWeight: "700" },
  toolRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e1e2e",
    padding: 12,
    borderRadius: 8,
    marginBottom: 6,
  },
  toolRank: { color: "#6366f1", fontSize: 14, fontWeight: "700", width: 24 },
  toolName: { color: "#e2e8f0", fontSize: 14, flex: 1 },
  toolCount: { color: "#9ca3af", fontSize: 14 },
});
