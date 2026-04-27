// KCode - `kcode grammars` subcommand (v2.10.339)
//
// Why this exists: the AST audit runner reads tree-sitter .wasm files
// from a small list of well-known directories. Two of them — bundled
// ./grammars next to the source, and bundled-via-Bun-compile inside
// the binary — are read-only and only work in their respective runtime
// modes. `~/.kcode/grammars/` is the persistent, runtime-mode-agnostic
// install location. This command copies the bundled grammars into it,
// so the compiled binary can do AST scans on a fresh machine without
// the user manually copying .wasm files around.
//
// Subcommands:
//   kcode grammars install [lang...]   copy bundled grammar(s) → ~/.kcode/grammars/
//   kcode grammars list                show what's bundled and what's installed
//   kcode grammars remove <lang>       delete an installed grammar

import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { BUNDLED_GRAMMARS, findBundledGrammar } from "../../core/audit-engine/ast/grammars-bundled";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function installDir(): string {
  return join(homedir(), ".kcode", "grammars");
}

async function copyBundledTo(srcPath: string, destPath: string): Promise<number> {
  // Bun.file works on both real filesystem paths and the virtual paths
  // that `bun build --compile` exposes for embedded assets.
  const bytes = await Bun.file(srcPath).arrayBuffer();
  await Bun.write(destPath, bytes);
  return bytes.byteLength;
}

async function installCmd(langs: string[]): Promise<void> {
  const dir = installDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const targets =
    langs.length === 0
      ? BUNDLED_GRAMMARS.slice()
      : langs.map((l) => {
          const g = findBundledGrammar(l);
          if (!g) {
            console.error(`${RED}✗${RESET} no bundled grammar for "${l}".`);
            console.error(
              `  Bundled: ${BUNDLED_GRAMMARS.map((b) => b.language).join(", ") || "(none)"}`,
            );
            process.exit(1);
          }
          return g;
        });

  let installed = 0;
  let skipped = 0;
  for (const g of targets) {
    const dest = join(dir, g.filename);
    try {
      const size = await copyBundledTo(g.path, dest);
      const kb = (size / 1024).toFixed(1);
      console.log(`${GREEN}✓${RESET} ${g.filename} ${DIM}(${kb} KB) → ${dest}${RESET}`);
      installed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${RED}✗${RESET} ${g.filename}: ${msg}`);
      skipped++;
    }
  }
  console.log();
  if (skipped > 0) {
    console.log(`${YELLOW}${installed} installed, ${skipped} failed.${RESET}`);
    process.exit(1);
  }
  console.log(`${installed} grammar(s) installed to ${dir}`);
  console.log(`${DIM}AST audit patterns will now run on the compiled binary.${RESET}`);
}

function listCmd(): void {
  const dir = installDir();
  console.log(`Bundled grammars (in this build):`);
  if (BUNDLED_GRAMMARS.length === 0) {
    console.log(`  ${DIM}(none)${RESET}`);
  } else {
    for (const g of BUNDLED_GRAMMARS) {
      console.log(`  ${g.language.padEnd(12)} ${DIM}${g.filename}${RESET}`);
    }
  }
  console.log();
  console.log(`Installed at ${dir}:`);
  if (!existsSync(dir)) {
    console.log(`  ${DIM}(directory does not exist — run \`kcode grammars install\`)${RESET}`);
    return;
  }
  let any = false;
  for (const g of BUNDLED_GRAMMARS) {
    const p = join(dir, g.filename);
    if (existsSync(p)) {
      const size = statSync(p).size;
      const kb = (size / 1024).toFixed(1);
      console.log(`  ${GREEN}✓${RESET} ${g.language.padEnd(12)} ${DIM}${kb} KB${RESET}`);
      any = true;
    } else {
      console.log(`  ${DIM}·${RESET} ${g.language.padEnd(12)} ${DIM}not installed${RESET}`);
    }
  }
  if (!any) {
    console.log(`  ${DIM}(no bundled grammar installed yet)${RESET}`);
  }
}

function removeCmd(lang: string): void {
  const dir = installDir();
  const g = findBundledGrammar(lang);
  if (!g) {
    console.error(`${RED}✗${RESET} unknown language "${lang}".`);
    process.exit(1);
  }
  const dest = join(dir, g.filename);
  if (!existsSync(dest)) {
    console.log(`${DIM}${g.filename} is not installed.${RESET}`);
    return;
  }
  unlinkSync(dest);
  console.log(`${GREEN}✓${RESET} removed ${dest}`);
}

export function registerGrammarsCommand(program: Command): void {
  const grammars = program
    .command("grammars")
    .description("Manage tree-sitter grammars used by AST audit patterns");

  grammars
    .command("install [languages...]")
    .description(
      "Copy bundled tree-sitter grammar(s) into ~/.kcode/grammars/ so the compiled binary can run AST audit patterns. With no arguments, installs every bundled grammar.",
    )
    .action(async (langs: string[]) => {
      await installCmd(langs ?? []);
    });

  grammars
    .command("list")
    .description(
      "Show which grammars this build ships with and which are installed in ~/.kcode/grammars/.",
    )
    .action(() => {
      listCmd();
    });

  grammars
    .command("remove <language>")
    .description("Delete an installed grammar from ~/.kcode/grammars/.")
    .action((lang: string) => {
      removeCmd(lang);
    });
}
