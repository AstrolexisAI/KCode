import { spawnSync } from 'child_process';
import { env } from './env.js';
import { runBuiltin, builtins } from './builtins.js';
import { writeFileSync, appendFileSync, existsSync } from 'fs';

export function execute(line: string): void {
  if (!line.trim()) return;

  const expanded = env.expand(line.trim());

  // Support for && chains (for the demo)
  const commands = expanded.split(/\s*&&\s*/);

  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    if (builtins.has(command.toLowerCase())) {
      const success = runBuiltin(command, args);
      if (!success) break;
    } else {
      // External command
      try {
        const result = spawnSync(command, args, {
          stdio: 'inherit',
          shell: false,
          env: process.env
        });

        if (result.error) {
          if ((result.error as any).code === 'ENOENT') {
            console.error(`kulsh: ${command}: command not found`);
          } else {
            console.error(`Error: ${result.error.message}`);
          }
          break;
        }
      } catch (err: any) {
        console.error(`kulsh: ${command}: ${err.message}`);
        break;
      }
    }
  }
}