import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const HISTORY_FILE = join(process.env.HOME || '~', '.kulsh_history');
const MAX_HISTORY = 1000;

export class History {
  private entries: string[] = [];

  load(): void {
    try {
      if (existsSync(HISTORY_FILE)) {
        const content = readFileSync(HISTORY_FILE, 'utf-8');
        this.entries = content.split('\n').filter(line => line.trim() !== '');
      }
    } catch (e) {
      this.entries = [];
    }
  }

  save(): void {
    try {
      const dir = HISTORY_FILE.split('/').slice(0, -1).join('/');
      mkdirSync(dir, { recursive: true });
      
      writeFileSync(HISTORY_FILE, this.entries.join('\n'));
    } catch (e) {
      console.error('Failed to save history:', e);
    }
  }

  add(command: string): void {
    if (!command.trim()) return;
    
    // Remove duplicates
    this.entries = this.entries.filter(entry => entry !== command);
    this.entries.push(command);
    
    // Keep max size
    if (this.entries.length > MAX_HISTORY) {
      this.entries = this.entries.slice(-MAX_HISTORY);
    }
  }

  getAll(): string[] {
    return [...this.entries];
  }

  getLast(n: number = 20): string[] {
    return this.entries.slice(-n);
  }
}

export const history = new History();