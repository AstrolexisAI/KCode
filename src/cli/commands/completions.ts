import type { Command } from "commander";
import { generateCompletions, getDefaultSpec, type Shell } from "../completions/generator";

export function registerCompletionsCommand(program: Command): void {
  program
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
}
