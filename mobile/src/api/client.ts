import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_SERVER_URL = "kcode_server_url";
const STORAGE_API_KEY = "kcode_api_key";

const DEFAULT_SERVER_URL = "http://localhost:10091";

export interface Session {
  id: string;
  name: string;
  model: string;
  messageCount: number;
  lastActivity: string;
}

export interface SessionDetail {
  id: string;
  name: string;
  model: string;
  messages: {
    id: string;
    role: "user" | "assistant" | "tool";
    content: string;
    timestamp: string;
    toolCall?: {
      id: string;
      name: string;
      status: "pending" | "approved" | "denied" | "executed";
    };
  }[];
}

export interface Analytics {
  tokens: {
    input: number;
    output: number;
  };
  costByModel: {
    model: string;
    costCents: number;
  }[];
  topTools: {
    name: string;
    count: number;
  }[];
  sessionCountThisMonth: number;
}

class KCodeMobileClient {
  private cachedUrl: string | null = null;
  private cachedKey: string | null = null;

  async getBaseUrl(): Promise<string> {
    if (!this.cachedUrl) {
      this.cachedUrl =
        (await AsyncStorage.getItem(STORAGE_SERVER_URL)) ?? DEFAULT_SERVER_URL;
    }
    return this.cachedUrl;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    if (!this.cachedKey) {
      this.cachedKey = (await AsyncStorage.getItem(STORAGE_API_KEY)) ?? "";
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.cachedKey) {
      headers["Authorization"] = `Bearer ${this.cachedKey}`;
    }
    return headers;
  }

  /** Clear cached credentials (call after settings change). */
  invalidateCache(): void {
    this.cachedUrl = null;
    this.cachedKey = null;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API error ${res.status}: ${body || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async getSessions(): Promise<Session[]> {
    return this.request<Session[]>("/api/sessions");
  }

  async getSession(sessionId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>(`/api/sessions/${sessionId}`);
  }

  async getAnalytics(): Promise<Analytics> {
    return this.request<Analytics>("/api/analytics");
  }

  async approveToolCall(
    sessionId: string,
    toolCallId: string
  ): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/tools/${toolCallId}/approve`, {
      method: "POST",
    });
  }

  async denyToolCall(
    sessionId: string,
    toolCallId: string
  ): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/tools/${toolCallId}/deny`, {
      method: "POST",
    });
  }
}

/** Singleton client instance. */
export const client = new KCodeMobileClient();
