// Session persistence type definitions

export interface SessionCheckpoint {
  id: string;
  timestamp: number;
  conversationId: string;
  messages: unknown[]; // Message array snapshot
  toolStates: Record<string, unknown>;
  planState?: unknown;
  workingDirectory: string;
  gitBranch?: string;
  modelId: string;
  tokensUsed: number;
  costUsd: number;
}

export interface TeleportPackage {
  version: string;
  exportedAt: number;
  sourceHost: string;
  session: SessionCheckpoint;
  gitDiff?: string;
  referencedFiles: Array<{ path: string; content: string }>;
  plan?: unknown;
}

export interface CrashInfo {
  pid: number;
  staleFile: string;
  checkpoint: SessionCheckpoint | null;
}
