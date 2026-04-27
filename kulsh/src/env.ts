export class Environment {
  private vars: Map<string, string> = new Map();

  constructor() {
    // Copy process environment
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        this.vars.set(key, value);
      }
    }
  }

  get(key: string): string | undefined {
    return this.vars.get(key);
  }

  set(key: string, value: string): void {
    this.vars.set(key, value);
    process.env[key] = value;
  }

  expand(input: string): string {
    return input.replace(/\$(\w+)/g, (match, key) => {
      return this.vars.get(key) ?? match;
    });
  }

  exportVar(line: string): void {
    const match = line.match(/^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (match) {
      const [, key, value] = match;
      this.set(key, value.trim());
    }
  }
}

export const env = new Environment();