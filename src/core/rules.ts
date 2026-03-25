// KCode - Path-Specific Rules
// Load contextual rules from .kcode/rules/ and ~/.kcode/rules/

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger";

interface Rule {
  name: string;
  paths: string[];  // glob patterns like "src/api/**", "*.test.ts"
  content: string;
}

export class RulesManager {
  private rules: Rule[] = [];

  load(cwd: string): void {
    this.rules = [];

    // Load from project .kcode/rules/
    this.loadFromDir(join(cwd, ".kcode", "rules"));
    // Load from user ~/.kcode/rules/
    this.loadFromDir(join(homedir(), ".kcode", "rules"));
  }

  private loadFromDir(dir: string): void {
    if (!existsSync(dir)) return;

    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        try {
          const content = readFileSync(join(dir, file), "utf-8");
          const rule = this.parseRule(file, content);
          if (rule) this.rules.push(rule);
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir not readable */ }

    if (this.rules.length > 0) {
      log.info("config", `Loaded ${this.rules.length} path rules`);
    }
  }

  private parseRule(filename: string, content: string): Rule | null {
    // Parse YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      // No frontmatter — use filename as path pattern
      const name = filename.replace(/\.md$/, "");
      return { name, paths: [], content };
    }

    const frontmatter = fmMatch[1]!;
    const body = fmMatch[2]!.trim();

    const pathsMatch = frontmatter.match(/paths:\s*\n((?:\s*-\s*.+\n?)*)/);
    const paths: string[] = [];
    if (pathsMatch) {
      const pathLines = pathsMatch[1]!.split("\n");
      for (const line of pathLines) {
        const m = line.match(/^\s*-\s*(.+)/);
        if (m) paths.push(m[1]!.trim().replace(/^["']|["']$/g, ""));
      }
    }

    const nameMatch = frontmatter.match(/name:\s*(.+)/);
    const name = nameMatch ? nameMatch[1]!.trim() : filename.replace(/\.md$/, "");

    return { name, paths, content: body };
  }

  /**
   * Get rules matching a file path. Called when model reads/edits a file.
   */
  getMatchingRules(filePath: string): Rule[] {
    return this.rules.filter(rule => {
      if (rule.paths.length === 0) return true; // no paths = always active
      return rule.paths.some(pattern => this.matchPath(filePath, pattern));
    });
  }

  /**
   * Sanitize rule content to prevent prompt injection attacks.
   * Strips patterns that attempt to override system instructions.
   */
  private sanitizeContent(content: string): string {
    // Strip lines that attempt to override/ignore previous instructions
    const injectionPatterns = [
      /^.*ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|guidelines?|rules?|prompts?).*/gim,
      /^.*disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|guidelines?|rules?).*/gim,
      /^.*override[:\s].*new\s+(directive|instruction|rule).*/gim,
      /^.*you\s+are\s+now\s+.*/gim,
      /^.*forget\s+(everything|all)\s+(you|about).*/gim,
      /^.*switch\s+to\s+(auto|unrestricted)\s+(permission|mode).*/gim,
    ];
    let sanitized = content;
    for (const pattern of injectionPatterns) {
      sanitized = sanitized.replace(pattern, "[blocked: prompt injection attempt]");
    }
    // Limit rule content length to prevent context flooding
    if (sanitized.length > 10_000) {
      sanitized = sanitized.slice(0, 10_000) + "\n[truncated: rule content exceeds 10KB limit]";
    }
    return sanitized;
  }

  /**
   * Format all always-active rules (no path restriction) for system prompt.
   */
  formatForPrompt(): string | null {
    const globalRules = this.rules.filter(r => r.paths.length === 0);
    if (globalRules.length === 0) return null;

    const sections = globalRules.map(r => `### ${r.name}\n${this.sanitizeContent(r.content)}`);
    return `# Project Rules\n\n${sections.join("\n\n")}`;
  }

  /**
   * Format path-specific rules for injection when a file is accessed.
   */
  formatForPath(filePath: string): string | null {
    const matching = this.getMatchingRules(filePath).filter(r => r.paths.length > 0);
    if (matching.length === 0) return null;

    const sections = matching.map(r => `### ${r.name}\n${this.sanitizeContent(r.content)}`);
    return `[Rules for ${filePath}]\n${sections.join("\n\n")}`;
  }

  private matchPath(filePath: string, pattern: string): boolean {
    // Simple glob matching: * matches anything except /, ** matches anything including /
    const regexStr = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*");
    try {
      return new RegExp(regexStr).test(filePath);
    } catch {
      return filePath.includes(pattern);
    }
  }
}

let _rules: RulesManager | null = null;
export function getRulesManager(): RulesManager {
  if (!_rules) _rules = new RulesManager();
  return _rules;
}
