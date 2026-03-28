// KCode - Plugin Registry
// Install plugins from the official registry or GitHub

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";
const REGISTRY_URL = "https://registry.kulvex.ai/plugins";

export interface RegistryEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  url: string; // git clone URL or tarball
  tags: string[];
}

/**
 * Fetch the plugin registry index.
 * Falls back to a bundled list if the network is unavailable.
 */
export async function fetchRegistry(): Promise<RegistryEntry[]> {
  try {
    const resp = await fetch(REGISTRY_URL + "/index.json", {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) return (await resp.json()) as RegistryEntry[];
  } catch { /* offline */ }

  // Bundled fallback — a few example plugins
  return [
    { name: "git-hooks", description: "Pre-commit and post-push automation", version: "1.0.0", author: "Astrolexis", url: "https://github.com/Astrolexis/kcode-plugin-git-hooks", tags: ["git", "automation"] },
    { name: "docker", description: "Docker container management tools", version: "1.0.0", author: "Astrolexis", url: "https://github.com/Astrolexis/kcode-plugin-docker", tags: ["docker", "devops"] },
    { name: "database", description: "SQL query tools for PostgreSQL, MySQL, SQLite", version: "1.0.0", author: "Astrolexis", url: "https://github.com/Astrolexis/kcode-plugin-database", tags: ["sql", "database"] },
    { name: "kubernetes", description: "Kubernetes cluster management", version: "0.9.0", author: "Astrolexis", url: "https://github.com/Astrolexis/kcode-plugin-kubernetes", tags: ["k8s", "devops"] },
    { name: "terraform", description: "Terraform plan/apply integration", version: "0.9.0", author: "Astrolexis", url: "https://github.com/Astrolexis/kcode-plugin-terraform", tags: ["terraform", "iac"] },
  ];
}

/**
 * Search registry entries by name or tag.
 */
export function searchRegistry(entries: RegistryEntry[], query: string): RegistryEntry[] {
  const q = query.toLowerCase();
  return entries.filter(e =>
    e.name.includes(q) || e.description.toLowerCase().includes(q) || e.tags.some(t => t.includes(q))
  );
}

/**
 * Install a plugin by name from the registry.
 */
export async function installPlugin(name: string): Promise<{ success: boolean; message: string }> {
  const entries = await fetchRegistry();
  const entry = entries.find(e => e.name === name);
  if (!entry) return { success: false, message: `Plugin "${name}" not found in registry.` };

  const pluginDir = join(kcodePath("plugins"), name);
  if (existsSync(pluginDir)) {
    return { success: false, message: `Plugin "${name}" is already installed at ${pluginDir}` };
  }

  // Clone the plugin repo
  if (!existsSync(kcodePath("plugins"))) mkdirSync(kcodePath("plugins"), { recursive: true });

  try {
    const proc = Bun.spawnSync(["git", "clone", "--depth", "1", entry.url, pluginDir]);
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString();
      return { success: false, message: `Failed to clone: ${stderr}` };
    }
    log.info("plugins", `Installed plugin: ${name} v${entry.version}`);
    return { success: true, message: `Installed "${name}" v${entry.version} to ${pluginDir}` };
  } catch (err) {
    return { success: false, message: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Uninstall a plugin by name.
 */
export async function uninstallPlugin(name: string): Promise<{ success: boolean; message: string }> {
  const pluginDir = join(kcodePath("plugins"), name);
  if (!existsSync(pluginDir)) {
    return { success: false, message: `Plugin "${name}" is not installed.` };
  }

  try {
    const { rmSync } = await import("node:fs");
    rmSync(pluginDir, { recursive: true, force: true });
    log.info("plugins", `Uninstalled plugin: ${name}`);
    return { success: true, message: `Uninstalled "${name}"` };
  } catch (err) {
    return { success: false, message: `Uninstall failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
