// KCode - Plugin Health Check

import { log } from "../../logger";
import type { HealthCheck } from "../health-score";

export async function checkPlugins(): Promise<HealthCheck> {
  try {
    const { PluginManager } = await import("../../plugin-manager");
    const pm = new PluginManager();
    const plugins = await pm.list();

    if (plugins.length === 0) {
      return { name: "Plugins", category: "plugin", status: "pass", message: "No plugins installed", weight: 3 };
    }

    let errors = 0;
    const errorNames: string[] = [];
    for (const p of plugins) {
      const manifest = (p as unknown as Record<string, unknown>).manifest as typeof p ?? p;
      if (!manifest.name || !manifest.version) {
        errors++;
        errorNames.push(String(manifest.name ?? "unknown"));
      }
    }

    if (errors > 0) {
      return {
        name: "Plugins",
        category: "plugin",
        status: "warn",
        message: `${errors} plugin(s) with issues: ${errorNames.join(", ")}`,
        fix: `Run \`kcode plugin update\` or remove broken plugins`,
        weight: 3,
      };
    }

    return {
      name: "Plugins",
      category: "plugin",
      status: "pass",
      message: `${plugins.length} plugin(s) healthy`,
      weight: 3,
    };
  } catch (err) {
    log.debug("doctor/plugin-check", `Error: ${err}`);
    return { name: "Plugins", category: "plugin", status: "pass", message: "Plugin system not initialized", weight: 3 };
  }
}
