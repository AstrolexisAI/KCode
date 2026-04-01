// KCode - Storage Health Check

import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { kcodeHome } from "../../paths";
import { log } from "../../logger";
import type { HealthCheck } from "../health-score";

async function dirSizeBytes(path: string): Promise<number> {
  try {
    const proc = Bun.spawn(["du", "-sb", path], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) return 0;
    const output = await new Response(proc.stdout).text();
    const bytes = parseInt(output.split("\t")[0]!, 10);
    return isNaN(bytes) ? 0 : bytes;
  } catch { return 0; }
}

export async function checkStorage(): Promise<HealthCheck> {
  const kcodeDir = kcodeHome();

  if (!existsSync(kcodeDir)) {
    return { name: "Storage", category: "storage", status: "pass", message: "~/.kcode/ not created yet (0MB)", weight: 5 };
  }

  try {
    accessSync(kcodeDir, constants.W_OK);
  } catch {
    return {
      name: "Storage",
      category: "storage",
      status: "fail",
      message: `${kcodeDir} is not writable`,
      fix: `Fix permissions: chmod u+w ${kcodeDir}`,
      weight: 5,
    };
  }

  const bytes = await dirSizeBytes(kcodeDir);
  const mb = bytes / (1024 * 1024);

  // Check DB size specifically
  const dbPath = join(kcodeDir, "awareness.db");
  let dbMb = 0;
  if (existsSync(dbPath)) {
    const dbBytes = await dirSizeBytes(dbPath);
    dbMb = dbBytes / (1024 * 1024);
  }

  if (mb > 1000) {
    return {
      name: "Storage",
      category: "storage",
      status: "warn",
      message: `~/.kcode/ is ${mb.toFixed(0)}MB (DB: ${dbMb.toFixed(0)}MB)`,
      fix: "Run `kcode db vacuum` and clean old transcripts/logs",
      weight: 5,
    };
  }

  if (dbMb > 500) {
    return {
      name: "Storage",
      category: "storage",
      status: "warn",
      message: `DB awareness.db: ${dbMb.toFixed(0)}MB (>500MB recommended)`,
      fix: "Run `kcode db vacuum` to reduce database size",
      weight: 5,
    };
  }

  return {
    name: "Storage",
    category: "storage",
    status: "pass",
    message: `~/.kcode/ is ${mb.toFixed(1)}MB`,
    weight: 5,
  };
}
