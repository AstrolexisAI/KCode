// KCode - Configuration Health Check

import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../logger";
import { kcodeHome } from "../../paths";
import type { HealthCheck } from "../health-score";

export async function checkConfig(): Promise<HealthCheck> {
  const settingsPath = join(kcodeHome(), "settings.json");

  if (!existsSync(settingsPath)) {
    return {
      name: "Config",
      category: "config",
      status: "pass",
      message: "No user settings (using defaults)",
      weight: 5,
    };
  }

  try {
    const file = Bun.file(settingsPath);
    const settings = await file.json();

    // Check for deprecated fields
    const deprecated = ["oldField", "legacyMode"];
    const found = deprecated.filter((d) => d in settings);
    if (found.length > 0) {
      return {
        name: "Config",
        category: "config",
        status: "warn",
        message: `Deprecated fields: ${found.join(", ")}`,
        fix: `Remove deprecated fields from ${settingsPath}`,
        weight: 5,
      };
    }

    return {
      name: "Config",
      category: "config",
      status: "pass",
      message: "Configuration valid",
      weight: 5,
    };
  } catch (err) {
    log.debug("doctor/config-check", `Error: ${err}`);
    return {
      name: "Config",
      category: "config",
      status: "fail",
      message: `${settingsPath} is not valid JSON`,
      fix: `Fix JSON syntax in ${settingsPath}`,
      weight: 5,
    };
  }
}
