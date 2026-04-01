import type { Command } from "commander";
import { generateCompletions, getDefaultSpec, type Shell } from "../completions/generator";

export function registerCompletionsCommand(program: Command): void {
  const cmd = program
    .command("completions <shell>")
    .description("Generate shell completion script (bash, zsh, or fish)")
    .action((shell: string) => {
      const validShells: Shell[] = ["bash", "zsh", "fish"];
      if (!validShells.includes(shell as Shell)) {
        console.error(`Unsupported shell: ${shell}. Use 'bash', 'zsh', or 'fish'.`);
        process.exit(1);
      }

      const spec = getDefaultSpec();
      console.log(generateCompletions(shell as Shell, spec));
    });

  // `kcode completions install` — auto-install completions into shell config
  cmd
    .command("install")
    .description("Auto-install shell completions into your shell config (.bashrc, .zshrc, or config.fish)")
    .option("-s, --shell <shell>", "Force a specific shell (bash, zsh, fish)")
    .action(async (opts: { shell?: string }) => {
      await installCompletions(opts.shell as Shell | undefined);
    });
}

// ─── Auto-installer ────────────────────────────────────────────

async function installCompletions(forceShell?: Shell): Promise<void> {
  const { existsSync, writeFileSync, appendFileSync, readFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  // Detect current shell
  const shell: Shell = forceShell ?? detectShell();
  const spec = getDefaultSpec();
  const script = generateCompletions(shell, spec);

  switch (shell) {
    case "bash": {
      // Write completion file
      const completionDir = join(home, ".local", "share", "bash-completion", "completions");
      mkdirSync(completionDir, { recursive: true });
      const completionFile = join(completionDir, "kcode");
      writeFileSync(completionFile, script);

      // Add source line to .bashrc if not already present
      const bashrc = join(home, ".bashrc");
      const sourceLine = `\n# KCode shell completions\n[ -f "${completionFile}" ] && source "${completionFile}"\n`;

      if (existsSync(bashrc)) {
        const content = readFileSync(bashrc, "utf-8");
        if (!content.includes("bash-completion/completions/kcode")) {
          appendFileSync(bashrc, sourceLine);
          console.log(`\x1b[32m✓\x1b[0m Completions installed to ${completionFile}`);
          console.log(`\x1b[32m✓\x1b[0m Source line added to ${bashrc}`);
        } else {
          writeFileSync(completionFile, script);
          console.log(`\x1b[32m✓\x1b[0m Completions updated at ${completionFile} (already sourced in .bashrc)`);
        }
      } else {
        writeFileSync(bashrc, sourceLine);
        console.log(`\x1b[32m✓\x1b[0m Created ${bashrc} with completion source`);
      }
      break;
    }

    case "zsh": {
      // Write to site-functions
      const completionDir = join(home, ".zsh", "completions");
      mkdirSync(completionDir, { recursive: true });
      const completionFile = join(completionDir, "_kcode");
      writeFileSync(completionFile, script);

      // Add fpath to .zshrc if not already present
      const zshrc = join(home, ".zshrc");
      const fpathLine = `\n# KCode shell completions\nfpath=(~/.zsh/completions $fpath)\nautoload -Uz compinit && compinit\n`;

      if (existsSync(zshrc)) {
        const content = readFileSync(zshrc, "utf-8");
        if (!content.includes(".zsh/completions")) {
          appendFileSync(zshrc, fpathLine);
          console.log(`\x1b[32m✓\x1b[0m Completions installed to ${completionFile}`);
          console.log(`\x1b[32m✓\x1b[0m fpath added to ${zshrc}`);
        } else {
          writeFileSync(completionFile, script);
          console.log(`\x1b[32m✓\x1b[0m Completions updated at ${completionFile} (already in fpath)`);
        }
      } else {
        writeFileSync(zshrc, fpathLine);
        console.log(`\x1b[32m✓\x1b[0m Created ${zshrc} with completion fpath`);
      }
      break;
    }

    case "fish": {
      const completionDir = join(home, ".config", "fish", "completions");
      mkdirSync(completionDir, { recursive: true });
      const completionFile = join(completionDir, "kcode.fish");
      writeFileSync(completionFile, script);
      console.log(`\x1b[32m✓\x1b[0m Completions installed to ${completionFile}`);
      console.log(`  Fish loads completions automatically from this directory.`);
      break;
    }
  }

  console.log(`\n  Restart your shell or run \`source ~/.${shell === "fish" ? "config/fish/config.fish" : shell === "zsh" ? "zshrc" : "bashrc"}\` to activate.`);
}

function detectShell(): Shell {
  const shellEnv = process.env.SHELL ?? "";
  if (shellEnv.includes("zsh")) return "zsh";
  if (shellEnv.includes("fish")) return "fish";
  return "bash"; // default
}
