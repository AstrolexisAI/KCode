// KCode - Plugin Test Runner
// Runs automated tests against a plugin to verify integrity.

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { PluginTestResult, PluginManifest } from "../../../core/plugin-sdk/types";

export async function testPlugin(dir: string): Promise<PluginTestResult[]> {
  const results: PluginTestResult[] = [];
  const manifest = loadManifest(dir);

  if (!manifest) {
    results.push({
      name: "manifest-load",
      status: "fail",
      duration: 0,
      error: "Could not load plugin.json",
    });
    return results;
  }

  // Test 1: Manifest loads and has required fields
  results.push(
    await runTest("manifest-load", async () => {
      if (!manifest.name) throw new Error("name is required");
      if (!manifest.version) throw new Error("version is required");
      if (!manifest.description) throw new Error("description is required");
    }),
  );

  // Test 2: Manifest version is semver
  results.push(
    await runTest("manifest-version", async () => {
      if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
        throw new Error(`Invalid version: ${manifest.version}`);
      }
    }),
  );

  // Test 3: Skills parse correctly
  if (manifest.skills) {
    for (const pattern of manifest.skills) {
      const files = findFiles(dir, pattern);
      for (const file of files) {
        results.push(
          await runTest(`skill-parse:${file}`, async () => {
            const content = readFileSync(join(dir, file), "utf-8");
            const fm = parseFrontmatter(content);
            if (!fm) throw new Error("Missing frontmatter");
            if (!fm.name) throw new Error("Missing 'name' in frontmatter");
            if (!fm.description) throw new Error("Missing 'description' in frontmatter");
          }),
        );
      }
    }
  }

  // Test 4: Agents parse correctly
  if (manifest.agents) {
    for (const pattern of manifest.agents) {
      const files = findFiles(dir, pattern);
      for (const file of files) {
        results.push(
          await runTest(`agent-parse:${file}`, async () => {
            const content = readFileSync(join(dir, file), "utf-8");
            const fm = parseFrontmatter(content);
            if (!fm) throw new Error("Missing frontmatter");
            if (!fm.name) throw new Error("Missing 'name' in frontmatter");
          }),
        );
      }
    }
  }

  // Test 5: Hook commands exist (dry run)
  if (manifest.hooks) {
    for (const [event, handlers] of Object.entries(manifest.hooks)) {
      if (!Array.isArray(handlers)) continue;
      for (let i = 0; i < handlers.length; i++) {
        const hook = handlers[i];
        results.push(
          await runTest(`hook-dryrun:${event}[${i}]`, async () => {
            if (!hook.command && !hook.action) {
              throw new Error("Hook missing command or action");
            }
            if (hook.command) {
              const which = Bun.spawnSync(["which", hook.command]);
              if (which.exitCode !== 0) {
                throw new Error(`Command not found: ${hook.command}`);
              }
            }
          }),
        );
      }
    }
  }

  // Test 6: MCP servers have valid command
  if (manifest.mcpServers) {
    for (const [name, config] of Object.entries(manifest.mcpServers)) {
      results.push(
        await runTest(`mcp-config:${name}`, async () => {
          if (!config.command) {
            throw new Error(`MCP server '${name}' missing command`);
          }
        }),
      );
    }
  }

  // Test 7: User-defined tests
  if (existsSync(join(dir, "tests"))) {
    results.push(
      await runTest("user-tests", async () => {
        const result = Bun.spawnSync(["bun", "test"], {
          cwd: dir,
          timeout: 30_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `Tests failed (exit ${result.exitCode}):\n${result.stderr.toString().slice(0, 500)}`,
          );
        }
      }),
    );
  } else {
    results.push({
      name: "user-tests",
      status: "skip",
      duration: 0,
      error: "No tests/ directory found",
    });
  }

  return results;
}

export function formatTestResults(results: PluginTestResult[]): string {
  const lines: string[] = [];
  const passed = results.filter((r) => r.status === "pass");
  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");

  for (const r of results) {
    const icon =
      r.status === "pass" ? "\u2713" : r.status === "fail" ? "\u2717" : "\u25cb";
    const time = r.duration > 0 ? ` (${r.duration}ms)` : "";
    lines.push(`  ${icon} ${r.name}${time}`);
    if (r.error && r.status === "fail") {
      lines.push(`    ${r.error}`);
    }
  }

  lines.push("");
  lines.push(
    `  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
  );

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<PluginTestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, status: "pass", duration: Date.now() - start };
  } catch (err: any) {
    return {
      name,
      status: "fail",
      duration: Date.now() - start,
      error: err.message || String(err),
    };
  }
}

function loadManifest(dir: string): PluginManifest | null {
  try {
    const raw = readFileSync(join(dir, "plugin.json"), "utf-8");
    return JSON.parse(raw) as PluginManifest;
  } catch {
    return null;
  }
}

function findFiles(dir: string, pattern: string): string[] {
  const parts = pattern.split("/");
  const dirPart = parts.slice(0, -1).join("/");
  const filePart = parts[parts.length - 1];
  const targetDir = join(dir, dirPart);

  if (!existsSync(targetDir)) return [];

  try {
    const entries = readdirSync(targetDir);
    const regex = new RegExp(
      "^" + filePart.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    );
    return entries
      .filter((e) => regex.test(e))
      .map((e) => (dirPart ? `${dirPart}/${e}` : e));
  } catch {
    return [];
  }
}

function parseFrontmatter(
  content: string,
): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return fields;
}
