import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { env } from './env.js';

export function completer(line: string): [string[], string] {
  const completions: string[] = [];
  const lastWord = line.split(/\s+/).pop() || '';

  // Builtins
  const builtins = ['cd', 'pwd', 'exit', 'clear', 'history', 'kulvex', 'kcode', 'models', 'export'];
  if (lastWord === '') {
    completions.push(...builtins);
  } else {
    completions.push(...builtins.filter(cmd => cmd.startsWith(lastWord)));
  }

  // Path completion
  try {
    let dir = '.';
    let prefix = lastWord;

    if (lastWord.includes('/')) {
      dir = dirname(lastWord);
      prefix = lastWord.substring(lastWord.lastIndexOf('/') + 1);
      if (dir === '') dir = '/';
    }

    if (existsSync(dir)) {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(prefix)) {
          const full = join(dir, file);
          completions.push(full === '.' ? file : full);
        }
      }
    }
  } catch (e) {
    // Ignore errors during completion
  }

  return [completions, lastWord];
}