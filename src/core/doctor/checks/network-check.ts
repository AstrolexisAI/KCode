// KCode - Network Connectivity Health Check

import { log } from "../../logger";
import type { HealthCheck } from "../health-score";

export async function checkNetwork(): Promise<HealthCheck> {
  try {
    const { getDefaultModel, getModelBaseUrl } = await import("../../models");
    const defaultModel = await getDefaultModel();
    const baseUrl = await getModelBaseUrl(defaultModel);

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timeout);
    const latency = Date.now() - start;

    if (response.ok) {
      return {
        name: "Network",
        category: "network",
        status: "pass",
        message: `API reachable (${latency}ms)`,
        weight: 3,
      };
    }

    return {
      name: "Network",
      category: "network",
      status: "warn",
      message: `API returned HTTP ${response.status} (${latency}ms)`,
      weight: 3,
    };
  } catch (err: any) {
    const reason = err?.name === "AbortError" ? "timed out (5s)" : (err?.message ?? "unreachable");
    log.debug("doctor/network-check", `Error: ${reason}`);
    return {
      name: "Network",
      category: "network",
      status: "fail",
      message: `API unreachable — ${reason}`,
      fix: "Check your network connection or API base URL in settings",
      weight: 3,
    };
  }
}
