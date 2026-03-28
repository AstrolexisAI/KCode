// KCode - Hookify Dynamic Rule Engine
// Converts conversation patterns into hooks without editing JSON manually.
// Rules are stored as markdown files with YAML frontmatter in ~/.kcode/

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodeHome } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface HookifyCondition {
  field: string;
  operator: "regex_match" | "contains" | "equals" | "not_contains" | "starts_with" | "ends_with";
  pattern: string;
}

export interface HookifyRule {
  name: string;
  enabled: boolean;
  event: "bash" | "file" | "stop" | "prompt" | "all";
  toolMatcher?: string;
  conditions: HookifyCondition[];
  action: "warn" | "block";
  message: string;
}

export interface HookifyEvalResult {
  decision: "allow" | "block" | "warn";
  messages: string[];
}

// ─── Paths ──────────────────────────────────────────────────────

const HOOKIFY_DIR = kcodeHome();

function ruleFilePath(name: string): string {
  return join(HOOKIFY_DIR, `hookify.${name}.md`);
}

// ─── YAML Frontmatter Parsing ───────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1]!;
  const body = match[2]!.trim();
  const meta: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: Record<string, string>[] | null = null;
  let currentItem: Record<string, string> | null = null;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trimEnd();

    if (/^  - field:/.test(trimmed) || /^    - field:/.test(trimmed)) {
      if (currentItem && currentArray) currentArray.push(currentItem);
      currentItem = { field: trimmed.replace(/^\s*- field:\s*/, "").trim() };
      continue;
    }

    if (currentItem && /^\s+(operator|pattern):/.test(trimmed)) {
      const kv = trimmed.match(/^\s+(operator|pattern):\s*(.*)$/);
      if (kv) {
        currentItem[kv[1]!] = unquoteYaml(kv[2]!);
      }
      continue;
    }

    if (currentItem && currentArray && !/^\s/.test(trimmed)) {
      currentArray.push(currentItem);
      currentItem = null;
      meta[currentKey!] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();

      if (value === "") {
        currentKey = key;
        currentArray = [];
        continue;
      }

      meta[key] = parseYamlValue(value);
      continue;
    }
  }

  if (currentItem && currentArray) {
    currentArray.push(currentItem);
    if (currentKey) meta[currentKey] = currentArray;
  }

  return { meta, body };
}

function parseYamlValue(value: string): string | boolean | number {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;
  return unquoteYaml(value);
}

function unquoteYaml(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// ─── Serialization ──────────────────────────────────────────────

function serializeRule(rule: HookifyRule): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${rule.name}`);
  lines.push(`enabled: ${rule.enabled}`);
  lines.push(`event: ${rule.event}`);
  if (rule.toolMatcher) lines.push(`toolMatcher: ${rule.toolMatcher}`);
  lines.push(`action: ${rule.action}`);
  lines.push("conditions:");
  for (const cond of rule.conditions) {
    lines.push(`  - field: ${cond.field}`);
    lines.push(`    operator: ${cond.operator}`);
    lines.push(`    pattern: "${cond.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  lines.push("---");
  lines.push("");
  lines.push(rule.message);
  return lines.join("\n");
}

function parseRule(content: string, filename: string): HookifyRule | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;

  const { meta, body } = parsed;

  const name = (meta.name as string) ?? filename.replace(/^hookify\./, "").replace(/\.md$/, "");
  const enabled = meta.enabled !== false;
  const event = (meta.event as HookifyRule["event"]) ?? "all";
  const toolMatcher = meta.toolMatcher as string | undefined;
  const action = (meta.action as "warn" | "block") ?? "warn";

  const rawConditions = meta.conditions;
  const conditions: HookifyCondition[] = [];
  if (Array.isArray(rawConditions)) {
    for (const raw of rawConditions) {
      if (raw && typeof raw === "object" && "field" in raw && "operator" in raw && "pattern" in raw) {
        conditions.push({
          field: String(raw.field),
          operator: String(raw.operator) as HookifyCondition["operator"],
          pattern: String(raw.pattern),
        });
      }
    }
  }

  return { name, enabled, event, toolMatcher, conditions, action, message: body || `Rule "${name}" triggered.` };
}

// ─── Public API ─────────────────────────────────────────────────

export async function loadHookifyRules(): Promise<HookifyRule[]> {
  const rules: HookifyRule[] = [];

  if (!existsSync(HOOKIFY_DIR)) return rules;

  try {
    const files = readdirSync(HOOKIFY_DIR);
    for (const file of files) {
      if (!file.startsWith("hookify.") || !file.endsWith(".md")) continue;
      const fullPath = join(HOOKIFY_DIR, file);
      try {
        const content = readFileSync(fullPath, "utf-8");
        const rule = parseRule(content, file);
        if (rule) rules.push(rule);
      } catch {
        log.warn("hookify", `Failed to read rule file: ${file}`);
      }
    }
  } catch {
    // Directory not readable
  }

  return rules;
}

export async function saveHookifyRule(rule: HookifyRule): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  if (!existsSync(HOOKIFY_DIR)) mkdirSync(HOOKIFY_DIR, { recursive: true });

  const filePath = ruleFilePath(rule.name);
  writeFileSync(filePath, serializeRule(rule), "utf-8");
  log.info("hookify", `Saved rule: ${rule.name}`);
}

export async function deleteHookifyRule(name: string): Promise<boolean> {
  const filePath = ruleFilePath(name);
  if (!existsSync(filePath)) return false;

  unlinkSync(filePath);
  log.info("hookify", `Deleted rule: ${name}`);
  return true;
}

// ─── Evaluation ─────────────────────────────────────────────────

function eventMatchesHookEvent(hookEvent: HookifyRule["event"], toolName: string): boolean {
  if (hookEvent === "all") return true;
  if (hookEvent === "bash" && toolName === "Bash") return true;
  if (hookEvent === "file" && ["Edit", "Write", "MultiEdit", "Read"].includes(toolName)) return true;
  if (hookEvent === "prompt") return true;
  if (hookEvent === "stop") return true;
  return false;
}

function toolMatcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  const matchers = matcher.split("|");
  return matchers.some(m => m.trim() === toolName);
}

function evaluateCondition(cond: HookifyCondition, toolInput: Record<string, unknown>): boolean {
  const value = getNestedValue(toolInput, cond.field);
  if (value === undefined || value === null) return false;
  const str = String(value);

  switch (cond.operator) {
    case "regex_match":
      try {
        return new RegExp(cond.pattern).test(str);
      } catch {
        return false;
      }
    case "contains":
      return str.includes(cond.pattern);
    case "equals":
      return str === cond.pattern;
    case "not_contains":
      return !str.includes(cond.pattern);
    case "starts_with":
      return str.startsWith(cond.pattern);
    case "ends_with":
      return str.endsWith(cond.pattern);
    default:
      return false;
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function evaluateHookifyRules(
  toolName: string,
  toolInput: Record<string, unknown>,
  event: string,
): Promise<HookifyEvalResult> {
  const rules = await loadHookifyRules();
  const messages: string[] = [];
  let decision: "allow" | "block" | "warn" = "allow";

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!eventMatchesHookEvent(rule.event, toolName)) continue;
    if (!toolMatcherMatches(rule.toolMatcher, toolName)) continue;

    const allConditionsMet = rule.conditions.length === 0 ||
      rule.conditions.every(cond => evaluateCondition(cond, toolInput));

    if (!allConditionsMet) continue;

    messages.push(rule.message);

    if (rule.action === "block") {
      decision = "block";
    } else if (rule.action === "warn" && decision !== "block") {
      decision = "warn";
    }
  }

  return { decision, messages };
}

// ─── Test Helper ────────────────────────────────────────────────

export async function testHookifyRules(
  command: string,
): Promise<{ decision: "allow" | "block" | "warn"; matchedRules: string[]; messages: string[] }> {
  const toolInput = { command };
  const result = await evaluateHookifyRules("Bash", toolInput, "PreToolUse");
  const rules = await loadHookifyRules();
  const matchedRules: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!eventMatchesHookEvent(rule.event, "Bash")) continue;
    if (!toolMatcherMatches(rule.toolMatcher, "Bash")) continue;
    const allMet = rule.conditions.length === 0 ||
      rule.conditions.every(cond => evaluateCondition(cond, toolInput));
    if (allMet) matchedRules.push(rule.name);
  }

  return { decision: result.decision, matchedRules, messages: result.messages };
}

// ─── Formatting ─────────────────────────────────────────────────

export function formatRuleList(rules: HookifyRule[]): string {
  if (rules.length === 0) {
    return "  No hookify rules found.\n  Create one with: /hookify create";
  }

  const lines = [`  Hookify Rules (${rules.length}):\n`];
  for (const rule of rules) {
    const status = rule.enabled ? "ON " : "OFF";
    const condCount = rule.conditions.length;
    lines.push(`  [${status}] ${rule.name} — ${rule.action} on ${rule.event} (${condCount} condition${condCount !== 1 ? "s" : ""})`);
    if (rule.toolMatcher) lines.push(`        matcher: ${rule.toolMatcher}`);
    for (const cond of rule.conditions) {
      lines.push(`        ${cond.field} ${cond.operator} "${cond.pattern}"`);
    }
  }
  return lines.join("\n");
}

export function formatRuleDetail(rule: HookifyRule): string {
  const lines = [
    `  Rule: ${rule.name}`,
    `  Status: ${rule.enabled ? "enabled" : "disabled"}`,
    `  Event: ${rule.event}`,
    `  Action: ${rule.action}`,
  ];
  if (rule.toolMatcher) lines.push(`  Tool Matcher: ${rule.toolMatcher}`);
  lines.push(`  Conditions (${rule.conditions.length}):`);
  for (const cond of rule.conditions) {
    lines.push(`    ${cond.field} ${cond.operator} "${cond.pattern}"`);
  }
  lines.push(`  Message: ${rule.message}`);
  return lines.join("\n");
}
