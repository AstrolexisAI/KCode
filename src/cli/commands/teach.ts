import type { Command } from "commander";
import { kcodePath } from "../../core/paths";

export function registerTeachCommand(program: Command): void {
  const teachCmd = program
    .command("teach")
    .description("Teach KCode about your environment (awareness modules)");

  teachCmd
    .command("add <name>")
    .description("Create a new awareness module (opens in $EDITOR)")
    .option("-g, --global", "Create in ~/.kcode/awareness/ instead of project")
    .action(async (name: string, opts: { global?: boolean }) => {
      const { join } = await import("node:path");
      const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, "");
      const dir = opts.global ? kcodePath("awareness") : join(process.cwd(), ".kcode", "awareness");

      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${slug}.md`);

      if (existsSync(filePath)) {
        console.log(`\x1b[33m!\x1b[0m Already exists: ${filePath}`);
        console.log("  Edit it with: $EDITOR " + filePath);
        return;
      }

      const template = `# ${name}

<!-- KCode loads this file into every session automatically. -->
<!-- Write anything you want KCode to always know about. -->
<!-- Examples: API endpoints, device IPs, project conventions, team rules. -->

`;
      writeFileSync(filePath, template, "utf-8");
      console.log(`\x1b[32m+\x1b[0m Created: ${filePath}`);

      const editor = process.env.EDITOR || process.env.VISUAL || "nano";
      try {
        const { execFileSync: editorExec } = await import("node:child_process");
        editorExec(editor, [filePath], { stdio: "inherit" });
      } catch {
        console.log(`  Edit it with: ${editor} ${filePath}`);
      }
    });

  teachCmd
    .command("list")
    .description("List all awareness modules")
    .action(async () => {
      const { join } = await import("node:path");
      const { readdirSync, existsSync, readFileSync, statSync } = await import("node:fs");

      const globalDir = kcodePath("awareness");
      const projectDir = join(process.cwd(), ".kcode", "awareness");

      let found = false;

      for (const [label, dir] of [
        ["Global", globalDir],
        ["Project", projectDir],
      ] as const) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .sort();
        if (files.length === 0) continue;

        found = true;
        console.log(`\n\x1b[1m${label}\x1b[0m \x1b[2m(${dir})\x1b[0m`);
        for (const f of files) {
          const content = readFileSync(join(dir, f), "utf-8");
          const firstLine =
            content
              .split("\n")
              .find((l) => l.startsWith("# "))
              ?.replace("# ", "") || f;
          const size = statSync(join(dir, f)).size;
          console.log(`  \x1b[36m${f}\x1b[0m — ${firstLine} \x1b[2m(${size} bytes)\x1b[0m`);
        }
      }

      if (!found) {
        console.log("\nNo awareness modules found.");
        console.log("Create one with: \x1b[1mkcode teach add <name>\x1b[0m");
        console.log("\nExamples:");
        console.log("  kcode teach add sonoff       # Teach about IoT devices");
        console.log("  kcode teach add deploy        # Teach deployment steps");
        console.log("  kcode teach add team-rules    # Teach coding conventions");
      }
    });

  teachCmd
    .command("remove <name>")
    .description("Remove an awareness module")
    .option("-g, --global", "Remove from ~/.kcode/awareness/")
    .action(async (name: string, opts: { global?: boolean }) => {
      const { join } = await import("node:path");
      const { existsSync, unlinkSync } = await import("node:fs");

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, "");
      const dir = opts.global ? kcodePath("awareness") : join(process.cwd(), ".kcode", "awareness");

      const filePath = join(dir, `${slug}.md`);
      if (!existsSync(filePath)) {
        console.log(`\x1b[31m!\x1b[0m Not found: ${filePath}`);
        return;
      }

      unlinkSync(filePath);
      console.log(`\x1b[32m-\x1b[0m Removed: ${filePath}`);
    });

  teachCmd
    .command("edit <name>")
    .description("Edit an existing awareness module")
    .option("-g, --global", "Edit from ~/.kcode/awareness/")
    .action(async (name: string, opts: { global?: boolean }) => {
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, "");
      const dir = opts.global ? kcodePath("awareness") : join(process.cwd(), ".kcode", "awareness");

      const filePath = join(dir, `${slug}.md`);
      if (!existsSync(filePath)) {
        console.log(`\x1b[31m!\x1b[0m Not found: ${filePath}`);
        console.log("  Create it with: kcode teach add " + name);
        return;
      }

      const editor = process.env.EDITOR || process.env.VISUAL || "nano";
      try {
        const { execFileSync: editorExec } = await import("node:child_process");
        editorExec(editor, [filePath], { stdio: "inherit" });
        console.log(`\x1b[32m*\x1b[0m Updated: ${filePath}`);
      } catch {
        console.log(`  Edit manually: ${editor} ${filePath}`);
      }
    });
}
