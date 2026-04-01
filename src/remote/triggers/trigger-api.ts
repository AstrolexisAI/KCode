// KCode - Remote Trigger API Client

import type {
  RemoteTrigger,
  TriggerCreateInput,
  TriggerRunResult,
  TriggerUpdateInput,
} from "./types";
import { TriggerApiError } from "./types";

const DEFAULT_BASE_URL = "https://cloud.kulvex.ai/api/v1";

export class TriggerApiClient {
  private baseUrl: string;
  private authToken?: string;

  constructor(baseUrl?: string, authToken?: string) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.authToken = authToken;
  }

  /**
   * Create a new remote trigger.
   */
  async createTrigger(input: TriggerCreateInput): Promise<RemoteTrigger> {
    return this.request<RemoteTrigger>("POST", "/triggers", input);
  }

  /**
   * List all triggers for the authenticated user.
   */
  async listTriggers(): Promise<RemoteTrigger[]> {
    return this.request<RemoteTrigger[]>("GET", "/triggers");
  }

  /**
   * Get a single trigger by ID. Returns null if not found.
   */
  async getTrigger(id: string): Promise<RemoteTrigger | null> {
    try {
      return await this.request<RemoteTrigger>("GET", `/triggers/${id}`);
    } catch (err) {
      if (err instanceof TriggerApiError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Update an existing trigger.
   */
  async updateTrigger(id: string, updates: TriggerUpdateInput): Promise<RemoteTrigger> {
    return this.request<RemoteTrigger>("PATCH", `/triggers/${id}`, updates);
  }

  /**
   * Delete a trigger.
   */
  async deleteTrigger(id: string): Promise<void> {
    await this.request<void>("DELETE", `/triggers/${id}`);
  }

  /**
   * Manually run a trigger immediately.
   */
  async runTrigger(id: string): Promise<TriggerRunResult> {
    return this.request<TriggerRunResult>("POST", `/triggers/${id}/run`);
  }

  /**
   * Get execution history for a trigger.
   */
  async getTriggerHistory(id: string, limit?: number): Promise<TriggerRunResult[]> {
    const query = limit != null ? `?limit=${limit}` : "";
    return this.request<TriggerRunResult[]>("GET", `/triggers/${id}/history${query}`);
  }

  /**
   * Internal HTTP helper. Attaches auth header and handles errors.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new TriggerApiError(
        0,
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const errorBody = await response.json();
        if (errorBody && typeof errorBody === "object" && "error" in errorBody) {
          message = String((errorBody as { error: string }).error);
        }
      } catch {
        // ignore parse errors
      }
      throw new TriggerApiError(response.status, message);
    }

    // DELETE typically returns 204 with no body
    if (response.status === 204 || method === "DELETE") {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
