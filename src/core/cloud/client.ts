// KCode - Cloud API Client
// Manages authentication, team operations, and HTTP communication with cloud.kulvex.ai

import { join } from "node:path";
import { log } from "../logger";
import type {
  CloudAuthResult,
  CloudTeam,
  KCodeCloudConfig,
  TeamAnalytics,
  TeamPolicies,
} from "./types";

const DEFAULT_CLOUD_URL = "https://cloud.kulvex.ai";

export class CloudClientError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: string,
  ) {
    super(message);
    this.name = "CloudClientError";
  }
}

/**
 * Read cloud configuration from ~/.kcode/settings.json.
 * Uses Bun.file() instead of node:fs per project conventions.
 */
async function loadCloudConfigFromSettings(): Promise<KCodeCloudConfig | null> {
  try {
    const { kcodeHome } = await import("../paths");
    const settingsPath = join(kcodeHome(), "settings.json");
    const file = Bun.file(settingsPath);
    if (!(await file.exists())) return null;
    const settings = await file.json();
    if (!settings.cloudConfig) return null;
    return settings.cloudConfig as KCodeCloudConfig;
  } catch {
    return null;
  }
}

/**
 * Write cloud configuration back to ~/.kcode/settings.json,
 * merging with existing settings.
 */
async function saveCloudConfigToSettings(config: KCodeCloudConfig): Promise<void> {
  try {
    const { kcodeHome } = await import("../paths");
    const settingsPath = join(kcodeHome(), "settings.json");
    const file = Bun.file(settingsPath);
    let settings: Record<string, unknown> = {};
    if (await file.exists()) {
      settings = await file.json();
    }
    settings.cloudConfig = config;
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch (err) {
    log.debug("cloud", `Failed to save cloud config: ${err}`);
    throw new Error("Failed to save cloud configuration");
  }
}

export class CloudClient {
  private config: KCodeCloudConfig | null;
  private configLoaded: boolean;

  constructor(config?: KCodeCloudConfig) {
    this.config = config ?? null;
    this.configLoaded = !!config;
  }

  /**
   * Ensure config is loaded from settings if not provided in constructor.
   */
  private async ensureConfig(): Promise<KCodeCloudConfig> {
    if (!this.configLoaded) {
      this.config = await loadCloudConfigFromSettings();
      this.configLoaded = true;
    }
    if (!this.config) {
      throw new Error("Cloud is not configured. Run `kcode cloud login` to set up your account.");
    }
    return this.config;
  }

  /**
   * Check if cloud configuration exists (either provided or in settings).
   */
  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Returns the current cloud config, or null if not configured.
   */
  getConfig(): KCodeCloudConfig | null {
    return this.config;
  }

  /**
   * Authenticate with the cloud service. Stores the resulting token
   * and team ID in ~/.kcode/settings.json.
   */
  async login(email: string, password: string): Promise<CloudAuthResult> {
    const baseUrl = this.config?.url ?? DEFAULT_CLOUD_URL;

    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) {
        throw new CloudClientError("Invalid email or password", 401, body);
      }
      throw new CloudClientError(`Login failed (HTTP ${response.status})`, response.status, body);
    }

    const result: CloudAuthResult = await response.json();

    // Store the config with the new token
    const newConfig: KCodeCloudConfig = {
      url: baseUrl,
      token: result.token,
      teamId: result.teamId,
      features: {
        sessionSync: true,
        sharedMemory: true,
        analytics: true,
        policies: true,
        audit: true,
      },
    };

    await saveCloudConfigToSettings(newConfig);
    this.config = newConfig;
    this.configLoaded = true;

    log.debug("cloud", `Logged in successfully, team: ${result.teamId}`);
    return result;
  }

  /**
   * Get current team information including members, plan, and usage.
   */
  async getTeam(): Promise<CloudTeam> {
    const config = await this.ensureConfig();
    return this.request<CloudTeam>("GET", `/api/v1/teams/${config.teamId}`);
  }

  /**
   * Invite a new member to the team.
   */
  async inviteMember(email: string, role: "admin" | "member" = "member"): Promise<void> {
    const config = await this.ensureConfig();
    await this.request("POST", `/api/v1/teams/${config.teamId}/members`, {
      email,
      role,
    });
    log.debug("cloud", `Invited ${email} as ${role}`);
  }

  /**
   * Remove a member from the team.
   */
  async removeMember(memberId: string): Promise<void> {
    const config = await this.ensureConfig();
    await this.request("DELETE", `/api/v1/teams/${config.teamId}/members/${memberId}`);
    log.debug("cloud", `Removed member ${memberId}`);
  }

  /**
   * Get team analytics for the specified period.
   */
  async getAnalytics(period: "day" | "week" | "month"): Promise<TeamAnalytics> {
    const config = await this.ensureConfig();
    return this.request<TeamAnalytics>(
      "GET",
      `/api/v1/teams/${config.teamId}/analytics?period=${period}`,
    );
  }

  /**
   * Get the team's current policies.
   */
  async getPolicies(): Promise<TeamPolicies> {
    const config = await this.ensureConfig();
    return this.request<TeamPolicies>("GET", `/api/v1/teams/${config.teamId}/policies`);
  }

  /**
   * Update team policies (partial update supported).
   */
  async updatePolicies(policies: Partial<TeamPolicies>): Promise<void> {
    const config = await this.ensureConfig();
    await this.request("PATCH", `/api/v1/teams/${config.teamId}/policies`, policies);
    log.debug("cloud", "Team policies updated");
  }

  /**
   * Base HTTP helper. Handles authentication headers, JSON
   * serialization, and error responses.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const config = await this.ensureConfig();
    const url = `${config.url}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "User-Agent": "kcode-cli",
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new Error(
        `Cloud API request failed: unable to connect to ${config.url}. ` +
          `Check your network connection.`,
      );
    }

    if (!response.ok) {
      const responseBody = await response.text();
      let message = `Cloud API error (HTTP ${response.status})`;

      if (response.status === 401) {
        message = "Authentication expired or invalid. Run `kcode cloud login` to re-authenticate.";
      } else if (response.status === 403) {
        message = "Permission denied. You may not have access to this resource.";
      } else if (response.status === 404) {
        message = `Resource not found: ${path}`;
      } else if (response.status === 429) {
        message = "Rate limit exceeded. Please try again later.";
      } else if (response.status >= 500) {
        message = `Cloud service error (HTTP ${response.status}). Please try again later.`;
      }

      throw new CloudClientError(message, response.status, responseBody);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}
