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
import { mkdirSync, existsSync } from "node:fs";
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
}

main();
