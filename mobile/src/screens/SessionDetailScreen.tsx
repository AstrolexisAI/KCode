import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { SessionsStackParamList } from "../../App";
import { client } from "../api/client";

type Props = NativeStackScreenProps<SessionsStackParamList, "SessionDetail">;

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  toolCall?: {
    id: string;
    name: string;
    status: "pending" | "approved" | "denied" | "executed";
  };
}

export default function SessionDetailScreen({ route }: Props) {
  const { sessionId } = route.params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<FlatList>(null);

  const fetchSession = useCallback(async () => {
    try {
      const data = await client.getSession(sessionId);
      setMessages(data.messages ?? []);
    } catch (err: any) {
      setError(err.message ?? "Failed to load session");
    }
  }, [sessionId]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // WebSocket for real-time updates
  useEffect(() => {
    let ws: WebSocket | null = null;

    async function connect() {
      const baseUrl = await client.getBaseUrl();
      if (!baseUrl) return;

      const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws/sessions/${sessionId}`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg: Message = JSON.parse(event.data);
          setMessages((prev) => {
            const existing = prev.findIndex((m) => m.id === msg.id);
            if (existing >= 0) {
              const updated = [...prev];
              updated[existing] = msg;
              return updated;
            }
            return [...prev, msg];
          });
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        // silently reconnect on error
      };
    }

    connect();
    return () => {
      ws?.close();
    };
  }, [sessionId]);

  const handleApprove = async (toolCallId: string) => {
    try {
      await client.approveToolCall(sessionId, toolCallId);
    } catch {
      // show error in production
    }
  };

  const handleDeny = async (toolCallId: string) => {
    try {
      await client.denyToolCall(sessionId, toolCallId);
    } catch {
      // show error in production
    }
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === "user";
    const isTool = item.role === "tool";

    return (
      <View
        style={[
          styles.messageBubble,
          isUser ? styles.userBubble : styles.assistantBubble,
          isTool && styles.toolBubble,
        ]}
      >
        <Text style={styles.roleLabel}>
          {item.role.toUpperCase()}
        </Text>
        <Text style={styles.messageText}>{item.content}</Text>

        {item.toolCall && item.toolCall.status === "pending" && (
          <View style={styles.toolApproval}>
            <Text style={styles.toolName}>{item.toolCall.name}</Text>
            <View style={styles.toolActions}>
              <TouchableOpacity
                style={[styles.actionButton, styles.approveButton]}
                onPress={() => handleApprove(item.toolCall!.id)}
              >
                <Text style={styles.actionText}>Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.denyButton]}
                onPress={() => handleDeny(item.toolCall!.id)}
              >
                <Text style={styles.actionText}>Deny</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {item.toolCall && item.toolCall.status !== "pending" && (
          <View style={styles.toolStatus}>
            <Text style={styles.toolName}>{item.toolCall.name}</Text>
            <Text
              style={[
                styles.statusBadge,
                item.toolCall.status === "approved" || item.toolCall.status === "executed"
                  ? styles.statusApproved
                  : styles.statusDenied,
              ]}
            >
              {item.toolCall.status}
            </Text>
          </View>
        )}
      </View>
    );
  };

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={renderMessage}
      contentContainerStyle={styles.list}
      onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 12, paddingBottom: 24 },
  messageBubble: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    maxWidth: "85%",
  },
  userBubble: {
    backgroundColor: "#312e81",
    alignSelf: "flex-end",
  },
  assistantBubble: {
    backgroundColor: "#1e1e2e",
    alignSelf: "flex-start",
  },
  toolBubble: {
    backgroundColor: "#1a2332",
    alignSelf: "flex-start",
    borderLeftWidth: 3,
    borderLeftColor: "#6366f1",
  },
  roleLabel: {
    color: "#6366f1",
    fontSize: 10,
    fontWeight: "700",
    marginBottom: 4,
  },
  messageText: {
    color: "#e2e8f0",
    fontSize: 14,
    lineHeight: 20,
  },
  toolApproval: {
    marginTop: 10,
    padding: 10,
    backgroundColor: "#0f172a",
    borderRadius: 8,
  },
  toolName: {
    color: "#a5b4fc",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
  },
  toolActions: {
    flexDirection: "row",
    gap: 8,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: "center",
  },
  approveButton: { backgroundColor: "#16a34a" },
  denyButton: { backgroundColor: "#dc2626" },
  actionText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  toolStatus: {
    marginTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusBadge: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  statusApproved: { color: "#4ade80", backgroundColor: "#052e16" },
  statusDenied: { color: "#fca5a5", backgroundColor: "#450a0a" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  errorText: { color: "#ef4444", fontSize: 14 },
});
