// KCode - Plugin Publisher
// Validates, tests, packages, and uploads plugins to the marketplace.

import { join, basename } from "node:path";
import { readFileSync } from "node:fs";
import type { PublishResult, PluginManifest } from "../../../core/plugin-sdk/types";
import { validatePlugin } from "./validate";
import { testPlugin } from "./test-runner";

const DEFAULT_REGISTRY = "https://marketplace.kulvex.ai/api/v1";

export async function publishPlugin(
  dir: string,
  registry?: string,
): Promise<PublishResult> {
  const registryUrl = registry || DEFAULT_REGISTRY;

  // 1. Validate plugin
  console.log("  Validating plugin...");
  const validation = await validatePlugin(dir);
  if (!validation.valid) {
    const errorMsgs = validation.errors.map((e) => e.message).join("\n  ");
    throw new Error(`Plugin validation failed:\n  ${errorMsgs}`);
  }

  // 2. Run tests
  console.log("  Running tests...");
  const tests = await testPlugin(dir);
  const failed = tests.filter((t) => t.status === "fail");
  if (failed.length > 0) {
    const failedNames = failed.map((t) => `${t.name}: ${t.error}`).join("\n  ");
    throw new Error(`${failed.length} tests failed:\n  ${failedNames}`);
  }

  // 3. Load manifest
  const manifest = JSON.parse(
    readFileSync(join(dir, "plugin.json"), "utf-8"),
  ) as PluginManifest;

  // 4. Create tarball
  console.log("  Creating package...");
  const tarballPath = await createTarball(dir, manifest);

  // 5. Compute SHA256
  const tarballContent = readFileSync(tarballPath);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(tarballContent)
    .digest("hex");

  // 6. Upload
  console.log(`  Publishing ${manifest.name}@${manifest.version}...`);
  const token = getAuthToken();
  if (!token) {
    throw new Error(
      "No auth token found. Set KCODE_AUTH_TOKEN or configure proKey in settings.",
    );
  }

  const response = await fetch(`${registryUrl}/plugins`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Plugin-Name": manifest.name,
      "X-Plugin-Version": manifest.version,
      "X-Plugin-SHA256": sha256,
      Authorization: `Bearer ${token}`,
    },
    body: tarballContent,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Publish failed (${response.status}): ${body}`);
  }

  console.log(`  \u2713 Published ${manifest.name}@${manifest.version}`);

  return {
    name: manifest.name,
    version: manifest.version,
    sha256,
  };
}

export function getAuthToken(): string | null {
  // 1. Environment variable
  if (process.env.KCODE_AUTH_TOKEN) {
    return process.env.KCODE_AUTH_TOKEN;
  }

  // 2. Settings file
  try {
    const { join: pjoin } = require("node:path");
    const { homedir } = require("node:os");
    const settingsPath = pjoin(homedir(), ".kcode", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (settings.proKey) return settings.proKey;
  } catch { /* no settings */ }

  return null;
}

async function createTarball(
  dir: string,
  manifest: PluginManifest,
): Promise<string> {
  const tarballName = `${manifest.name}-${manifest.version}.tar.gz`;
  const tarballPath = join(dir, tarballName);

  const result = Bun.spawnSync(
    [
      "tar",
      "czf",
      tarballPath,
      "--exclude=node_modules",
      "--exclude=.git",
      "--exclude=*.tar.gz",
      "-C",
      dir,
      ".",
    ],
    { timeout: 30_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create tarball: ${result.stderr.toString()}`,
    );
  }

  return tarballPath;
}

export async function dryRunPublish(dir: string): Promise<{
  manifest: PluginManifest;
  validation: Awaited<ReturnType<typeof validatePlugin>>;
  testResults: Awaited<ReturnType<typeof testPlugin>>;
  sha256: string;
  size: number;
}> {
  const validation = await validatePlugin(dir);
  const testResults = await testPlugin(dir);
  const manifest = JSON.parse(
    readFileSync(join(dir, "plugin.json"), "utf-8"),
  ) as PluginManifest;

  const tarballPath = await createTarball(dir, manifest);
  const tarballContent = readFileSync(tarballPath);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(tarballContent)
    .digest("hex");

  // Clean up tarball
  const { unlinkSync } = require("node:fs");
  try {
    unlinkSync(tarballPath);
  } catch { /* ok */ }

  return {
    manifest,
    validation,
    testResults,
    sha256,
    size: tarballContent.length,
  };
}
