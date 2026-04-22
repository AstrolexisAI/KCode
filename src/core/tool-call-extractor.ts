// KCode - Tool Call Extractor
// Extracts tool calls from model text output for models that don't use native tool_calls format.
// Local models (Qwen, etc.) often emit tool calls as JSON in text content.

import type { ToolRegistry } from "./tool-registry";

// ─── Types ───────────────────────────────────────────────────────

export interface ExtractedToolCall {
  name: string;
  input: Record<string, unknown>;
  prefixText: string;
}

// ─── Text-based Tool Call Extraction ─────────────────────────────

export function extractToolCallsFromText(text: string, tools: ToolRegistry): ExtractedToolCall[] {
  const results: ExtractedToolCall[] = [];
  const toolDefs = tools.getDefinitions();
  const knownTools = new Set(toolDefs.map((t) => t.name));
  // Case-insensitive lookup: "bash" → "Bash"
  const toolNameMap = new Map(toolDefs.map((t) => [t.name.toLowerCase(), t.name]));
  let match: RegExpExecArray | null;
  let firstMatchIndex = text.length;

  // Pattern 1: ```json\n{"name": "ToolName", "arguments": {...}}\n```
  const codeBlockRe = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g;
  while ((match = codeBlockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!);
      const rawName = parsed.name ?? parsed.function ?? parsed.tool;
      const toolName =
        typeof rawName === "string" ? (toolNameMap.get(rawName.toLowerCase()) ?? rawName) : null;
      const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
      if (toolName && knownTools.has(toolName)) {
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({
          name: toolName,
          input: typeof args === "object" ? args : {},
          prefixText: text.slice(0, firstMatchIndex),
        });
      }
    } catch {
      /* not valid JSON */
    }
  }
  if (results.length > 0) return results;

  // Pattern 2: Raw JSON {"name": "ToolName", "arguments": {...}} anywhere in text
  const rawJsonRe =
    /\{\s*"(?:name|function|tool)"\s*:\s*"(\w+)"\s*,\s*"(?:arguments|parameters|input)"\s*:\s*(\{[^}]*\})\s*\}/g;
  while ((match = rawJsonRe.exec(text)) !== null) {
    const rawName = match[1];
    const toolName = rawName ? (toolNameMap.get(rawName.toLowerCase()) ?? rawName) : null;
    if (toolName && knownTools.has(toolName)) {
      try {
        const args = JSON.parse(match[2]!);
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({
          name: toolName,
          input: typeof args === "object" ? args : {},
          prefixText: text.slice(0, firstMatchIndex),
        });
      } catch {
        /* bad args JSON */
      }
    }
  }
  if (results.length > 0) return results;

  // Pattern 3: Code block containing a shell command — common with small models
  // ```bash\nsome command\n``` or ```\nsome command\n```
  const bashBlockRe = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n\s*```/g;
  while ((match = bashBlockRe.exec(text)) !== null) {
    const cmd = match[1]!.trim();
    // Only extract if it looks like a real command (not multiline explanation)
    if (
      cmd &&
      !cmd.includes("\n") &&
      cmd.length < 500 &&
      !cmd.startsWith("#") &&
      !cmd.startsWith("//")
    ) {
      if (match.index < firstMatchIndex) firstMatchIndex = match.index;
      results.push({
        name: "Bash",
        input: { command: cmd, description: `Execute: ${cmd.slice(0, 60)}` },
        prefixText: text.slice(0, firstMatchIndex),
      });
    }
  }
  if (results.length > 0) return results;

  // Pattern 4: ToolName "arg1" "arg2" format (Qwen-style)
  // e.g. Bash "mkdir foo" "description" 20000
  for (const def of toolDefs) {
    const namePattern = new RegExp(`(?:^|\\n)\\s*${def.name}\\s+"([^"]+)"`, "g");
    while ((match = namePattern.exec(text)) !== null) {
      const firstArg = match[1];
      if (def.name === "Bash" || def.name === "bash") {
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({
          name: "Bash",
          input: { command: firstArg!, description: `Execute: ${firstArg!.slice(0, 60)}` },
          prefixText: text.slice(0, firstMatchIndex),
        });
      }
    }
  }
  if (results.length > 0) return results;

  // Pattern 5: XML-style tool calls (Grok-4-reasoning hallucinates this format)
  //   <function_call name="Glob">
  //     <argument name="pattern">**/*.ts</argument>
  //     <argument name="output_mode">files_with_matches</argument>
  //   </function_call>
  const xmlRe = /<function_call\s+name="([^"]+)">([\s\S]*?)<\/function_call>/g;
  while ((match = xmlRe.exec(text)) !== null) {
    const rawName = match[1]!;
    const toolName = toolNameMap.get(rawName.toLowerCase()) ?? rawName;
    if (!knownTools.has(toolName)) continue;

    // Extract all <argument name="key">value</argument> blocks
    const argRe = /<argument\s+name="([^"]+)">([\s\S]*?)<\/argument>/g;
    const args: Record<string, unknown> = {};
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argRe.exec(match[2]!)) !== null) {
      const key = argMatch[1]!;
      const val = argMatch[2]!.trim();
      // Coerce obvious types
      if (val === "true") args[key] = true;
      else if (val === "false") args[key] = false;
      else if (/^-?\d+$/.test(val)) args[key] = parseInt(val, 10);
      else if (/^-?\d+\.\d+$/.test(val)) args[key] = parseFloat(val);
      else args[key] = val;
    }

    if (match.index < firstMatchIndex) firstMatchIndex = match.index;
    results.push({
      name: toolName,
      input: args,
      prefixText: text.slice(0, firstMatchIndex),
    });
  }
  if (results.length > 0) return results;

  // Pattern 6: Python-style function calls on their own line:
  //   ToolName(key="value", other=42)
  // Conservative: only match if line starts with a known tool name
  for (const def of toolDefs) {
    // Anchor to start-of-line or after whitespace; require (...) on same line
    const pyRe = new RegExp(`(?:^|\\n)\\s*${escapeRegex(def.name)}\\s*\\(([^)]*)\\)`, "g");
    while ((match = pyRe.exec(text)) !== null) {
      const argStr = match[1]!.trim();
      const args = parsePythonKwargs(argStr);
      if (args === null) continue;
      if (match.index < firstMatchIndex) firstMatchIndex = match.index;
      results.push({
        name: def.name,
        input: args,
        prefixText: text.slice(0, firstMatchIndex),
      });
    }
  }

  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse Python-style kwargs: `key="value", num=42, flag=true`.
 * Returns null if the string doesn't look like kwargs (avoids false matches).
 */
function parsePythonKwargs(s: string): Record<string, unknown> | null {
  if (!s.trim()) return {};
  // Must have at least one `key=value` pattern
  if (!/\w+\s*=/.test(s)) return null;
  const args: Record<string, unknown> = {};
  // Split on commas, respecting quoted strings
  const parts: string[] = [];
  let buf = "";
  let inString: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      buf += c;
      if (c === inString && s[i - 1] !== "\\") inString = null;
    } else if (c === '"' || c === "'") {
      buf += c;
      inString = c;
    } else if (c === ",") {
      parts.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim()) parts.push(buf);

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim();
    let val = part.slice(eq + 1).trim();
    // Strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Coerce
    if (val === "true") args[key] = true;
    else if (val === "false") args[key] = false;
    else if (/^-?\d+$/.test(val)) args[key] = parseInt(val, 10);
    else if (/^-?\d+\.\d+$/.test(val)) args[key] = parseFloat(val);
    else args[key] = val;
  }
  return args;
}
