// KCode - Per-Tool Permission Policies
// Defines fine-grained permission rules per tool with glob pattern matching.

// ─── Types ──────────────────────────────────────────────────────

export interface ToolPolicyRule {
  condition: {
    field: string;
    pattern: string;
    operator: "matches" | "not_matches" | "contains" | "starts_with";
  };
  action: "allow" | "deny" | "ask";
  reason?: string;
}

export interface ToolPolicy {
  toolName: string;
  defaultAction: "ask" | "allow" | "deny";
  rules: ToolPolicyRule[];
}

export interface PolicyEvalResult {
  action: "allow" | "deny" | "ask";
  reason?: string;
}

// ─── Glob Matching ──────────────────────────────────────────────

/**
 * Converts a glob pattern to a regex and tests the value against it.
 * Supports * (any chars), ? (single char), and ** (recursive match).
 * Case-insensitive.
 */
export function globMatch(value: string, pattern: string): boolean {
  // Escape regex special characters except * and ?
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        // ** matches everything including path separators
        regexStr += ".*";
        i += 2;
        // Skip trailing slash after **
        if (i < pattern.length && pattern[i] === "/") {
          regexStr += "(?:/)?";
          i++;
        }
        continue;
      }
      // Single * matches anything except nothing special
      regexStr += ".*";
      i++;
    } else if (ch === "?") {
      regexStr += ".";
      i++;
    } else if (".+^${}()|[]\\".includes(ch!)) {
      regexStr += "\\" + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  try {
    const regex = new RegExp(`^${regexStr}$`, "i");
    return regex.test(value);
  } catch {
    return false;
  }
}

// ─── Condition Matching ─────────────────────────────────────────

/**
 * Evaluates a single condition against a string value.
 */
export function matchesCondition(value: string, condition: ToolPolicyRule["condition"]): boolean {
  switch (condition.operator) {
    case "matches":
      return globMatch(value, condition.pattern);
    case "not_matches":
      return !globMatch(value, condition.pattern);
    case "contains":
      return value.toLowerCase().includes(condition.pattern.toLowerCase());
    case "starts_with":
      return value.toLowerCase().startsWith(condition.pattern.toLowerCase());
    default:
      return false;
  }
}

// ─── Extracting Field Values ────────────────────────────────────

/**
 * Extracts a field value from the tool input, supporting nested paths
 * with dot notation (e.g. "args.command").
 */
function getFieldValue(input: Record<string, unknown>, field: string): string | null {
  const parts = field.split(".");
  let current: unknown = input;

  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }

  if (current === null || current === undefined) return null;
  return String(current);
}

// ─── Policy Evaluation ──────────────────────────────────────────

/**
 * Finds the matching policy for a tool and evaluates its rules in order.
 *
 * - If no policy exists for the tool, returns { action: "ask" }.
 * - If a policy exists but no rules match, returns the policy's defaultAction.
 * - First matching rule wins.
 */
export function evaluateToolPolicy(
  toolName: string,
  input: Record<string, unknown>,
  policies: ToolPolicy[],
): PolicyEvalResult {
  // Find the policy for this tool (case-insensitive match, also support glob in toolName)
  const policy = policies.find(
    (p) => p.toolName.toLowerCase() === toolName.toLowerCase() || globMatch(toolName, p.toolName),
  );

  if (!policy) {
    return { action: "ask" };
  }

  // Evaluate rules in order - first match wins
  for (const rule of policy.rules) {
    const fieldValue = getFieldValue(input, rule.condition.field);

    // If the field doesn't exist in the input, skip this rule
    if (fieldValue === null) continue;

    if (matchesCondition(fieldValue, rule.condition)) {
      return {
        action: rule.action,
        reason: rule.reason,
      };
    }
  }

  // No rules matched, use default action
  return { action: policy.defaultAction };
}

// ─── Loading Policies ───────────────────────────────────────────

/**
 * Loads tool policies from a settings JSON file.
 * Expects the file to contain a top-level "toolPolicies" array.
 * Returns an empty array if the file doesn't exist or has no policies.
 */
export function loadPolicies(settingsPath: string): ToolPolicy[] {
  try {
    const { existsSync } = require("node:fs");
    if (!existsSync(settingsPath)) {
      return [];
    }

    const text = require("node:fs").readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(text);

    if (!settings.toolPolicies || !Array.isArray(settings.toolPolicies)) {
      return [];
    }

    return validatePolicies(settings.toolPolicies);
  } catch {
    return [];
  }
}

/**
 * Validates and filters policies, ensuring they have the required structure.
 */
function validatePolicies(raw: unknown[]): ToolPolicy[] {
  const valid: ToolPolicy[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.toolName !== "string") continue;
    if (!["ask", "allow", "deny"].includes(obj.defaultAction as string)) continue;

    const rules: ToolPolicyRule[] = [];
    if (Array.isArray(obj.rules)) {
      for (const rule of obj.rules) {
        if (!rule || typeof rule !== "object") continue;
        const r = rule as Record<string, unknown>;
        if (!["allow", "deny", "ask"].includes(r.action as string)) continue;

        const condition = r.condition as Record<string, unknown> | undefined;
        if (!condition || typeof condition !== "object") continue;
        if (typeof condition.field !== "string") continue;
        if (typeof condition.pattern !== "string") continue;
        if (
          !["matches", "not_matches", "contains", "starts_with"].includes(
            condition.operator as string,
          )
        )
          continue;

        rules.push({
          condition: {
            field: condition.field as string,
            pattern: condition.pattern as string,
            operator: condition.operator as ToolPolicyRule["condition"]["operator"],
          },
          action: r.action as "allow" | "deny" | "ask",
          reason: typeof r.reason === "string" ? r.reason : undefined,
        });
      }
    }

    valid.push({
      toolName: obj.toolName as string,
      defaultAction: obj.defaultAction as "ask" | "allow" | "deny",
      rules,
    });
  }

  return valid;
}
