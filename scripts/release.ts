#!/usr/bin/env bun
// KCode - Cross-platform release builder
// Builds standalone binaries for Linux, macOS, and Windows
//
// Usage:
//   bun run scripts/release.ts              # Build all platforms
//   bun run scripts/release.ts --linux      # Linux only
//   bun run scripts/release.ts --macos      # macOS only
//   bun run scripts/release.ts --windows    # Windows only

import { join } from "node:path";
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import pkg from "../package.json";

const ENTRY = "src/index.ts";
const RELEASE_DIR = "release";
const VERSION = pkg.version;

interface Target {
  name: string;
  target: string;
  outFile: string;
  flag: string;
  windowsOpts?: string[];
}

const TARGETS: Target[] = [
  {
    name: "Linux x64",
    target: "bun-linux-x64",
    outFile: `kcode-${VERSION}-linux-x64`,
    flag: "--linux",
  },
  {
    name: "Linux ARM64",
    target: "bun-linux-arm64",
    outFile: `kcode-${VERSION}-linux-arm64`,
    flag: "--linux",
  },
  {
    name: "macOS x64 (Intel)",
    target: "bun-darwin-x64",
    outFile: `kcode-${VERSION}-macos-x64`,
    flag: "--macos",
  },
  {
    name: "macOS ARM64 (Apple Silicon)",
    target: "bun-darwin-arm64",
    outFile: `kcode-${VERSION}-macos-arm64`,
    flag: "--macos",
  },
  {
    name: "Windows x64",
    target: "bun-windows-x64",
    outFile: `kcode-${VERSION}-windows-x64.exe`,
    flag: "--windows",
    // --windows-* flags only work when compiling ON Windows natively
    // When building on Windows, add: --windows-hide-console --windows-title=KCode etc.
  },
];

async function buildTarget(t: Target): Promise<{ ok: boolean; size: string; time: string }> {
  const outPath = join(RELEASE_DIR, t.outFile);
  const start = performance.now();

  try {
    const args = [
      "build", ENTRY,
      "--compile",
      "--minify",
      "--sourcemap=none",
      `--target=${t.target}`,
      `--outfile=${outPath}`,
      ...(t.windowsOpts ?? []),
    ];

    const bunBin = process.execPath; // use the same bun that's running this script
    const proc = Bun.spawnSync([bunBin, ...args], { stdout: "pipe", stderr: "pipe" });

    if (proc.exitCode !== 0) {
      const err = proc.stderr.toString().trim();
      console.error(`    FAILED: ${err.slice(0, 200)}`);
      return { ok: false, size: "-", time: "-" };
    }

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    const file = Bun.file(outPath);
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);

    return { ok: true, size: `${sizeMB} MB`, time: `${elapsed}s` };
  } catch (err) {
    console.error(`    ERROR: ${err}`);
    return { ok: false, size: "-", time: "-" };
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const buildAll = args.size === 0;

  // Filter targets based on flags
  const targets = TARGETS.filter((t) => {
    if (buildAll) return true;
    return args.has(t.flag);
  });

  if (targets.length === 0) {
    console.log("Usage: bun run scripts/release.ts [--linux] [--macos] [--windows]");
    process.exit(1);
  }

  // Ensure release directory exists
  if (!existsSync(RELEASE_DIR)) mkdirSync(RELEASE_DIR, { recursive: true });

  console.log(`\nKCode v${VERSION} — Release Build`);
  console.log(`Building ${targets.length} target(s)...\n`);

  const results: { name: string; ok: boolean; size: string; time: string }[] = [];

  for (const t of targets) {
    process.stdout.write(`  ${t.name.padEnd(28)} `);
    const result = await buildTarget(t);
    results.push({ name: t.name, ...result });
    if (result.ok) {
      console.log(`${result.size.padStart(8)}  ${result.time.padStart(6)}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log(`\nDone: ${passed} built${failed > 0 ? `, ${failed} failed` : ""}`);
  console.log(`Output: ${RELEASE_DIR}/\n`);

  // List files
  const proc = Bun.spawnSync(["ls", "-lh", RELEASE_DIR], { stdout: "pipe" });
  console.log(proc.stdout.toString());

  if (failed > 0) process.exit(1);

  // v2.10.358 — generate latest.json manifest consumed by `kcode update`.
  // Computes SHA256 + size for each successfully-built binary, emits a
  // single JSON document, and copies it to the kulvex.ai serving dir.
  // This is what the running CLI talks to when checking for updates.
  if (passed > 0 && buildAll) {
    await generateManifest(targets, results);
  } else if (!buildAll) {
    console.log("(manifest skipped — partial build)\n");
  }
}

/**
 * Map our internal target names to the platform keys the CLI sends
 * when querying the manifest. The CLI computes its key from
 * `${process.platform}-${process.arch}`, so we mirror that exactly.
 */
const TARGET_TO_PLATFORM_KEY: Record<string, string> = {
  "Linux x64": "linux-x64",
  "Linux ARM64": "linux-arm64",
  "macOS x64 (Intel)": "darwin-x64",
  "macOS ARM64 (Apple Silicon)": "darwin-arm64",
  "Windows x64": "win32-x64",
};

interface ManifestPlatform {
  url: string;
  filename: string;
  sha256: string;
  size: number;
}

interface Manifest {
  schema_version: 1;
  latest: string;
  released_at: string;
  channels: { stable: string; beta?: string };
  platforms: Record<string, ManifestPlatform>;
  release_notes: string;
}

async function sha256(filePath: string): Promise<string> {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function generateManifest(
  targets: Target[],
  results: Array<{ name: string; ok: boolean }>,
): Promise<void> {
  const passedTargets = targets.filter((t) =>
    results.some((r) => r.name === t.name && r.ok),
  );

  const platforms: Record<string, ManifestPlatform> = {};
  for (const t of passedTargets) {
    const key = TARGET_TO_PLATFORM_KEY[t.name];
    if (!key) {
      console.log(`  (skipping ${t.name} — no platform key mapping)`);
      continue;
    }
    const filePath = join(RELEASE_DIR, t.outFile);
    if (!existsSync(filePath)) continue;
    const stat = statSync(filePath);
    const hash = await sha256(filePath);
    platforms[key] = {
      url: `https://kulvex.ai/downloads/kcode/${t.outFile}`,
      filename: t.outFile,
      sha256: hash,
      size: stat.size,
    };
  }

  const manifest: Manifest = {
    schema_version: 1,
    latest: VERSION,
    released_at: new Date().toISOString(),
    channels: { stable: VERSION },
    platforms,
    release_notes: `https://github.com/AstrolexisAI/KCode/releases/tag/v${VERSION}`,
  };

  // Write to release/ for the local diff record + push to kulvex serving.
  const localPath = join(RELEASE_DIR, "latest.json");
  writeFileSync(localPath, JSON.stringify(manifest, null, 2));

  // Mirror to /home/curly/kulvex-models/kcode/ which Cloudflare serves
  // at https://kulvex.ai/kcode/latest.json (and where the binaries
  // already live).
  const cdnDir = join(homedir(), "kulvex-models", "kcode");
  if (existsSync(cdnDir)) {
    const cdnPath = join(cdnDir, "latest.json");
    copyFileSync(localPath, cdnPath);
    console.log(`Manifest written:`);
    console.log(`  ${localPath}`);
    console.log(`  ${cdnPath}  (live)`);
  } else {
    console.log(`Manifest written: ${localPath}`);
    console.log(`  (CDN dir ${cdnDir} not found — copy manually)`);
  }
  console.log(`  ${Object.keys(platforms).length} platform(s), v${VERSION}\n`);
}

main();
