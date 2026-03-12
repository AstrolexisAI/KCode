#!/usr/bin/env bun
// KCode - Build Script
// Compiles KCode into a standalone binary using Bun's --compile flag

import { join } from "node:path";
import pkg from "./package.json";

const ENTRY = "src/index.ts";
const OUT_DIR = "dist";
const OUT_FILE = join(OUT_DIR, "kcode");

const isDev = process.argv.includes("--dev");
const minify = !isDev;

async function build() {
  const startTime = performance.now();

  // Ensure output directory exists
  await Bun.$`mkdir -p ${OUT_DIR}`;

  console.log(`\nBuilding KCode v${pkg.version} standalone binary...`);
  console.log(`  Entry:        ${ENTRY}`);
  console.log(`  Output:       ${OUT_FILE}`);
  console.log(`  Minification: ${minify ? "enabled" : "disabled (dev)"}`);
  console.log();

  try {
    // Bun.build() API does not support --compile for standalone binaries.
    // Use Bun.$ shell API to invoke `bun build --compile`.
    let proc;
    if (minify) {
      proc = await Bun.$`bun build ${ENTRY} --compile --minify --outfile ${OUT_FILE}`.quiet();
    } else {
      proc = await Bun.$`bun build ${ENTRY} --compile --outfile ${OUT_FILE}`.quiet();
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
    const outFile = Bun.file(OUT_FILE);
    const sizeMB = (outFile.size / (1024 * 1024)).toFixed(1);
    const timestamp = new Date().toISOString();

    console.log();
    console.log(`Build complete!`);
    console.log(`  Version:   ${pkg.version}`);
    console.log(`  Binary:    ${OUT_FILE}`);
    console.log(`  Size:      ${sizeMB} MB`);
    console.log(`  Time:      ${elapsed}s`);
    console.log(`  Timestamp: ${timestamp}`);
    console.log();
  } catch (err) {
    console.error("Build error:", err);
    process.exit(1);
  }
}

build();
