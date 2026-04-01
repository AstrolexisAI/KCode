// KCode - Cloud Types

export interface KCodeCloudConfig {
  url: string;                // default: https://cloud.kulvex.ai
  token: string;
  teamId: string;
  features: {
    sessionSync: boolean;
    sharedMemory: boolean;
    analytics: boolean;
    policies: boolean;
    audit: boolean;
  };
}

export interface CloudTeam {
  id: string;
  name: string;
  members: TeamMember[];
  plan: "free" | "team" | "enterprise";
  usage: {
    sessionsThisMonth: number;
    tokensThisMonth: number;
    storageUsedMb: number;
  };
  limits: {
    maxMembers: number;
    maxSessions: number;
    maxStorageMb: number;
    maxTokensPerMonth: number;
  };
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
  lastActive: string;
}

export interface TeamPolicies {
  allowedModels: string[];
  maxCostPerSession: number;
  requireReview: boolean;
  auditEnabled: boolean;
  sessionRetentionDays: number;
}

export interface TeamAnalytics {
  period: string;
  totalSessions: number;
  totalTokens: number;
  totalCostUsd: number;
  activeMembers: number;
  topModels: Array<{ model: string; sessions: number }>;
  topTools: Array<{ tool: string; count: number }>;
}

export interface SyncResult {
  sessionId: string;
  messagesSynced: number;
  timestamp: string;
}

export interface CloudAuthResult {
  token: string;
  teamId: string;
  expiresAt: string;
}
