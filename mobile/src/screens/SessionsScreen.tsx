import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { SessionsStackParamList } from "../../App";
import { client, type Session } from "../api/client";

type Props = NativeStackScreenProps<SessionsStackParamList, "SessionsList">;

export default function SessionsScreen({ navigation }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      setError(null);
      const data = await client.getSessions();
      setSessions(data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load sessions");
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchSessions();
    setRefreshing(false);
  }, [fetchSessions]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const renderSession = ({ item }: { item: Session }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() =>
        navigation.navigate("SessionDetail", {
          sessionId: item.id,
          sessionName: item.name,
        })
      }
    >
      <View style={styles.cardHeader}>
        <Text style={styles.sessionName} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.model}>{item.model}</Text>
      </View>
      <View style={styles.cardFooter}>
        <Text style={styles.meta}>{item.messageCount} messages</Text>
        <Text style={styles.meta}>{formatDate(item.lastActivity)}</Text>
      </View>
    </TouchableOpacity>
  );

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={fetchSessions}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      data={sessions}
      keyExtractor={(item) => item.id}
      renderItem={renderSession}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyText}>No active sessions</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 12 },
  card: {
    backgroundColor: "#1e1e2e",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sessionName: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
    marginRight: 8,
  },
  model: {
    color: "#6366f1",
    fontSize: 12,
    backgroundColor: "#312e81",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
  },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  meta: { color: "#9ca3af", fontSize: 12 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  errorText: { color: "#ef4444", fontSize: 14, marginBottom: 12, textAlign: "center" },
  retryButton: {
    backgroundColor: "#6366f1",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: { color: "#fff", fontWeight: "600" },
  emptyText: { color: "#9ca3af", fontSize: 14 },
});
