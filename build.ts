#!/usr/bin/env bun
// KCode - Build Script
// Compiles KCode into a standalone binary using Bun's --compile flag
//
// Usage:
//   bun run build.ts              # Production build (minified)
//   bun run build.ts --dev        # Dev build (no minification)
//
// NOTE ON BINARY SIZE:
//   The compiled binary is ~101 MB. This is overwhelmingly the embedded Bun runtime
//   (~99 MB), NOT the application code (~2 MB bundled JS). This is a known limitation
//   of `bun build --compile`. strip and UPX both corrupt Bun compiled binaries.
//   For a lightweight alternative, use:
//     bun run src/index.ts
//   which reuses the system-installed Bun runtime (0 MB overhead).

import { join } from "node:path";
import { homedir } from "node:os";
import pkg from "./package.json";
import { getDefinesForProfile, getAvailableProfiles, describeProfile } from "./src/core/feature-flags/build-defines";

const ENTRY = "src/index.ts";
const OUT_DIR = "dist";
const OUT_FILE = join(OUT_DIR, "kcode");

const args = process.argv.slice(2);
const isDev = args.includes("--dev");
const minify = !isDev;

// Build profile: --profile=minimal|free|full (default: full)
const profileArg = args.find(a => a.startsWith("--profile="));
const buildProfile = profileArg?.split("=")[1] ?? "full";
if (args.includes("--list-profiles")) {
  for (const p of getAvailableProfiles()) {
    console.log(describeProfile(p));
    console.log();
  }
  process.exit(0);
}

async function build() {
  const startTime = performance.now();

  // Ensure output directory exists
  await Bun.$`mkdir -p ${OUT_DIR}`;

  const enabledFlags = Object.entries(getDefinesForProfile(buildProfile))
    .filter(([, v]) => v === "true")
    .map(([k]) => k.replace(/__FEATURE_|__/g, "").toLowerCase());
  const disabledFlags = Object.entries(getDefinesForProfile(buildProfile))
    .filter(([, v]) => v === "false")
    .map(([k]) => k.replace(/__FEATURE_|__/g, "").toLowerCase());

  console.log(`\nBuilding KCode v${pkg.version} standalone binary...`);
  console.log(`  Entry:        ${ENTRY}`);
  console.log(`  Output:       ${OUT_FILE}`);
  console.log(`  Profile:      ${buildProfile}`);
  console.log(`  Minification: ${minify ? "enabled" : "disabled (dev)"}`);
  console.log(`  Features ON:  ${enabledFlags.join(", ") || "none"}`);
  console.log(`  Features OFF: ${disabledFlags.join(", ") || "none"}`);
  console.log();

  try {
    // Build the standalone binary
    // --sourcemap=none: Ensure no source maps are embedded
    // --minify: Minify the bundled JS (saves ~1.4 MB)
    // --define: Build-time feature flags for dead code elimination (DCE)
    const defines = getDefinesForProfile(buildProfile);
    const featureDefines = Object.entries(defines).map(
      ([key, value]) => `--define:${key}=${value}`,
    );

    let proc;
    if (minify) {
      proc = await Bun.$`bun build ${ENTRY} --compile --minify --sourcemap=none ${featureDefines} --outfile ${OUT_FILE}`.quiet();
    } else {
      proc = await Bun.$`bun build ${ENTRY} --compile --sourcemap=none ${featureDefines} --outfile ${OUT_FILE}`.quiet();
    }

    if (proc.exitCode !== 0) {
      console.error(`Build failed with exit code ${proc.exitCode}`);
      console.error(proc.stderr.toString());
      process.exit(proc.exitCode);
    }

    // Print compile output
    const stdout = proc.stdout.toString().trim();
    if (stdout) console.log(stdout);

    // Report build info
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    const finalSize = Bun.file(OUT_FILE).size;
    const sizeMB = (finalSize / (1024 * 1024)).toFixed(1);
    const sizeKB = Math.round(finalSize / 1024);
    const timestamp = new Date().toISOString();

    console.log();
    console.log(`Build complete!`);
    console.log(`  Version:   ${pkg.version}`);
    console.log(`  Binary:    ${OUT_FILE}`);
    console.log(`  Size:      ${sizeMB} MB (${sizeKB} KB)`);
    console.log(`  Time:      ${elapsed}s`);
    console.log(`  Timestamp: ${timestamp}`);
    console.log();
    console.log(`  Note: ~99 MB is the embedded Bun runtime. For a lightweight`);
    console.log(`  alternative, use: bun run src/index.ts (0 MB overhead)`);
    console.log();

    // Deploy to install locations (rm -f first to avoid "text file busy")
    if (!isDev) {
      const targets = [
        join(homedir(), ".bun", "bin", "kcode"),
        join(homedir(), ".local", "bin", "kcode"),
        join(import.meta.dir, "release", "kcode"),
      ];
      console.log(`Deploying to ${targets.length} locations...`);
      for (const target of targets) {
        try {
          await Bun.$`rm -f ${target} && cp ${OUT_FILE} ${target}`.quiet();
          console.log(`  ✓ ${target}`);
        } catch {
          console.log(`  ✗ ${target} (skipped)`);
        }
      }
      console.log();
    }
  } catch (err) {
    console.error("Build error:", err);
    process.exit(1);
  }
}

build();
