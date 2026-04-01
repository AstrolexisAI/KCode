// KCode - Real-time Collaboration Types

export interface CollabSession {
  sessionId: string;
  ownerId: string;
  shareToken: string;
  participants: Participant[];
  mode: "view" | "interact";
  maxParticipants: number;
  createdAt: number;
}

export interface Participant {
  id: string;
  name: string;
  role: "owner" | "collaborator" | "viewer";
  connectedAt: number;
  lastActivity: number;
  color: string;
}

export interface ShareInfo {
  shareUrl: string;
  shareToken: string;
  publicUrl?: string;
}

export interface JoinResult {
  participant: Participant;
  history: unknown[];
  currentState: {
    model: string;
    tokens: number;
    isResponding: boolean;
  };
}

export interface CollabEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
  participantId?: string;
}

export interface ChatMessage {
  id: string;
  participantId: string;
  participantName: string;
  message: string;
  timestamp: number;
}

export interface CursorPosition {
  participantId: string;
  file: string;
  line: number;
  col: number;
  color: string;
  updatedAt: number;
}

export const PARTICIPANT_COLORS = [
  "#e06c75", "#98c379", "#e5c07b", "#61afef",
  "#c678dd", "#56b6c2", "#be5046", "#d19a66",
] as const;
