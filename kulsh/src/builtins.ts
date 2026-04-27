import { env } from './env.js';
import { history } from './history.js';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, createReadStream } from 'fs';
import { join } from 'path';

export const builtins = new Set(['cd', 'pwd', 'exit', 'clear', 'history', 'kulvex', 'models', 'kcode']);

export function runBuiltin(command: string, args: string[]): boolean {
  const cmd = command.toLowerCase();

  switch (cmd) {
    case 'cd':
      try {
        const target = args[0] || process.env.HOME || '~';
        process.chdir(target === '~' ? (process.env.HOME || '/') : target);
        return true;
      } catch (e: any) {
        console.error(`cd: ${e.message}`);
        return false;
      }

    case 'pwd':
      console.log(process.cwd());
      return true;

    case 'exit':
      console.log('Goodbye!');
      process.exit(0);

    case 'clear':
      console.clear();
      return true;

    case 'history':
      history.getLast(50).forEach((entry, i) => {
        console.log(`${(i + 1).toString().padStart(4)}  ${entry}`);
      });
      return true;

    case 'kulvex':
      if (args[0] === 'status') {
        const isRunning = isKulvexRunning();
        console.log(`kulvex server: ${isRunning ? '🟢 running' : '🔴 stopped'} (port 10091)`);
        return true;
      }
      if (args[0] === 'logs') {
        showKulvexLogs();
        return true;
      }
      console.log('Usage: kulvex <status|logs>');
      return true;

    case 'models':
      showModels();
      return true;

    case 'kcode':
      runKCode(args);
      return true;

    default:
      return false;
  }
}

function isKulvexRunning(): boolean {
  try {
    const result = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:10091/health'], {
      encoding: 'utf-8',
      timeout: 800
    });
    return result.stdout?.trim() === '200';
  } catch {
    return false;
  }
}

function showKulvexLogs(): void {
  const logPath = join(process.env.HOME || '~', '.kulvex/logs/kulvex.log');
  if (!existsSync(logPath)) {
    console.log('No kulvex logs found yet.');
    return;
  }
  const tail = spawnSync('tail', ['-n', '30', logPath], { encoding: 'utf-8' });
  console.log(tail.stdout || '');
}

function showModels(): void {
  const modelsPath = join(process.env.HOME || '~', '.kcode/models.json');
  if (!existsSync(modelsPath)) {
    console.log('No models.json found. Run kcode first.');
    return;
  }
  try {
    const data = JSON.parse(readFileSync(modelsPath, 'utf-8'));
    console.log('Available models:');
    if (Array.isArray(data)) {
      data.forEach(m => console.log(`  • ${m.name || m}`));
    } else if (data.models) {
      data.models.forEach((m: any) => console.log(`  • ${m.name || m}`));
    }
  } catch (e) {
    console.error('Failed to read models:', e);
  }
}

function runKCode(args: string[]): void {
  const result = spawnSync('kcode', args, {
    stdio: 'inherit',
    env: { ...process.env, KULVEX: '1' }
  });
}