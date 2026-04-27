#!/usr/bin/env bun

import { $ } from "bun";

await $`rm -rf dist`.nothrow();
await $`bun build src/index.ts --compile --outfile dist/kulsh`;

console.log("✅ Built successfully: ./dist/kulsh");
console.log("Run with: ./dist/kulsh");