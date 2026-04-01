// KCode - Runtime Health Check

import type { HealthCheck } from "../health-score";

export async function checkRuntime(): Promise<HealthCheck> {
  const bunVersion = Bun.version;
  const [major, minor] = bunVersion.split(".").map(Number);

  if ((major ?? 0) >= 1 && (minor ?? 0) >= 2) {
    return {
      name: "Bun Runtime",
      category: "runtime",
      status: "pass",
      message: `Bun ${bunVersion}`,
      weight: 10,
    };
  }

  return {
    name: "Bun Runtime",
    category: "runtime",
    status: "warn",
    message: `Bun ${bunVersion} (recommended >=1.2)`,
    fix: "Update Bun: curl -fsSL https://bun.sh/install | bash",
    weight: 10,
  };
}
