// KCode - Conversation Manager
// Handles the main conversation loop with local LLM API (OpenAI-compatible) using SSE streaming

import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  KCodeConfig,
  ConversationState,
  StreamEvent,
  TokenUsage,
  TurnCostEntry,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolDefinition,
} from "./types";
import { readFileSync } from "node:fs";
import { getModelBaseUrl, getModelProvider } from "./models";
import type { ModelProvider } from "./models";
import { routeToModel } from "./router";
import { ToolRegistry } from "./tool-registry";
import { SystemPromptBuilder } from "./system-prompt";
import { PermissionManager } from "./permissions";
import { HookManager } from "./hooks";
import { RateLimiter } from "./rate-limiter";
import { UndoManager } from "./undo";
import { TranscriptManager } from "./transcript";
import { log } from "./logger";
import { getWorldModel } from "./world-model";
import { setSudoPasswordPromptFn as _setSudoPasswordPromptFn, type SudoPasswordPromptFn } from "../tools/bash";
import { getUserModel } from "./user-model";
import { generateCacheKey, getCachedResponse, setCachedResponse } from "./response-cache";
import { getIntentionEngine } from "./intentions";
import type { Suggestion } from "./intentions";
import { extractExample, saveExample } from "./distillation";
import { scoreResponse, saveBenchmark, initBenchmarkSchema } from "./benchmarks";
import { getBranchManager } from "./branch-manager";

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 32_000;
const CONTEXT_WINDOW_MARGIN = 0.25; // prune when we reach 75% of context window
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;
const MAX_AGENT_TURNS = 25; // prevent infinite loops — 25 tool turns is plenty for any task
const MAX_CONSECUTIVE_DENIALS = 2; // stop after N permission denials in a row
const MAX_OUTPUT_TOKENS_PER_TURN = 4096; // Hard cap on output tokens per API call
const MAX_TOTAL_OUTPUT_TOKENS = 50_000; // Hard cap on total output tokens per agent loop
const LOOP_PATTERN_THRESHOLD = 3; // trigger loop redirect after N similar Bash commands
const LOOP_PATTERN_HARD_STOP = 5; // force stop + block after N similar commands — model is stuck

/**
 * Extract a semantic "pattern key" from a Bash command to detect loops.
 * Groups commands by their base tool/binary (e.g., all nmap calls → "nmap",
 * all smbclient calls → "smbclient"). This catches cases where the model
 * keeps running the same type of scan with slightly different IPs or flags.
 */
function extractBashLoopPattern(command: string): string | null {
  const trimmed = command.trim();
  // Strip leading "for ... do" loops — extract the inner command
  let inner = trimmed;
  const forMatch = trimmed.match(/^for\s+\w+\s+in\s+[^;]+;\s*do\s+(.+?)\s*;\s*done/s);
  if (forMatch) inner = forMatch[1]!;
  // Also handle: for ... ; do echo "==="; <command> ... done
  const forMatch2 = inner.match(/echo\s+["'][^"']*["'];\s*(.+)/);
  if (forMatch2) inner = forMatch2[1]!;

  // Strip leading comments (lines starting with #) — LLMs often add descriptive comments
  // before the actual command, which would otherwise match as "bash:#"
  inner = inner.replace(/^(\s*#[^\n]*\n)+/g, "").trim();
  // Also strip inline leading comment on single-line commands
  if (inner.startsWith("#")) {
    const newlineIdx = inner.indexOf("\n");
    if (newlineIdx !== -1) {
      inner = inner.slice(newlineIdx + 1).trim();
    } else {
      return null; // Pure comment, no command to pattern-match
    }
  }

  // Strip variable assignments at the start (e.g. MISSING="" FOO=bar)
  inner = inner.replace(/^(\s*\w+="[^"]*"\s*\n?)+/g, "").trim();
  inner = inner.replace(/^(\s*\w+='[^']*'\s*\n?)+/g, "").trim();

  // For piped commands (echo X | socat Y), use BOTH source and sink command names + target IP.
  // This prevents false loop detection when sending different payloads to different IoT devices.
  // e.g. "echo ... | socat - UDP:192.168.1.146:38899" → "bash:echo|socat@192.168.1.146"
  const pipeMatch = inner.match(/^(\S+)\s+.*?\|\s*(\S+)/);
  if (pipeMatch) {
    const sourceCmd = pipeMatch[1]!.replace(/^.*\//, "");
    const sinkCmd = pipeMatch[2]!.replace(/^.*\//, "");
    // Extract target IP from the sink side of the pipe
    const pipeRest = inner.slice(inner.indexOf("|") + 1);
    const pipeIpMatch = pipeRest.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    const pipeSuffix = pipeIpMatch ? `@${pipeIpMatch[1]}` : "";
    return `bash:${sourceCmd}|${sinkCmd}${pipeSuffix}`;
  }

  // Extract the base binary/command (first word that looks like a tool)
  const words = inner.trim().split(/\s+/);
  const skipPrefixes = new Set(["sudo", "nohup", "env", "bash", "-c", "sh", "timeout"]);
  let baseCmd = "";
  for (const w of words) {
    if (skipPrefixes.has(w) || w.startsWith("-") || w.startsWith("$") || w.startsWith("\"") || w.startsWith("'") || w.startsWith("#")) continue;
    baseCmd = w.replace(/^.*\//, ""); // strip path prefix
    break;
  }

  if (!baseCmd) return null;

  // Group related tools into categories
  const SCAN_TOOLS = new Set(["nmap", "masscan", "zmap", "netcat", "nc", "nbtscan", "nmblookup", "nikto", "gobuster", "dirb", "wfuzz", "sqlmap", "searchsploit", "enum4linux"]);
  const SMB_TOOLS = new Set(["smbclient", "smbmap", "rpcclient", "crackmapexec", "impacket-smbclient"]);
  const HTTP_TOOLS = new Set(["curl", "wget", "httpie", "http"]);
  const SSH_TOOLS = new Set(["ssh", "sshpass", "scp", "sftp"]);
  const EXPLOIT_TOOLS = new Set(["dcomexec", "psexec", "wmiexec", "atexec", "smbexec", "secretsdump", "msfconsole", "hydra", "medusa",
    "impacket-smbexec", "impacket-psexec", "impacket-wmiexec", "impacket-dcomexec", "impacket-atexec", "impacket-secretsdump",
    "setoolkit", "beef", "responder"]);
  const BRUTE_TOOLS = new Set(["hashcat", "john", "aircrack-ng", "aircrack", "hydra", "medusa"]);

  // Extract target host/IP for more specific pattern grouping
  const ipMatch = inner.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  const targetSuffix = ipMatch ? `@${ipMatch[1]}` : "";

  if (SCAN_TOOLS.has(baseCmd)) return `network-scan${targetSuffix}`;
  if (SMB_TOOLS.has(baseCmd)) return `smb-probe${targetSuffix}`;
  if (HTTP_TOOLS.has(baseCmd)) return `http-request${targetSuffix}`;
  if (SSH_TOOLS.has(baseCmd)) return `ssh-access${targetSuffix}`;
  if (EXPLOIT_TOOLS.has(baseCmd)) return `exploit-attempt${targetSuffix}`;
  if (BRUTE_TOOLS.has(baseCmd)) return `bruteforce-attempt${targetSuffix}`;

  // For python3/python scripts, use the script name instead of "python3"
  if ((baseCmd === "python3" || baseCmd === "python") && words.length > 1) {
    for (const w of words.slice(1)) {
      if (w.startsWith("-")) continue;
      // Heredocs (python3 << 'EOF') are always unique inline scripts — skip loop detection
      if (w.startsWith("<")) return null;
      // Extract script name from path (e.g. ~/.local/bin/dcomexec.py → dcomexec)
      const scriptName = w.replace(/^.*\//, "").replace(/\.py$/, "");
      if (scriptName) {
        if (EXPLOIT_TOOLS.has(scriptName)) return "exploit-attempt";
        return `bash:${scriptName}`;
      }
    }
  }

  // Heredocs with any command are generally unique — skip loop detection
  // e.g. "ruby << 'EOF'", "bash << 'HEREDOC'", "node << 'JS'"
  if (/<<[-~]?\s*['"]?\w+['"]?/.test(inner)) return null;

  // For file-writing commands (cat/tee with redirect), include target filename
  // to avoid false loop detection when creating multiple different files
  if ((baseCmd === "cat" || baseCmd === "tee") && /[>]|<</.test(inner)) {
    const fileMatch = inner.match(/>\s*(\S+)|<<.*?\n.*?\n.*?>\s*(\S+)/);
    if (fileMatch) {
      const targetFile = fileMatch[1] ?? fileMatch[2];
      if (targetFile) return `bash:${baseCmd}@${targetFile}`;
    }
  }

  // For other tools, just use the binary name
  return `bash:${baseCmd}`;
}

// ─── Lightweight JSON Schema Validator ───────────────────────────
// Validates basic JSON Schema constraints without pulling in Ajv (~150KB).
// Covers: type, required, properties, enum, minimum, maximum, minLength, maxLength, pattern, items.

function validateJsonSchema(data: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errors: string[] = [];

  // type check
  if (schema.type) {
    const schemaType = schema.type as string;
    const actualType = Array.isArray(data) ? "array" : data === null ? "null" : typeof data;
    if (schemaType === "integer") {
      if (typeof data !== "number" || !Number.isInteger(data)) {
        errors.push(`${path}: expected integer, got ${actualType}`);
        return errors;
      }
    } else if (actualType !== schemaType) {
      errors.push(`${path}: expected ${schemaType}, got ${actualType}`);
      return errors;
    }
  }

  // enum
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).includes(data)) {
      errors.push(`${path}: value must be one of [${(schema.enum as unknown[]).join(", ")}]`);
    }
  }

  // string constraints
  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push(`${path}: string length ${data.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errors.push(`${path}: string length ${data.length} > maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      if (!new RegExp(schema.pattern).test(data)) {
        errors.push(`${path}: string does not match pattern "${schema.pattern}"`);
      }
    }
  }

  // number constraints
  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
    }
  }

  // object constraints
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (schema.required && Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, propSchema] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
        if (key in obj) {
          errors.push(...validateJsonSchema(obj[key], propSchema, `${path}.${key}`));
        }
      }
    }
  }

  // array constraints
  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push(`${path}: array length ${data.length} < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      errors.push(`${path}: array length ${data.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < data.length; i++) {
        errors.push(...validateJsonSchema(data[i], schema.items as Record<string, unknown>, `${path}[${i}]`));
      }
    }
  }

  return errors;
}

// ─── Text-based Tool Call Extraction ─────────────────────────────
// Local models (Qwen, etc.) often emit tool calls as JSON in text content
// instead of using OpenAI's native tool_calls format. This extracts them.

interface ExtractedToolCall {
  name: string;
  input: Record<string, unknown>;
  prefixText: string;
}

function extractToolCallsFromText(text: string, tools: ToolRegistry): ExtractedToolCall[] {
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
      const parsed = JSON.parse(match[1]);
      const rawName = parsed.name ?? parsed.function ?? parsed.tool;
      const toolName = typeof rawName === "string" ? (toolNameMap.get(rawName.toLowerCase()) ?? rawName) : null;
      const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
      if (toolName && knownTools.has(toolName)) {
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({ name: toolName, input: typeof args === "object" ? args : {}, prefixText: text.slice(0, firstMatchIndex) });
      }
    } catch { /* not valid JSON */ }
  }
  if (results.length > 0) return results;

  // Pattern 2: Raw JSON {"name": "ToolName", "arguments": {...}} anywhere in text
  const rawJsonRe = /\{\s*"(?:name|function|tool)"\s*:\s*"(\w+)"\s*,\s*"(?:arguments|parameters|input)"\s*:\s*(\{[^}]*\})\s*\}/g;
  while ((match = rawJsonRe.exec(text)) !== null) {
    const rawName = match[1];
    const toolName = rawName ? (toolNameMap.get(rawName.toLowerCase()) ?? rawName) : null;
    if (toolName && knownTools.has(toolName)) {
      try {
        const args = JSON.parse(match[2]);
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({ name: toolName, input: typeof args === "object" ? args : {}, prefixText: text.slice(0, firstMatchIndex) });
      } catch { /* bad args JSON */ }
    }
  }
  if (results.length > 0) return results;

  // Pattern 3: Code block containing a shell command — common with small models
  // ```bash\nsome command\n``` or ```\nsome command\n```
  const bashBlockRe = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n\s*```/g;
  while ((match = bashBlockRe.exec(text)) !== null) {
    const cmd = match[1].trim();
    // Only extract if it looks like a real command (not multiline explanation)
    if (cmd && !cmd.includes("\n") && cmd.length < 500 && !cmd.startsWith("#") && !cmd.startsWith("//")) {
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
          input: { command: firstArg, description: `Execute: ${firstArg.slice(0, 60)}` },
          prefixText: text.slice(0, firstMatchIndex),
        });
      }
    }
  }

  return results;
}

// ─── Retry Logic ─────────────────────────────────────────────────

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Retry on network errors and common HTTP errors
    if (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("unable to connect") ||
      msg.includes("timeout") ||
      msg.includes("socket") ||
      msg.includes("429") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503")
    ) {
      return true;
    }
  }
  return false;
}

function computeRetryDelay(attempt: number): number {
  // Exponential backoff: 0.5s, 1s, 2s, 4s, 8s capped at MAX_RETRY_DELAY_MS
  const baseDelay = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempt),
    MAX_RETRY_DELAY_MS,
  );
  // 75-100% jitter
  const jitter = 0.75 + Math.random() * 0.25;
  return Math.round(baseDelay * jitter);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Message Conversion ─────────────────────────────────────────

/**
 * Convert internal Message[] to OpenAI-compatible message format.
 */
function convertToOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System message first
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks
    if (msg.role === "assistant") {
      // Collect text and tool_calls from assistant blocks
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          // Include thinking as text prefix (local models don't have thinking blocks)
          textParts.push(`<thinking>${block.thinking}</thinking>`);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    } else if (msg.role === "user") {
      // User messages may contain tool_result blocks
      const textParts: string[] = [];
      const toolResults: OpenAIMessage[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : block.content
                  .map((b) => {
                    if (b.type === "text") return b.text;
                    return JSON.stringify(b);
                  })
                  .join("\n");
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: content,
          });
        }
      }

      // Tool results go as separate "tool" role messages
      for (const tr of toolResults) {
        result.push(tr);
      }

      // Any plain text from the user block
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
    }
  }

  return result;
}

/**
 * Convert tool definitions to OpenAI function-calling format.
 */
function convertToOpenAITools(
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[],
): OpenAIToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ─── Anthropic Message Conversion ────────────────────────────────

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Convert internal Message[] to Anthropic Messages API format.
 * Key differences from OpenAI:
 * - System prompt is NOT a message — goes in top-level `system` field
 * - tool_use/tool_result are content blocks inside user/assistant messages (not separate roles)
 * - Strict user/assistant alternation required
 */
function convertToAnthropicMessages(
  messages: Message[],
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // Merge consecutive same-role messages (Anthropic requires strict alternation)
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        if (typeof last.content === "string") {
          last.content = last.content + "\n\n" + msg.content;
        } else {
          last.content.push({ type: "text", text: msg.content });
        }
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
      continue;
    }

    // Complex content blocks — convert to Anthropic format
    const blocks: AnthropicContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        // Include thinking as text (Anthropic extended thinking is model-native, we just pass text)
        blocks.push({ type: "text", text: `<thinking>${block.thinking}</thinking>` });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : block.content.map((b) => b.type === "text" ? b.text : JSON.stringify(b)).join("\n");
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content,
          is_error: block.is_error,
        });
      }
    }

    if (blocks.length === 0) continue; // Skip empty content

    // Merge consecutive same-role messages
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }, ...blocks];
      } else {
        last.content.push(...blocks);
      }
    } else {
      result.push({ role: msg.role, content: blocks });
    }
  }

  // Anthropic requires conversation to start with user message
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: "Hello." });
  }

  return result;
}

/**
 * Convert tool definitions to Anthropic format.
 * Anthropic uses { name, description, input_schema } — which is already our internal format.
 */
function convertToAnthropicTools(
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[],
): AnthropicToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

// ─── SSE Stream Parser ──────────────────────────────────────────

interface SSEChunk {
  type: "content_delta" | "tool_call_delta" | "finish" | "usage" | "error";
  // content_delta
  content?: string;
  // tool_call_delta
  toolCallIndex?: number;
  toolCallId?: string;
  functionName?: string;
  functionArgDelta?: string;
  // finish
  finishReason?: string;
  // usage
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Parse an SSE stream from the OpenAI-compatible API and yield structured chunks.
 */
async function* parseSSEStream(
  response: Response,
): AsyncGenerator<SSEChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // Skip empty lines and comments

        if (trimmed === "data: [DONE]") {
          return;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          let parsed: any;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            continue; // Skip malformed JSON
          }

          const choice = parsed.choices?.[0];
          if (!choice) {
            // Check for usage-only messages
            if (parsed.usage) {
              yield {
                type: "usage",
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            continue;
          }

          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          // Content delta
          if (delta?.content) {
            yield { type: "content_delta", content: delta.content };
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: "tool_call_delta",
                toolCallIndex: tc.index ?? 0,
                toolCallId: tc.id ?? undefined,
                functionName: tc.function?.name ?? undefined,
                functionArgDelta: tc.function?.arguments ?? undefined,
              };
            }
          }

          // Finish reason
          if (finishReason) {
            yield { type: "finish", finishReason };
          }

          // Usage in chunk
          if (parsed.usage) {
            yield {
              type: "usage",
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.usage) {
            yield {
              type: "usage",
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an SSE stream from Anthropic's Messages API and yield structured chunks.
 * Anthropic uses event: lines before data: lines, and a different JSON structure.
 */
async function* parseAnthropicSSEStream(
  response: Response,
): AsyncGenerator<SSEChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEventType = "";
  // Track content block types by index so we know if a delta is text or tool input
  const blockTypes = new Map<number, string>(); // index -> "text" | "tool_use"
  const blockToolIds = new Map<number, string>(); // index -> tool_use id

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        // Track event type
        if (trimmed.startsWith("event: ")) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          continue;
        }

        switch (currentEventType) {
          case "message_start": {
            // Contains usage.input_tokens
            const usage = parsed.message?.usage;
            if (usage) {
              yield {
                type: "usage",
                promptTokens: usage.input_tokens ?? 0,
                completionTokens: usage.output_tokens ?? 0,
              };
            }
            break;
          }

          case "content_block_start": {
            const idx = parsed.index ?? 0;
            const block = parsed.content_block;
            if (block?.type === "tool_use") {
              blockTypes.set(idx, "tool_use");
              blockToolIds.set(idx, block.id ?? "");
              yield {
                type: "tool_call_delta",
                toolCallIndex: idx,
                toolCallId: block.id,
                functionName: block.name,
              };
            } else if (block?.type === "text") {
              blockTypes.set(idx, "text");
            }
            break;
          }

          case "content_block_delta": {
            const idx = parsed.index ?? 0;
            const delta = parsed.delta;

            if (delta?.type === "text_delta" && delta.text) {
              yield { type: "content_delta", content: delta.text };
            } else if (delta?.type === "input_json_delta" && delta.partial_json !== undefined) {
              yield {
                type: "tool_call_delta",
                toolCallIndex: idx,
                toolCallId: blockToolIds.get(idx),
                functionArgDelta: delta.partial_json,
              };
            }
            break;
          }

          case "content_block_stop": {
            // Block finished — nothing special needed
            break;
          }

          case "message_delta": {
            // Contains stop_reason and output usage
            if (parsed.delta?.stop_reason) {
              const reason = parsed.delta.stop_reason;
              // Map Anthropic stop reasons to our internal format
              const mapped = reason === "end_turn" ? "stop"
                : reason === "tool_use" ? "tool_calls"
                : reason === "max_tokens" ? "length"
                : reason === "stop_sequence" ? "stop"
                : reason;
              yield { type: "finish", finishReason: mapped };
            }
            if (parsed.usage) {
              yield {
                type: "usage",
                promptTokens: parsed.usage.input_tokens ?? 0,
                completionTokens: parsed.usage.output_tokens ?? 0,
              };
            }
            break;
          }

          case "message_stop": {
            // Stream complete
            return;
          }

          case "error": {
            const errMsg = parsed.error?.message ?? "Unknown Anthropic API error";
            yield { type: "error", content: errMsg };
            return;
          }
        }

        currentEventType = ""; // Reset after processing
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Conversation Manager ────────────────────────────────────────

export class ConversationManager {
  private config: KCodeConfig;
  private state: ConversationState;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private _systemPromptReady: Promise<void>;
  private contextWindowSize: number;
  private maxRetries: number;
  private cumulativeUsage: TokenUsage;
  private permissions: PermissionManager;
  private hooks: HookManager;
  private rateLimiter: RateLimiter;
  private undoManager: UndoManager;
  private transcript: TranscriptManager;
  private compactThreshold: number;
  private checkpoints: Array<{ label: string; messageIndex: number; undoSize: number; timestamp: number }> = [];
  private static MAX_CHECKPOINTS = 10;
  private abortController: AbortController | null = null;
  private turnsSincePromptRebuild = 0;
  private systemPromptHash = "";
  private sessionStartTime = Date.now();
  private sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private static MAX_TURN_COSTS = 500; // cap to prevent unbounded memory growth
  private turnCosts: TurnCostEntry[] = [];

  constructor(config: KCodeConfig, tools: ToolRegistry) {
    this.config = config;
    this.tools = tools;
    this.systemPrompt = ""; // initialized async via initSystemPrompt()
    this.systemPromptHash = "";
    this._systemPromptReady = this.initSystemPrompt();
    this.contextWindowSize = config.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW;
    this.compactThreshold = config.compactThreshold ?? 0.75;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
    this.permissions = new PermissionManager(config.permissionMode, config.workingDirectory, config.additionalDirs, config.permissionRules);
    this.hooks = new HookManager(config.workingDirectory);
    this.rateLimiter = new RateLimiter(
      config.rateLimit?.maxPerMinute ?? 60,
      config.rateLimit?.maxConcurrent ?? 2,
    );
    this.undoManager = new UndoManager();
    this.transcript = new TranscriptManager();
    this.state = {
      messages: [],
      tokenCount: 0,
      toolUseCount: 0,
    };
    this.cumulativeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    // Initialize audit logging if enabled by managed policy
    if (config.auditLog) {
      try {
        const { initAuditLogger, auditLog } = require("./audit-logger.js");
        initAuditLogger({ enabled: true, orgId: config.orgId });
        auditLog({
          eventType: "session_start",
          action: `Session started (model: ${config.model})`,
          status: "success",
          model: config.model,
          sessionId: this.sessionId,
          orgId: config.orgId,
        });
      } catch {
        // Audit logger not available, continue without it
      }
    }
  }

  /** Build system prompt asynchronously (distillation requires async Pro check). */
  private async initSystemPrompt(): Promise<void> {
    this.systemPrompt = await SystemPromptBuilder.build(this.config, this.config.version);
    this.systemPromptHash = this.hashString(this.systemPrompt);
  }

  /** Access the permission manager (e.g., to set the prompt callback from the UI). */
  getPermissions(): PermissionManager {
    return this.permissions;
  }

  /** Set the sudo password prompt callback (called from UI layer). */
  setSudoPasswordPromptFn(fn: SudoPasswordPromptFn): void {
    _setSudoPasswordPromptFn(fn);
  }

  /** Access the hook manager (e.g., to force reload). */
  getHooks(): HookManager {
    return this.hooks;
  }

  /** Access the undo manager (e.g., for /undo command). */
  getUndo(): UndoManager {
    return this.undoManager;
  }

  /** Access the rate limiter (e.g., for /ratelimit dashboard). */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  /** Access the config (e.g., for /config inspector). */
  getConfig(): KCodeConfig {
    return this.config;
  }

  /** Override the session ID (e.g., from --session-id flag). */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Get the effective max agent turns based on effort level. */
  private getEffectiveMaxTurns(): number {
    switch (this.config.effortLevel) {
      case "low": return 5;
      case "high": return 40;
      case "max": return 60;
      default: return MAX_AGENT_TURNS; // "medium" or unset = 25
    }
  }

  /** Abort the current LLM request / agent loop. */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      log.info("session", "Request aborted by user");
    }
  }

  /** Whether a request is currently in progress. */
  get isRunning(): boolean {
    return this.abortController !== null;
  }

  /**
   * Send a user message and get back an async generator of StreamEvents.
   * The generator runs the full agent loop: streaming response, tool execution, repeat.
   */
  async *sendMessage(userMessage: string): AsyncGenerator<StreamEvent> {
    // Ensure system prompt is built (async due to Pro check in distillation)
    await this._systemPromptReady;

    // Session limit check: enforce 50/month cap for free users (first message only)
    if (this.state.messages.length === 0) {
      const { checkSessionLimit } = await import("./pro.js");
      await checkSessionLimit();
    }

    // Budget guard: check if session has exceeded max budget
    if (this.config.maxBudgetUsd && this.config.maxBudgetUsd > 0) {
      try {
        const { getModelPricing, calculateCost } = await import("./pricing.js");
        const pricing = await getModelPricing(this.config.model);
        if (pricing) {
          const cost = calculateCost(pricing, this.cumulativeUsage.inputTokens, this.cumulativeUsage.outputTokens);
          if (cost >= this.config.maxBudgetUsd) {
            yield { type: "error", error: new Error(`Budget limit reached: $${cost.toFixed(2)} >= $${this.config.maxBudgetUsd.toFixed(2)}. Use --max-budget-usd to increase.`), retryable: false };
            yield { type: "turn_end", stopReason: "error" };
            return;
          }
        } else {
          log.warn("budget", `No pricing data for model "${this.config.model}" — budget limit ($${this.config.maxBudgetUsd}) cannot be enforced`);
        }
      } catch { /* non-critical, continue */ }
    }

    // Start transcript session on first message (skip if --no-session-persistence)
    if (!this.config.noSessionPersistence) {
      if (!this.transcript.isActive) {
        this.transcript.startSession(userMessage, this.config.sessionName);
      } else {
        this.transcript.append("user", "user_message", userMessage);
      }
    }

    this.state.messages.push({
      role: "user",
      content: userMessage,
    });

    // Layer 7: Update user model from message signals
    try { getUserModel().updateFromMessage(userMessage); } catch { /* ignore */ }

    // Layer 9: Reset intention engine for new turn
    try { getIntentionEngine().reset(); } catch { /* ignore */ }

    // Smart context: inject relevant file hints + code snippets based on user query
    try {
      const { getCodebaseIndex } = await import("./codebase-index.js");
      const idx = getCodebaseIndex(this.config.workingDirectory);

      if (this.state.messages.length <= 6) {
        // Early messages: inject rich snippets with actual code
        const snippets = idx.formatRelevantSnippets(userMessage, 60);
        if (snippets) {
          this.state.messages.push({
            role: "user",
            content: `[SYSTEM CONTEXT] ${snippets}`,
          });
        }
      } else if (this.state.messages.length <= 20) {
        // Later messages: inject lighter file hints only
        const contextHint = idx.formatRelevantContext(userMessage);
        if (contextHint) {
          this.state.messages.push({
            role: "user",
            content: `[SYSTEM CONTEXT] ${contextHint}`,
          });
        }
      }
    } catch { /* non-critical */ }

    // Auto-invoke skills: match user message against trigger patterns
    // Injects Level 2 (full body) of matched skills as system context
    try {
      const { SkillManager } = await import("./skills.js");
      const sm = new SkillManager(this.config.workingDirectory);
      const matched = sm.matchAutoInvoke(userMessage);
      if (matched.length > 0) {
        const skillContext = matched
          .map((s) => {
            const body = sm.getLevel2Body(s.name);
            return body ? `[SKILL: ${s.name}]\n${body}` : null;
          })
          .filter(Boolean)
          .join("\n\n");
        if (skillContext) {
          this.state.messages.push({
            role: "user",
            content: `[SYSTEM CONTEXT — Auto-invoked skills]\n${skillContext}`,
          });
        }
      }
    } catch { /* non-critical */ }

    // Auto-save checkpoint before each agent loop starts
    try {
      this.saveCheckpoint("auto:agent-loop-start");
    } catch { /* non-critical */ }

    // Wrap the agent loop to record events to transcript
    for await (const event of this.runAgentLoop()) {
      this.recordTranscriptEvent(event);
      yield event;
    }
  }

  private recordTranscriptEvent(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        // Text deltas are accumulated — we record the final text in turn_end via messages
        break;
      case "thinking_delta":
        break;
      case "tool_executing":
        this.transcript.append("assistant", "tool_use", JSON.stringify({
          id: event.toolUseId,
          name: event.name,
          input: event.input,
        }));
        break;
      case "tool_result":
        this.transcript.append("tool", "tool_result", JSON.stringify({
          tool_use_id: event.toolUseId,
          name: event.name,
          content: (event.result ?? "").slice(0, 2000),
          is_error: event.isError,
        }));
        break;
      case "error":
        this.transcript.append("system", "error", event.error.message);
        break;
      case "turn_end": {
        // Record the final assistant text from the last message
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
          for (const block of lastMsg.content) {
            if (block.type === "text") {
              this.transcript.append("assistant", "assistant_text", block.text);
            } else if (block.type === "thinking") {
              this.transcript.append("assistant", "thinking", block.thinking);
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Agent loop: stream a response from the LLM, collect tool calls, execute them, and loop.
   * Stops when the LLM's finish_reason is "stop" or there are no tool calls.
   */
  private async *runAgentLoop(): AsyncGenerator<StreamEvent> {
    this.abortController = new AbortController();
    let turnCount = 0;
    let consecutiveDenials = 0;
    let inlineWarningCount = 0;
    let forceStopLoop = false; // set by inline warning force-stop; allows one final text turn then breaks
    let maxTokensContinuations = 0; // track how many times we auto-continued after max_tokens
    let jsonSchemaRetries = 0; // track JSON schema validation retries to prevent infinite loops
    let emptyEndTurnCount = 0; // track empty end_turn retries to avoid infinite loop
    const turnStartMs = Date.now();
    const crossTurnSigs = new Map<string, number>(); // track identical tool calls across turns
    const MAX_LOOP_PATTERNS = 200; // cap to prevent unbounded Map growth
    const loopPatterns = new Map<string, { count: number; warned: boolean; redirects: number; examples: string[] }>(); // semantic loop detection

    while (true) {
      // Hard break after force-stop allowed one final text turn
      if (forceStopLoop) {
        log.warn("session", "Force-stop: breaking agent loop after final text turn");
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      }

      turnCount++;

      // Periodically rebuild system prompt (includes dynamic data like git status, user model)
      // Uses hash-based caching to skip rebuild if nothing changed
      this.turnsSincePromptRebuild++;
      if (this.turnsSincePromptRebuild >= 5) {
        const candidate = SystemPromptBuilder.build(this.config, this.config.version);
        const candidateHash = this.hashString(candidate);
        if (candidateHash !== this.systemPromptHash) {
          this.systemPrompt = candidate;
          this.systemPromptHash = candidateHash;
          log.info("session", "System prompt rebuilt (content changed)");
        }
        this.turnsSincePromptRebuild = 0;
      }

      const effectiveMaxTurns = this.getEffectiveMaxTurns();
      if (turnCount > effectiveMaxTurns + 1) {
        // Hard kill — model ignored the stop instruction, break immediately
        log.warn("session", `Agent loop hard-killed at turn ${turnCount} — model refused to stop`);
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      } else if (turnCount > effectiveMaxTurns) {
        log.warn("session", `Agent loop exceeded ${effectiveMaxTurns} turns, forcing stop`);
        this.state.messages.push({
          role: "user",
          content: `[SYSTEM] STOP. You have used ${turnCount} consecutive tool turns. Summarize what you accomplished and stop. Do NOT make any more tool calls.`,
        });
        forceStopLoop = true;
      } else if (turnCount === 15) {
        // Nudge the model to wrap up — it's been going for a while
        this.state.messages.push({
          role: "user",
          content: "[SYSTEM] You have been running tools for 15 turns. Please wrap up your current task soon and report your progress. Only continue if you are close to finishing.",
        });
      }
      // Check if aborted
      if (this.abortController?.signal.aborted) {
        yield { type: "turn_end", stopReason: "aborted" };
        this.abortController = null;
        return;
      }

      // Prune context if approaching the limit (auto-compacts via LLM when possible)
      yield* this.pruneMessagesIfNeeded();

      // Hard safety: if still over 95% after compaction, emergency prune oldest messages
      const postPruneTokens = this.estimateContextTokens();
      const hardLimit = this.contextWindowSize * 0.95;
      if (postPruneTokens >= hardLimit && this.state.messages.length > 6) {
        const dropCount = Math.max(2, Math.floor(this.state.messages.length * 0.3));
        log.warn("session", `Emergency prune: ~${postPruneTokens} tokens >= 95% of ${this.contextWindowSize}. Dropping ${dropCount} oldest messages.`);
        const kept = this.state.messages.slice(0, 1); // keep system/first message
        const rest = this.state.messages.slice(1);
        const remaining = rest.slice(dropCount);
        this.state.messages = [...kept, { role: "user" as const, content: `[SYSTEM] Context was emergency-pruned to avoid exceeding the ${this.contextWindowSize}-token limit. ${dropCount} older messages were removed. Continue with the current task.` }, ...remaining];
        this.state.tokenCount = this.estimateContextTokens();
        yield { type: "compaction_start", messageCount: dropCount, tokensBefore: postPruneTokens };
        yield { type: "compaction_end", tokensAfter: this.state.tokenCount, method: "pruned" };
      }

      yield { type: "turn_start" };

      const assistantContent: ContentBlock[] = [];
      let toolCalls: ToolUseBlock[] = [];
      let stopReason = "end_turn";
      let turnInputTokens = 0;
      let turnOutputTokens = 0;

      // Track in-progress tool calls by index
      const activeToolCalls = new Map<
        number,
        { id: string; name: string; argChunks: string[] }
      >();
      let textChunks: string[] = [];

      // Check response cache before making API call
      const cacheKey = generateCacheKey(this.config.model, this.state.messages.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })));
      const cachedText = getCachedResponse(cacheKey);
      if (cachedText) {
        // Replay cached response
        log.info("cache", "Cache hit — replaying response");
        const words = cachedText.split(" ");
        for (let wi = 0; wi < words.length; wi++) {
          const chunk = (wi > 0 ? " " : "") + words[wi];
          yield { type: "text_delta", text: chunk };
          textChunks.push(chunk);
        }
        assistantContent.push({ type: "text", text: cachedText });
        this.state.messages.push({ role: "assistant", content: cachedText });
        yield { type: "turn_end", stopReason: "end_turn" };
        break;
      }

      // Stream the API response with retry logic
      let sseStream: AsyncGenerator<SSEChunk>;
      try {
        await this.rateLimiter.acquire();
        sseStream = await this.createStreamWithRetry();
      } catch (error) {
        this.rateLimiter.release();
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }

      let streamedOutputChars = 0; // track chars for estimated token count

      try {
        for await (const chunk of sseStream) {
          switch (chunk.type) {
            case "content_delta": {
              if (chunk.content) {
                textChunks.push(chunk.content);
                streamedOutputChars += chunk.content.length;
                yield { type: "text_delta", text: chunk.content };
                // Emit estimated token count (~4 chars per token) during streaming
                const estimatedTokens = Math.round(streamedOutputChars / 4);
                yield { type: "token_count", tokens: estimatedTokens };
              }
              break;
            }

            case "tool_call_delta": {
              const idx = chunk.toolCallIndex ?? 0;
              let active = activeToolCalls.get(idx);

              // New tool call starting
              if (chunk.toolCallId && chunk.functionName) {
                active = {
                  id: chunk.toolCallId,
                  name: chunk.functionName,
                  argChunks: [],
                };
                activeToolCalls.set(idx, active);
                yield {
                  type: "tool_use_start",
                  toolUseId: chunk.toolCallId,
                  name: chunk.functionName,
                };
              } else if (!active && chunk.toolCallId) {
                // Tool call ID without name yet - create placeholder
                active = {
                  id: chunk.toolCallId,
                  name: "",
                  argChunks: [],
                };
                activeToolCalls.set(idx, active);
              } else if (!active && chunk.functionName) {
                // Name without ID - create with generated ID
                const id = `call_${Date.now()}_${idx}`;
                active = {
                  id,
                  name: chunk.functionName,
                  argChunks: [],
                };
                activeToolCalls.set(idx, active);
                yield {
                  type: "tool_use_start",
                  toolUseId: id,
                  name: chunk.functionName,
                };
              }

              // Update name if it arrives later
              if (active && chunk.functionName && !active.name) {
                active.name = chunk.functionName;
                yield {
                  type: "tool_use_start",
                  toolUseId: active.id,
                  name: active.name,
                };
              }

              // Accumulate argument fragments
              if (active && chunk.functionArgDelta) {
                active.argChunks.push(chunk.functionArgDelta);
                streamedOutputChars += chunk.functionArgDelta.length;
                yield {
                  type: "tool_input_delta",
                  toolUseId: active.id,
                  partialJson: chunk.functionArgDelta,
                };
                const estimatedTokens = Math.round(streamedOutputChars / 4);
                yield { type: "token_count", tokens: estimatedTokens };
              }
              break;
            }

            case "finish": {
              // Map OpenAI finish reasons to our internal ones
              if (chunk.finishReason === "tool_calls") {
                stopReason = "tool_use";
              } else if (chunk.finishReason === "stop") {
                stopReason = "end_turn";
              } else if (chunk.finishReason === "length") {
                stopReason = "max_tokens";
              } else {
                stopReason = chunk.finishReason ?? "end_turn";
              }
              break;
            }

            case "usage": {
              const usage: TokenUsage = {
                inputTokens: chunk.promptTokens ?? 0,
                outputTokens: chunk.completionTokens ?? 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
              };
              turnInputTokens += usage.inputTokens;
              turnOutputTokens += usage.outputTokens;
              this.accumulateUsage(usage);
              yield { type: "usage_update", usage: { ...this.cumulativeUsage } };
              break;
            }
          }
        }
      } catch (error) {
        // Stream-level errors that weren't retried
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      } finally {
        this.rateLimiter.release();
      }

      // Finalize text content
      const fullText = textChunks.join("");

      // Extract tool calls from text when the model doesn't use native tool_calls
      // (common with local models like Qwen2.5-Coder that output JSON in content)
      if (activeToolCalls.size === 0 && fullText.length > 0) {
        const extracted = extractToolCallsFromText(fullText, this.tools);
        if (extracted.length > 0) {
          // Add remaining non-tool text
          if (extracted[0].prefixText.trim()) {
            assistantContent.push({ type: "text", text: extracted[0].prefixText.trim() });
          }
          for (const ext of extracted) {
            const toolBlock: ToolUseBlock = {
              type: "tool_use",
              id: `toolu_text_${crypto.randomUUID().slice(0, 8)}`,
              name: ext.name,
              input: ext.input,
            };
            assistantContent.push(toolBlock);
            toolCalls.push(toolBlock);
          }
          stopReason = "tool_use";
        } else if (fullText.length > 0) {
          assistantContent.push({ type: "text", text: fullText });
        }
      } else if (fullText.length > 0) {
        assistantContent.push({ type: "text", text: fullText });
      }

      // Finalize tool calls
      for (const [, active] of activeToolCalls) {
        const fullJson = active.argChunks.join("");
        let parsedInput: Record<string, unknown> = {};
        if (fullJson.length > 0) {
          try {
            parsedInput = JSON.parse(fullJson);
          } catch {
            if (fullJson.length > 50000) {
              parsedInput = { _raw: `[truncated: ${fullJson.length} chars of malformed JSON]` };
              log.warn("llm", `Truncated malformed tool args: ${fullJson.length} chars`);
            } else {
              parsedInput = { _raw: fullJson };
            }
          }
        }
        const toolBlock: ToolUseBlock = {
          type: "tool_use",
          id: active.id,
          name: active.name,
          input: parsedInput,
        };
        assistantContent.push(toolBlock);
        toolCalls.push(toolBlock);
      }

      // Store assistant message in conversation history
      this.state.messages.push({
        role: "assistant",
        content: assistantContent,
      });

      // If force-stop is set, refuse to execute any more tools regardless of what the model wants
      if (forceStopLoop && toolCalls.length > 0) {
        log.warn("session", `Force-stop active but model returned ${toolCalls.length} tool calls — dropping them`);
        // Strip tool calls from assistant content, keep only text
        const textOnly = assistantContent.filter(b => b.type === "text");
        if (textOnly.length > 0) {
          this.state.messages[this.state.messages.length - 1] = {
            role: "assistant",
            content: textOnly,
          };
        }
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      }

      // Record per-turn cost entry
      if (turnInputTokens > 0 || turnOutputTokens > 0) {
        try {
          const { getModelPricing, calculateCost } = await import("./pricing.js");
          const pricing = await getModelPricing(this.config.model);
          const costUsd = pricing ? calculateCost(pricing, turnInputTokens, turnOutputTokens) : 0;
          this.turnCosts.push({
            turnIndex: this.turnCosts.length + 1,
            model: this.config.model,
            inputTokens: turnInputTokens,
            outputTokens: turnOutputTokens,
            costUsd,
            toolCalls: toolCalls.map(tc => tc.name),
            timestamp: Date.now(),
          });
          // Evict oldest entries if over cap (keep recent + running totals accurate)
          if (this.turnCosts.length > ConversationManager.MAX_TURN_COSTS) {
            this.turnCosts = this.turnCosts.slice(-ConversationManager.MAX_TURN_COSTS);
          }
        } catch { /* cost tracking is non-critical */ }
      }

      // Client-side JSON schema validation
      if (this.config.jsonSchema && toolCalls.length === 0 && fullText.length > 0) {
        try {
          const schema = this.config.jsonSchema.startsWith("{")
            ? JSON.parse(this.config.jsonSchema)
            : JSON.parse(readFileSync(this.config.jsonSchema, "utf-8"));
          // Strip markdown code fences that models often wrap JSON in
          let jsonText = fullText.trim();
          const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
          if (fenceMatch) jsonText = fenceMatch[1]!.trim();
          const parsed = JSON.parse(jsonText);
          const errors = validateJsonSchema(parsed, schema);
          if (errors.length > 0) {
            if (jsonSchemaRetries >= 3) {
              log.warn("llm", `JSON schema validation failed after ${jsonSchemaRetries} retries, accepting output as-is`);
            } else {
              jsonSchemaRetries++;
              log.warn("llm", `JSON schema validation failed (attempt ${jsonSchemaRetries}/3): ${errors.join(", ")}`);
              this.state.messages.push({
                role: "user",
                content: `[SYSTEM] Your JSON output failed schema validation:\n${errors.join("\n")}\n\nFix the output to match the required schema. Return ONLY valid JSON, no markdown fences.`,
              });
              yield { type: "turn_end", stopReason: "tool_use" };
              continue;
            }
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            if (jsonSchemaRetries >= 3) {
              log.warn("llm", `JSON parse failed after ${jsonSchemaRetries} retries, accepting output as-is`);
            } else {
              jsonSchemaRetries++;
              log.warn("llm", `JSON parse failed (attempt ${jsonSchemaRetries}/3): ${e.message}`);
              this.state.messages.push({
                role: "user",
                content: `[SYSTEM] Your output is not valid JSON: ${e.message}\n\nReturn ONLY valid JSON matching the required schema. Do NOT wrap in markdown code fences.`,
              });
              yield { type: "turn_end", stopReason: "tool_use" };
              continue;
            }
          }
          // Schema parsing error — skip validation
        }
      }

      // If no tool calls or stop reason is not tool_use, we're done
      if (toolCalls.length === 0 || stopReason !== "tool_use") {
        // Auto-continue on max_tokens: the model was cut off mid-response
        if (stopReason === "max_tokens" && maxTokensContinuations < 3) {
          maxTokensContinuations++;
          log.info("session", `Model hit output token limit (continuation ${maxTokensContinuations}/3) — injecting continue prompt`);
          // Assistant message already stored at line 1018 — just inject the continue prompt
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Your previous response was cut off because you hit the output token limit. Continue EXACTLY where you left off. Do not repeat what you already said — pick up mid-sentence if needed.",
          });
          yield { type: "turn_end", stopReason: "max_tokens_continue" };
          continue;
        }

        // Layer 9: Evaluate intentions and emit suggestions
        let hasHighPrioritySuggestion = false;
        try {
          const suggestions = getIntentionEngine().evaluate();
          if (suggestions.length > 0) {
            yield { type: "suggestion", suggestions };
            // Check if any high-priority suggestion indicates incomplete work
            hasHighPrioritySuggestion = suggestions.some(s => s.priority === "high" && s.type === "verify");
          }
        } catch { /* ignore */ }

        // Auto-continue: if the model stopped but has incomplete tasks, push it to continue
        if (hasHighPrioritySuggestion && turnCount <= 3) {
          log.info("session", "Auto-continuing: model stopped with incomplete tasks");
          this.state.messages.push({
            role: "user",
            content: "You stopped before completing the task. Continue working — create the actual files and finish what you planned. Do not re-plan, just execute.",
          });
          // Don't break — loop continues to next turn
          yield { type: "turn_end", stopReason };
          continue;
        }

        // Cache text-only responses (no tool calls = deterministic enough to cache)
        if (stopReason === "end_turn" && toolCalls.length === 0 && textChunks.length > 0) {
          try {
            const fullText = textChunks.join("");
            const lastUserMsg = this.state.messages.filter(m => m.role === "user").pop();
            const preview = lastUserMsg
              ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : "")
              : "";
            setCachedResponse(cacheKey, this.config.model, preview, fullText, this.state.tokenCount);
          } catch { /* caching is non-critical */ }
        }

        // Knowledge distillation: capture successful interaction pattern
        if (stopReason === "end_turn" && turnCount >= 1) {
          try {
            const example = extractExample(this.state.messages, this.config.workingDirectory);
            if (example) saveExample(example);
          } catch { /* distillation is non-critical */ }

          // Benchmark: score this interaction
          try {
            initBenchmarkSchema();
            const lastAssistant = this.state.messages.filter(m => m.role === "assistant").pop();
            const responseText = lastAssistant
              ? (typeof lastAssistant.content === "string" ? lastAssistant.content : lastAssistant.content.filter(b => b.type === "text").map(b => (b as any).text).join(""))
              : "";
            const errorCount = this.state.messages.filter(m =>
              m.role === "assistant" && Array.isArray(m.content) &&
              m.content.some(b => b.type === "tool_result" && b.is_error)
            ).length;
            const score = scoreResponse({
              response: responseText,
              toolsUsed: this.state.toolUseCount,
              errorsEncountered: errorCount,
              taskCompleted: stopReason === "end_turn",
              turnCount,
            });
            saveBenchmark({
              model: this.config.model,
              taskType: "general",
              score,
              tokensUsed: this.state.tokenCount,
              latencyMs: 0,
              details: { turns: turnCount, tools: this.state.toolUseCount },
            });
          } catch { /* benchmarking is non-critical */ }
        }

        // Safety net: if the model stops with no text after 3+ tool turns, push it to summarize
        const hasTextOutput = textChunks.join("").trim().length > 0;
        if (!hasTextOutput && turnCount >= 3 && stopReason === "end_turn" && emptyEndTurnCount < 2) {
          emptyEndTurnCount++;
          log.info("session", `Model ended turn ${turnCount} with no text output — pushing for summary (attempt ${emptyEndTurnCount}/2)`);
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] You executed tools but didn't provide any response to the user. Summarize your findings and report the results. The user is waiting for your answer.",
          });
          yield { type: "turn_end", stopReason: "empty_response_retry" };
          continue;
        }

        // Fire Stop hook — can block the conversation from ending
        if (this.hooks.hasHooks("Stop")) {
          try {
            const stopResult = await this.hooks.runStopHook("Stop", {
              stopReason,
              turnCount,
              toolsUsed: this.state.toolUseCount,
            });
            if (stopResult.blocked) {
              log.info("session", `Stop hook blocked conversation end: ${stopResult.reason}`);
              this.state.messages.push({
                role: "user",
                content: `[SYSTEM] Stop hook prevented conversation end: ${stopResult.reason}. Continue the conversation.`,
              });
              yield { type: "turn_end", stopReason: "stop_hook_blocked" };
              continue;
            }
          } catch (err) {
            log.warn("hooks", `Stop hook error: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Desktop notification for long-running tasks (>30s or 3+ tool turns)
        const elapsedMs = Date.now() - turnStartMs;
        if (elapsedMs > 30_000 || turnCount >= 3) {
          this.sendNotification("KCode", `Task completed (${turnCount} turns, ${Math.round(elapsedMs / 1000)}s)`);
        }

        yield { type: "turn_end", stopReason };
        this.abortController = null;
        break;
      }

      // Check abort between tool calls
      if (this.abortController?.signal.aborted) {
        yield { type: "turn_end", stopReason: "aborted" };
        this.abortController = null;
        return;
      }

      // Execute tool calls with permission checks and hooks
      const toolResultBlocks: ContentBlock[] = [];
      let turnHadDenial = false;

      // Pre-filter by managed policy (org-level, immutable)
      if (this.config.managedDisallowedTools?.length || this.config.disableWebAccess) {
        const filtered: typeof toolCalls = [];
        for (const call of toolCalls) {
          // Org-level tool blocklist
          if (this.config.managedDisallowedTools?.map(t => t.toLowerCase()).includes(call.name.toLowerCase())) {
            toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `Tool '${call.name}' is blocked by organization policy`, is_error: true });
            continue;
          }
          // Disable web access tools if policy says so
          if (this.config.disableWebAccess && (call.name === "WebFetch" || call.name === "WebSearch")) {
            toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `Web access tools are disabled by organization policy`, is_error: true });
            continue;
          }
          filtered.push(call);
        }
        if (filtered.length === 0) {
          this.state.messages.push({ role: "user", content: toolResultBlocks });
          continue;
        }
        toolCalls = filtered;
      }

      // Pre-filter tool calls by allowed/disallowed lists
      if (this.config.allowedTools?.length || this.config.disallowedTools?.length) {
        const filtered: typeof toolCalls = [];
        for (const call of toolCalls) {
          if (this.config.allowedTools?.length && !this.config.allowedTools.map(t => t.toLowerCase()).includes(call.name.toLowerCase())) {
            const blockedContent = `Tool '${call.name}' is not in the allowed tools list`;
            toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: blockedContent, is_error: true });
          } else if (this.config.disallowedTools?.map(t => t.toLowerCase()).includes(call.name.toLowerCase())) {
            const blockedContent = `Tool '${call.name}' is in the disallowed tools list`;
            toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: blockedContent, is_error: true });
          } else {
            filtered.push(call);
          }
        }
        if (filtered.length === 0) {
          this.state.messages.push({ role: "user", content: toolResultBlocks });
          continue;
        }
        toolCalls = filtered;
      }

      // Parallel fast-path: if ALL tool calls are read-only, execute them concurrently
      const allParallelSafe = toolCalls.length > 1 && toolCalls.every((c) => this.tools.isParallelSafe(c.name));
      if (allParallelSafe && this.permissions.getMode() === "auto") {
        log.info("tool", `Parallel execution: ${toolCalls.length} read-only tools`);

        // Emit tool_executing + queued progress events
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          yield { type: "tool_executing", name: call.name, toolUseId: call.id, input: call.input };
          yield { type: "tool_progress", toolUseId: call.id, name: call.name, status: "queued" as const, index: i, total: toolCalls.length };
        }

        // Execute all in parallel with individual timing
        const parallelStart = Date.now();
        const promises = toolCalls.map(async (c, i) => {
          const start = Date.now();
          const result = await this.tools.execute(c.name, c.input);
          return { result, durationMs: Date.now() - start, index: i };
        });

        const settled = await Promise.allSettled(promises);

        // Emit results and build tool_result blocks
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          const outcome = settled[i];
          this.state.toolUseCount++;

          if (outcome.status === "fulfilled") {
            const { result, durationMs } = outcome.value;

            // Record to persistent analytics
            try {
              const { recordToolEvent } = await import("./analytics.js");
              recordToolEvent({ sessionId: this.sessionId, toolName: call.name, model: this.config.model, durationMs, isError: !!result.is_error });
            } catch { /* non-critical */ }

            yield { type: "tool_progress", toolUseId: call.id, name: call.name, status: (result.is_error ? "error" : "done") as "done" | "error", index: i, total: toolCalls.length, durationMs };
            yield { type: "tool_result", name: call.name, toolUseId: call.id, result: result.content, isError: result.is_error, durationMs };
            toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.is_error });
          } else {
            const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            yield { type: "tool_progress", toolUseId: call.id, name: call.name, status: "error" as const, index: i, total: toolCalls.length };
            yield { type: "tool_result", name: call.name, toolUseId: call.id, result: `Error: ${errMsg}`, isError: true };
            toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `Error: ${errMsg}`, is_error: true });
          }
        }

        log.info("tool", `Parallel batch completed in ${Date.now() - parallelStart}ms`);
        this.state.messages.push({ role: "user", content: toolResultBlocks });
        continue;
      }

      // Dedup: track executed tool signatures to skip identical calls in same batch
      const executedSigs = new Map<string, number>(); // sig -> count executed

      for (const call of toolCalls) {
        this.state.toolUseCount++;

        // 0. Dedup identical tool calls within same response
        const dedupKey = call.name === "Bash"
          ? String((call.input as Record<string, unknown>).command ?? "").slice(0, 120)
          : String((call.input as Record<string, unknown>).file_path ?? (call.input as Record<string, unknown>).pattern ?? (call.input as Record<string, unknown>).query ?? JSON.stringify(call.input).slice(0, 120));
        const sig = `${call.name}:${dedupKey}`;
        const prevCount = executedSigs.get(sig) ?? 0;
        executedSigs.set(sig, prevCount + 1);

        if (prevCount >= 3) {
          const skipMsg = `BLOCKED: You already called ${call.name} with these exact parameters ${prevCount + 1} times in this response. You are in an infinite loop. STOP calling this tool and do something different.`;
          log.warn("tool", `Dedup blocked: ${sig.slice(0, 80)} (attempt ${prevCount + 1})`);
          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: skipMsg, isError: true };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: skipMsg, is_error: true });
          continue;
        }

        // Cross-turn dedup: handle identical READ/OBSERVE calls repeated across turns
        // Skip Write/Edit — rewriting same file with different content is normal iteration
        const crossCount = (call.name !== "Write" && call.name !== "Edit") ? (crossTurnSigs.get(sig) ?? 0) : 0;
        if (call.name !== "Write" && call.name !== "Edit") crossTurnSigs.set(sig, crossCount + 1);

        // Smart redirect: auto-advance Read offset instead of blocking
        if (crossCount >= 2 && call.name === "Read") {
          const input = call.input as Record<string, unknown>;
          const currentOffset = (input.offset as number) || 1;
          const limit = (input.limit as number) || 200;
          const newOffset = currentOffset + (limit * crossCount);
          (call as any)._autoAdvancedInput = { ...input, offset: newOffset, limit: limit };
          log.info("tool", `Auto-advancing Read offset to ${newOffset} (repeat #${crossCount + 1}): ${String(input.file_path ?? "").slice(0, 60)}`);
        }

        // Hard block after many repeats (genuine stuck loop)
        if (crossCount >= 6) {
          const skipMsg = `BLOCKED: You have called ${call.name} with identical parameters ${crossCount + 1} times. STOP this approach entirely. Tell the user what you've tried, what failed, and ask if they want you to try something different. Do NOT retry this same call.`;
          log.warn("tool", `Cross-turn dedup blocked: ${sig.slice(0, 80)} (attempt ${crossCount + 1})`);
          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: skipMsg, isError: true };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: skipMsg, is_error: true });
          continue;
        }

        // Semantic loop detector: catch "similar but not identical" tool calls
        // e.g. repeating nmap with different IP ranges, smbclient with different hosts
        if (call.name === "Bash") {
          const command = String((call.input as Record<string, unknown>).command ?? "");
          const pattern = extractBashLoopPattern(command);
          if (pattern) {
            const entry = loopPatterns.get(pattern) ?? { count: 0, warned: false, redirects: 0, examples: [] };
            entry.count++;
            if (entry.examples.length < 3) entry.examples.push(command.slice(0, 80));
            loopPatterns.set(pattern, entry);

            // Evict oldest entries if over cap
            if (loopPatterns.size > MAX_LOOP_PATTERNS) {
              const firstKey = loopPatterns.keys().next().value;
              if (firstKey) loopPatterns.delete(firstKey);
            }

            if (entry.count >= LOOP_PATTERN_HARD_STOP) {
              // Hard redirect: skip this call, force a strategy change, reset counter for fresh attempts
              entry.redirects++;
              log.warn("tool", `Loop pattern HARD redirect #${entry.redirects} (${pattern}): ${entry.count} similar calls — forcing strategy change`);
              entry.warned = true;
              entry.count = 0; // reset so new strategy gets fresh attempts
              entry.examples = [];
              const urgency = entry.redirects >= 3 ? "CRITICAL" : entry.redirects >= 2 ? "URGENT" : "IMPORTANT";
              const redirectMsg = `SKIPPED (redirect #${entry.redirects}): This "${pattern}" approach has been tried ${LOOP_PATTERN_HARD_STOP} times without success. This call was NOT executed. You MUST now try a COMPLETELY DIFFERENT technique to achieve the user's goal. [${urgency}] Think step by step:\n1. What did "${pattern}" attempts reveal? What is fundamentally wrong with this approach?\n2. What alternative tools, protocols, or angles haven't been tried yet?\n3. Pick the most promising NEW alternative and execute it NOW.\n\nDo NOT give up — the user wants results. Change your approach and keep going.${entry.redirects >= 2 ? "\n\nYou have been redirected " + entry.redirects + " times on this pattern. Try something RADICALLY different — different protocol, different tool, different port, different technique entirely." : ""}`;
              yield { type: "tool_result", name: call.name, toolUseId: call.id, result: redirectMsg, isError: true };
              toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: redirectMsg, is_error: true });
              continue;
            } else if (entry.count >= LOOP_PATTERN_THRESHOLD && !entry.warned) {
              // Soft redirect: inject a strategy hint as a system note in the tool result
              entry.warned = true;
              log.info("tool", `Loop pattern detected (${pattern}): ${entry.count} similar calls, injecting redirect`);
            }
          }
        }

        // 0b. Check allowed/disallowed tools filter
        if (this.config.allowedTools && this.config.allowedTools.length > 0 && !this.config.allowedTools.map(t => t.toLowerCase()).includes(call.name.toLowerCase())) {
          const blockedContent = `Tool '${call.name}' is not in the allowed tools list`;
          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: blockedContent, isError: true };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: blockedContent, is_error: true });
          continue;
        }
        if (this.config.disallowedTools && this.config.disallowedTools.map(t => t.toLowerCase()).includes(call.name.toLowerCase())) {
          const blockedContent = `Tool '${call.name}' is in the disallowed tools list`;
          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: blockedContent, isError: true };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: blockedContent, is_error: true });
          continue;
        }

        // 1. Check permissions before executing
        const permResult = await this.permissions.checkPermission(call);
        if (!permResult.allowed) {
          turnHadDenial = true;
          const deniedContent = `Permission denied: ${permResult.reason ?? "blocked by permission system"}. STOP: Do not retry this tool. Inform the user that permission mode needs to be changed (use -p auto) or approve in interactive mode.`;
          yield {
            type: "tool_result",
            name: call.name,
            toolUseId: call.id,
            result: deniedContent,
            isError: true,
          };
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: deniedContent,
            is_error: true,
          });
          continue;
        }

        // 2. Run PreToolUse hooks (may modify input or block)
        let effectiveInput = (call as any)._autoAdvancedInput ?? permResult.updatedInput ?? call.input;
        if (this.hooks.hasHooks("PreToolUse")) {
          const hookResult = await this.hooks.runPreToolUse(call);
          if (!hookResult.allowed) {
            const blockedContent = `Blocked by hook: ${hookResult.reason ?? "PreToolUse hook denied execution"}`;
            yield {
              type: "tool_result",
              name: call.name,
              toolUseId: call.id,
              result: blockedContent,
              isError: true,
            };
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: blockedContent,
              is_error: true,
            });
            continue;
          }
          if (hookResult.updatedInput) {
            effectiveInput = hookResult.updatedInput;
          }
        }

        // 3a. Auto-checkpoint conversation state before file modifications
        if (call.name === "Edit" || call.name === "Write" || call.name === "MultiEdit") {
          try {
            this.saveCheckpoint(`auto:before-${call.name}`);
          } catch { /* non-critical */ }
        }

        // 3b. Capture undo snapshot for file-modifying tools
        let undoSnapshot: import("./undo").FileSnapshot | null = null;
        let undoSnapshots: import("./undo").FileSnapshot[] | null = null;
        if ((call.name === "Edit" || call.name === "Write") && typeof effectiveInput.file_path === "string") {
          undoSnapshot = this.undoManager.captureSnapshot(effectiveInput.file_path as string);
        } else if (call.name === "MultiEdit" && Array.isArray(effectiveInput.edits)) {
          // Capture snapshots for all files in a multi-edit
          const seen = new Set<string>();
          undoSnapshots = [];
          for (const edit of effectiveInput.edits as Array<{ file_path?: string }>) {
            const fp = edit.file_path;
            if (typeof fp === "string" && !seen.has(fp)) {
              seen.add(fp);
              undoSnapshots.push(this.undoManager.captureSnapshot(fp));
            }
          }
        } else if ((call.name === "Rename" || call.name === "GrepReplace") && !effectiveInput.dry_run) {
          // For Rename/GrepReplace, we can't pre-capture all files (list unknown until execution)
          // These tools handle many files — undo relies on git for bulk revert
        }

        // 4. Layer 6: World Model — predict outcome before executing
        let prediction: { action: string; expected: string; confidence: number } | null = null;
        try { prediction = getWorldModel().predict(call.name, effectiveInput); } catch { /* ignore */ }

        // Execute the tool
        yield {
          type: "tool_executing",
          name: call.name,
          toolUseId: call.id,
          input: effectiveInput,
        };

        const toolStartMs = Date.now();
        let result: import("./types").ToolResult;

        // Stream Bash output in real-time via tool_stream events
        if (call.name === "Bash" && !(effectiveInput as Record<string, unknown>).run_in_background) {
          const streamQueue: string[] = [];
          const { setBashStreamCallback } = await import("../tools/bash.js");
          setBashStreamCallback((chunk) => { streamQueue.push(chunk); });
          const toolPromise = this.tools.execute(call.name, effectiveInput);

          // Poll for stream chunks while the tool is running
          let done = false;
          let toolResult: import("./types").ToolResult | undefined;
          toolPromise.then((r) => { toolResult = r; done = true; });

          while (!done) {
            // Drain any queued stream chunks
            while (streamQueue.length > 0) {
              const chunk = streamQueue.shift()!;
              yield { type: "tool_stream" as const, toolUseId: call.id, name: call.name, chunk };
            }
            // Wait a short interval before checking again
            await new Promise((r) => setTimeout(r, 50));
          }
          // Drain remaining chunks after completion
          while (streamQueue.length > 0) {
            const chunk = streamQueue.shift()!;
            yield { type: "tool_stream" as const, toolUseId: call.id, name: call.name, chunk };
          }
          setBashStreamCallback(undefined);
          result = toolResult!;
        } else {
          result = await this.tools.execute(call.name, effectiveInput);
        }

        const toolDurationMs = Date.now() - toolStartMs;

        // Record to persistent analytics
        try {
          const { recordToolEvent } = await import("./analytics.js");
          recordToolEvent({
            sessionId: this.sessionId,
            toolName: call.name,
            model: this.config.model,
            durationMs: toolDurationMs,
            isError: !!result.is_error,
          });
        } catch { /* non-critical */ }

        // Layer 6: Compare prediction with actual result
        try { if (prediction) getWorldModel().compare(prediction, result.content, result.is_error); } catch { /* ignore */ }

        // Layer 9: Record action for post-task evaluation
        try { getIntentionEngine().recordAction(call.name, effectiveInput, result.content, result.is_error); } catch { /* ignore */ }

        // LSP: notify file change and append diagnostics to result
        if (!result.is_error && (call.name === "Write" || call.name === "Edit")) {
          try {
            const { getLspManager } = await import("./lsp.js");
            const lsp = getLspManager();
            if (lsp?.isActive()) {
              const filePath = String(effectiveInput.file_path ?? "");
              if (filePath) {
                const { readFileSync } = await import("node:fs");
                const content = readFileSync(filePath, "utf-8");
                lsp.notifyFileChanged(filePath, content);
                await new Promise(r => setTimeout(r, 500));
                const diagMsg = lsp.formatDiagnosticsForFile(filePath);
                if (diagMsg) {
                  result = { ...result, content: result.content + "\n\n" + diagMsg };
                }
              }
            }
          } catch { /* LSP not available, ignore */ }
        }

        // After successful Edit/Write, reset cross-turn dedup for Bash/Read
        // This allows legitimate test-fix-test cycles (edit code, then re-run same curl/test)
        if (!result.is_error && (call.name === "Edit" || call.name === "Write")) {
          for (const [key] of crossTurnSigs) {
            if (key.startsWith("Bash:") || key.startsWith("Read:")) {
              crossTurnSigs.delete(key);
            }
          }
          // Also reset intention engine's action history for Bash/Read
          try { getIntentionEngine().resetTestFixCycle(); } catch { /* ignore */ }
          inlineWarningCount = 0;

          // Invalidate tool cache for modified files
          try {
            const { getToolCache } = await import("./tool-cache.js");
            const filePath = String(effectiveInput.file_path ?? "");
            if (filePath) getToolCache().invalidate(filePath);
          } catch { /* non-critical */ }
        } else if (!result.is_error && call.name === "MultiEdit") {
          try {
            const { getToolCache } = await import("./tool-cache.js");
            const edits = effectiveInput.edits as Array<{ file_path?: string }> | undefined;
            if (edits) {
              for (const edit of edits) {
                if (edit.file_path) getToolCache().invalidate(edit.file_path);
              }
            }
          } catch { /* non-critical */ }
        }

        // Record undo action if snapshot was captured and tool succeeded
        if (undoSnapshot && !result.is_error) {
          const desc = call.name === "Edit"
            ? `Edit ${effectiveInput.file_path}`
            : `Write ${effectiveInput.file_path}`;
          this.undoManager.pushAction(call.name, [undoSnapshot], desc);
        } else if (undoSnapshots && undoSnapshots.length > 0 && !result.is_error) {
          this.undoManager.pushAction("MultiEdit", undoSnapshots, `MultiEdit ${undoSnapshots.length} file(s)`);
        }

        yield {
          type: "tool_result",
          name: call.name,
          toolUseId: call.id,
          result: result.content,
          isError: result.is_error,
          durationMs: toolDurationMs,
        };

        // Truncate large tool results to protect context window
        // ~4 chars per token, leave room for other messages
        const maxResultChars = Math.floor(this.contextWindowSize * 1.5);
        let contextContent = result.content;
        if (contextContent.length > maxResultChars) {
          contextContent = contextContent.slice(0, maxResultChars)
            + `\n\n... [truncated: result was ${result.content.length} chars, showing first ${maxResultChars}]`;
          log.warn("tool", `Truncated ${call.name} result from ${result.content.length} to ${maxResultChars} chars`);
        }

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: contextContent,
          is_error: result.is_error,
        });

        // 5. Run PostToolUse hooks (for logging/notification, non-blocking)
        if (this.hooks.hasHooks("PostToolUse")) {
          await this.hooks.runPostToolUse(call, {
            tool_use_id: call.id,
            content: result.content,
            is_error: result.is_error,
          });
        }

        // 6. Auto-test suggestion: if Edit/Write/MultiEdit succeeded, suggest related tests
        if ((call.name === "Edit" || call.name === "Write" || call.name === "MultiEdit") && !result.is_error) {
          try {
            const { getTestSuggestion } = await import("./auto-test.js");
            const fp = String((call.input as any)?.file_path ?? (call.input as any)?.edits?.[0]?.file_path ?? "");
            if (fp) {
              const suggestion = getTestSuggestion(fp, this.config.workingDirectory);
              if (suggestion) {
                // Suggest running tests — the LLM can call TestRunner explicitly
                // (which goes through the permission system properly)
                const useRunner = this.tools.has("TestRunner");
                yield {
                  type: "suggestion",
                  suggestions: [{
                    type: "test",
                    message: useRunner
                      ? `Related test found: ${suggestion.testFile} — use TestRunner tool to run it`
                      : `Related test: ${suggestion.testFile} -- run with: ${suggestion.command}`,
                    priority: "low",
                  }],
                };
              }
            }
          } catch { /* auto-test is non-critical */ }
        }
      }

      this.state.messages.push({
        role: "user",
        content: toolResultBlocks,
      });

      // ── Semantic loop redirect ──────────────────────────────────
      // Check if any pattern has crossed the threshold and inject a redirect
      for (const [pattern, entry] of loopPatterns) {
        if (entry.count >= LOOP_PATTERN_HARD_STOP) {
          const examples = entry.examples.join("\n  - ");
          entry.redirects++;
          const redirectMsg = `[SYSTEM — STRATEGY CHANGE REQUIRED] You have run ${entry.count} similar "${pattern}" commands (redirect #${entry.redirects}):\n  - ${examples}\n\nThis approach is not working. You MUST now try a COMPLETELY DIFFERENT technique. Think about what other tools, protocols, or methods could achieve the user's goal. Change strategy and KEEP WORKING — do not give up.`;
          this.state.messages.push({ role: "user", content: redirectMsg });
          log.warn("session", `Loop redirect #${entry.redirects} for pattern "${pattern}" (${entry.count} calls) — forcing strategy change`);
          entry.count = 0;
          entry.examples = [];
          break; // only inject one redirect per turn
        } else if (entry.count >= LOOP_PATTERN_THRESHOLD && entry.warned) {
          // Soft redirect — nudge toward a different approach
          const redirectMsg = `[SYSTEM — PATTERN NOTICE] You have run ${entry.count} similar "${pattern}" commands. This approach doesn't seem to be working. Try a different strategy — different tools, different protocols, different angle. Keep working toward the user's goal.`;
          this.state.messages.push({ role: "user", content: redirectMsg });
          log.info("session", `Loop redirect SOFT injected for pattern "${pattern}" (${entry.count} calls)`);
          entry.warned = false;
          break;
        }
      }

      // Mid-loop budget guard: warn at 80%, stop at 100%
      if (this.config.maxBudgetUsd && this.config.maxBudgetUsd > 0) {
        try {
          const { getModelPricing, calculateCost } = await import("./pricing.js");
          const pricing = await getModelPricing(this.config.model);
          if (pricing) {
            const cost = calculateCost(pricing, this.cumulativeUsage.inputTokens, this.cumulativeUsage.outputTokens);
            const pct = Math.round((cost / this.config.maxBudgetUsd) * 100);
            if (cost >= this.config.maxBudgetUsd) {
              yield { type: "budget_warning", costUsd: cost, limitUsd: this.config.maxBudgetUsd, pct: 100 };
              yield { type: "error", error: new Error(`Budget exhausted mid-loop: $${cost.toFixed(2)} >= $${this.config.maxBudgetUsd.toFixed(2)}`), retryable: false };
              yield { type: "turn_end", stopReason: "budget_exceeded" };
              return;
            } else if (pct >= 80) {
              yield { type: "budget_warning", costUsd: cost, limitUsd: this.config.maxBudgetUsd, pct };
            }
          }
        } catch { /* non-critical */ }
      }

      // Layer 9: Inline warning — detect wasted context mid-loop
      try {
        const inlineWarning = getIntentionEngine().getInlineWarning();
        if (inlineWarning) {
          inlineWarningCount++;
          log.warn("intentions", `Inline warning #${inlineWarningCount}: ${inlineWarning.slice(0, 100)}`);

          if (inlineWarningCount >= 5) {
            // Hard stop — model is genuinely stuck after many warnings
            log.warn("intentions", "Infinite loop detected: forcing agent loop stop after 5 inline warnings");
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] FORCE STOP: You have been warned ${inlineWarningCount} times about repeating the same actions. The agent loop is being terminated. Reply with text only — summarize what you accomplished and what you could not complete.`,
            });
            // Allow one more turn for text response, then hard break
            forceStopLoop = true;
          } else if (inlineWarningCount >= 2) {
            // Strong warning — but let the model continue working on other things
            log.warn("intentions", `Inline warning #${inlineWarningCount}: model repeating actions, injecting strong redirect`);
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] WARNING #${inlineWarningCount}: You are repeating the same tool calls. The repeated calls are being BLOCKED. MOVE ON to a different task or try a completely different approach. Do NOT keep reading the same file — use offset/limit to read different sections, or use Bash with sed/grep to find what you need.`,
            });
          } else {
            this.state.messages.push({
              role: "user",
              content: `⚠️ SYSTEM WARNING: ${inlineWarning}`,
            });
          }
        }
      } catch { /* ignore */ }

      // Track consecutive permission denials to prevent infinite loops
      if (turnHadDenial) {
        consecutiveDenials++;

        // In deny mode, ALL tools will be denied — stop immediately after first attempt
        if (this.config.permissionMode === "deny") {
          log.info("session", "Deny mode: stopping agent loop after first denial");
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Permission mode is 'deny'. All tools are blocked. Do NOT attempt any tool calls. Reply with text only, explaining that you cannot perform this action because all tools are blocked. Suggest using -p auto or -p ask.",
          });
          // Allow one more turn for the text response, then hard stop
          consecutiveDenials = MAX_CONSECUTIVE_DENIALS - 1;
        } else if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
          log.warn("session", `${MAX_CONSECUTIVE_DENIALS} consecutive permission denials, stopping agent loop`);
          yield { type: "turn_end", stopReason: "permission_denied" };
          this.abortController = null;
          return;
        } else {
          // Non-deny modes: inject guidance after first denial
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Tool call was denied by the permission system. Do NOT retry the same tool. Reply with a text message explaining what happened.",
          });
        }
      } else {
        consecutiveDenials = 0;
      }

      yield { type: "turn_end", stopReason };
      // Loop continues for next agent turn
    }
  }

  /**
   * Build a complete API request (URL, headers, body, provider) for a given model.
   * Handles both OpenAI and Anthropic formats, deduplicating logic across primary/fallback paths.
   */
  /**
   * Resolve the API key for a model based on its name/baseUrl.
   * Checks provider-specific env vars first, then falls back to config.apiKey.
   */
  private resolveApiKey(modelName: string, baseUrl: string): string | undefined {
    // Provider-specific env vars (checked in priority order)
    const lower = modelName.toLowerCase();
    const urlLower = baseUrl.toLowerCase();

    if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4") || urlLower.includes("openai.com")) {
      return process.env.OPENAI_API_KEY ?? this.config.apiKey;
    }
    if (lower.startsWith("gemini") || urlLower.includes("googleapis.com") || urlLower.includes("generativelanguage")) {
      return process.env.GEMINI_API_KEY ?? this.config.apiKey;
    }
    if (urlLower.includes("groq.com")) {
      return process.env.GROQ_API_KEY ?? this.config.apiKey;
    }
    if (lower.startsWith("deepseek") || urlLower.includes("deepseek.com")) {
      return process.env.DEEPSEEK_API_KEY ?? this.config.apiKey;
    }
    if (urlLower.includes("together.xyz")) {
      return process.env.TOGETHER_API_KEY ?? this.config.apiKey;
    }

    return this.config.apiKey;
  }

  private async buildRequestForModel(
    modelName: string,
    opts?: { maxTokens?: number; includeTools?: boolean; effortLevel?: string },
  ): Promise<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    provider: ModelProvider;
    parser: (response: Response) => AsyncGenerator<SSEChunk>;
  }> {
    const provider = await getModelProvider(modelName);
    const apiBase = await getModelBaseUrl(modelName, this.config.apiBase);
    const maxTokens = opts?.maxTokens ?? this.config.maxTokens;
    const includeTools = opts?.includeTools ?? true;
    const effort = (opts?.effortLevel ?? this.config.effortLevel ?? "medium") as string;

    const effortMaxTokens = effort === "low" ? Math.min(maxTokens, 4096)
      : effort === "max" ? Math.max(maxTokens, 65536)
      : effort === "high" ? Math.max(maxTokens, 32768)
      : maxTokens;
    const effortTemperature = effort === "low" ? 0.3 : effort === "max" ? 0.9 : effort === "high" ? 0.7 : undefined;

    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (provider === "anthropic") {
      // Anthropic API: /v1/messages with x-api-key header
      const url = `${apiBase}/v1/messages`;
      const apiKey = this.config.anthropicApiKey ?? this.config.apiKey;
      if (apiKey) {
        headers["x-api-key"] = apiKey;
      }
      headers["anthropic-version"] = "2023-06-01";

      const messages = convertToAnthropicMessages(this.state.messages);
      const body: Record<string, unknown> = {
        model: modelName,
        messages,
        system: this.systemPrompt,
        max_tokens: effortMaxTokens,
        stream: true,
      };

      if (effortTemperature !== undefined) {
        body.temperature = effortTemperature;
      }

      if (includeTools) {
        const tools = convertToAnthropicTools(this.tools.getDefinitions());
        if (tools.length > 0) body.tools = tools;
      }

      return { url, headers, body, provider, parser: parseAnthropicSSEStream };
    } else {
      // OpenAI-compatible API: /v1/chat/completions with Bearer token
      const url = `${apiBase}/v1/chat/completions`;
      // Resolve API key: check provider-specific env vars, then fall back to config.apiKey
      const resolvedKey = this.resolveApiKey(modelName, apiBase);
      if (resolvedKey) {
        headers["Authorization"] = `Bearer ${resolvedKey}`;
      }

      const messages = convertToOpenAIMessages(this.systemPrompt, this.state.messages);
      const tools = includeTools ? convertToOpenAITools(this.tools.getDefinitions()) : [];

      const body: Record<string, unknown> = {
        model: modelName,
        messages,
        max_tokens: effortMaxTokens,
        stream: true,
        stream_options: { include_usage: true },
      };

      if (effortTemperature !== undefined) {
        body.temperature = effortTemperature;
      }

      if (tools.length > 0) body.tools = tools;

      // Qwen3: disable thinking mode unless explicitly requested
      if (!this.config.thinking) {
        body.chat_template_kwargs = { enable_thinking: false };
      }

      // JSON schema response format
      if (this.config.jsonSchema) {
        try {
          const schema = this.config.jsonSchema.startsWith("{")
            ? JSON.parse(this.config.jsonSchema)
            : JSON.parse(readFileSync(this.config.jsonSchema, "utf-8"));
          body.response_format = { type: "json_object" };
          body.json_schema = schema;
        } catch (e) {
          log.warn("llm", `Invalid JSON schema, ignoring: ${e}`);
        }
      }

      return { url, headers, body, provider, parser: parseSSEStream };
    }
  }

  /**
   * Execute a streaming request to a model and return the parsed SSE stream.
   * Used by both primary and fallback paths.
   */
  private async executeModelRequest(
    modelName: string,
    opts?: { maxTokens?: number; includeTools?: boolean; effortLevel?: string },
  ): Promise<AsyncGenerator<SSEChunk>> {
    const req = await this.buildRequestForModel(modelName, opts);

    log.info("llm", `Request to ${modelName} (${req.provider}) at ${req.url}`);

    // Use a long timeout for large prompts (local models can take minutes to process 40K+ tokens)
    const controller = this.abortController;
    const timeoutMs = 300_000; // 5 minutes
    const timeoutId = setTimeout(() => controller?.abort(), timeoutMs);

    const response = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller?.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("Response body is null - streaming not supported");
    }

    return req.parser(response);
  }

  /**
   * Create a streaming API call with exponential backoff retry.
   * Returns an async generator of parsed SSE chunks.
   */
  private async createStreamWithRetry(): Promise<AsyncGenerator<SSEChunk>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // Auto-route to a better model if enabled and user didn't explicitly set one
        let effectiveModel = this.config.model;
        if (this.config.autoRoute !== false && !this.config.modelExplicitlySet) {
          const recentText = this.getRecentMessageText();
          effectiveModel = await routeToModel(this.config.model, recentText);
        }

        const requestStart = Date.now();
        const stream = await this.executeModelRequest(effectiveModel);
        log.debug("llm", `Stream opened in ${Date.now() - requestStart}ms`);
        return stream;
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));

        // If the router sent us to a different model and it failed, fall back to the
        // primary model immediately instead of retrying the broken routed model.
        {
          let effectiveModel = this.config.model;
          if (this.config.autoRoute !== false && !this.config.modelExplicitlySet) {
            const recentText = this.getRecentMessageText();
            effectiveModel = await routeToModel(this.config.model, recentText);
          }
          if (effectiveModel !== this.config.model) {
            log.warn("llm", `Routed model ${effectiveModel} failed, falling back to primary ${this.config.model}`);
            try {
              const stream = await this.executeModelRequest(this.config.model);
              log.info("llm", `Primary model ${this.config.model} connected after routed model failure`);
              return stream;
            } catch (primaryErr) {
              log.error("llm", `Primary model also failed: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}`);
            }
          }
        }

        if (attempt < this.maxRetries && isRetryableError(error)) {
          const delay = computeRetryDelay(attempt);
          log.warn("llm", `Retryable error (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${delay}ms`, lastError);
          await sleep(delay);
          continue;
        }

        // Fallback model: if primary exhausted retries, try the fallback
        if (this.config.fallbackModel && this.config.fallbackModel !== this.config.model) {
          log.warn("llm", `Primary model failed, switching to fallback: ${this.config.fallbackModel}`);
          try {
            const stream = await this.executeModelRequest(this.config.fallbackModel);
            log.info("llm", `Fallback model ${this.config.fallbackModel} connected`);
            return stream;
          } catch (fallbackErr) {
            log.error("llm", `Fallback model also failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`);
          }
        }

        // Tertiary model: ultra-lightweight last resort (no tools for max compatibility)
        if (this.config.tertiaryModel && this.config.tertiaryModel !== this.config.model && this.config.tertiaryModel !== this.config.fallbackModel) {
          log.warn("llm", `Primary + fallback failed, trying tertiary model: ${this.config.tertiaryModel}`);
          try {
            const stream = await this.executeModelRequest(this.config.tertiaryModel, {
              maxTokens: Math.min(this.config.maxTokens, 4096),
              includeTools: false,
            });
            log.info("llm", `Tertiary model ${this.config.tertiaryModel} connected (no tools)`);
            return stream;
          } catch (tertiaryErr) {
            log.error("llm", `Tertiary model also failed: ${tertiaryErr instanceof Error ? tertiaryErr.message : tertiaryErr}`);
          }
        }

        // Fallback chain: try each model in fallbackModels[] once
        if (this.config.fallbackModels && this.config.fallbackModels.length > 0) {
          const triedModels = new Set([
            this.config.model,
            this.config.fallbackModel,
            this.config.tertiaryModel,
          ].filter(Boolean));

          for (const chainModel of this.config.fallbackModels) {
            if (triedModels.has(chainModel)) continue;
            triedModels.add(chainModel);

            log.warn("llm", `Falling back to model: ${chainModel}`);
            try {
              const stream = await this.executeModelRequest(chainModel);
              log.info("llm", `Fallback chain model ${chainModel} connected`);
              return stream;
            } catch (chainErr) {
              log.error("llm", `Fallback chain model ${chainModel} failed: ${chainErr instanceof Error ? chainErr.message : chainErr}`);
            }
          }
        }

        log.error("llm", `Request failed: ${lastError.message}`, lastError);
        throw lastError;
      }
    }

    throw lastError ?? new Error("Unexpected retry exhaustion");
  }

  // ─── Context Window Management ──────────────────────────────────

  /**
   * Prune older messages when approaching the context window limit.
   * Keeps the system prompt, first user message, and recent messages.
   */
  private async *pruneMessagesIfNeeded(): AsyncGenerator<StreamEvent> {
    // Estimate current context window usage from actual message content
    // NOTE: state.tokenCount is cumulative (total session), NOT current context size.
    // We must use estimateContextTokens() which counts actual message chars.
    const estimatedTokens = this.estimateContextTokens();
    const threshold = this.contextWindowSize * this.compactThreshold;
    if (estimatedTokens < threshold) {
      return;
    }

    const messages = this.state.messages;
    if (messages.length <= 4) {
      return;
    }

    log.info("session", `Context pruning triggered: ~${estimatedTokens} tokens, threshold ${Math.floor(threshold)}`);

    // Phase 1: Compress large tool results in older messages (keep last 10 messages intact)
    const compressibleEnd = Math.max(0, messages.length - 10);
    let compressed = 0;
    for (let i = 0; i < compressibleEnd; i++) {
      const msg = messages[i];
      if (Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j];
          if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 500) {
            // Summarize tool results: keep first line + truncate
            const firstLine = block.content.split("\n")[0].slice(0, 200);
            const wasError = block.is_error ? " (error)" : "";
            msg.content[j] = {
              ...block,
              content: `[Compressed] ${firstLine}${wasError} (was ${block.content.length} chars)`,
            };
            compressed++;
          }
        }
      }
    }

    if (compressed > 0) {
      log.info("session", `Compressed ${compressed} tool results`);
      yield { type: "compaction_start", messageCount: compressed, tokensBefore: estimatedTokens };
      yield { type: "compaction_end", tokensAfter: this.estimateContextTokens(), method: "compressed" };
    }

    // Re-check after compression
    const postCompressTokens = this.estimateContextTokens();
    if (postCompressTokens < threshold) {
      this.state.tokenCount = postCompressTokens;
      return;
    }

    // Phase 2: Auto-compact via LLM summary instead of blind pruning
    const keepFirst = 1;
    const keepLast = 10; // Keep enough recent messages to preserve tool call/result pairs

    if (messages.length <= keepFirst + keepLast) {
      return;
    }

    const pruneCount = Math.min(
      Math.floor((messages.length - keepFirst - keepLast) / 2) * 2,
      messages.length - keepFirst - keepLast,
    );

    if (pruneCount > 0) {
      // Notify UI that compaction is starting
      yield { type: "compaction_start", messageCount: pruneCount, tokensBefore: estimatedTokens };

      // Try LLM-based compaction first, fall back to simple pruning
      const toPrune = messages.slice(keepFirst, keepFirst + pruneCount);
      try {
        const { CompactionManager } = await import("./compaction.js");
        // Use tertiary/fallback model for compaction to avoid competing with the main model for GPU
        const compactModel = this.config.tertiaryModel ?? this.config.fallbackModel ?? this.config.model;
        if (compactModel === this.config.model) {
          log.warn("session", "No tertiary/fallback model configured — compaction uses the primary model (may compete for GPU)");
        }
        const compactor = new CompactionManager(this.config.apiKey, compactModel, this.config.apiBase);
        const summary = await compactor.compact(toPrune);
        if (summary) {
          messages.splice(keepFirst, pruneCount, summary);
          this.state.tokenCount = this.estimateContextTokens();
          log.info("session", `Auto-compacted ${pruneCount} messages into summary, ~${this.state.tokenCount} tokens remaining`);
          yield { type: "compaction_end", tokensAfter: this.state.tokenCount, method: "llm" };
          return;
        }
      } catch (err) {
        log.error("session", `Auto-compaction failed, falling back to pruning: ${err}`);
      }

      // Fallback: simple pruning
      messages.splice(keepFirst, pruneCount);
      this.state.tokenCount = this.estimateContextTokens();
      log.info("session", `Pruned ${pruneCount} old messages, ~${this.state.tokenCount} tokens remaining`);
      yield { type: "compaction_end", tokensAfter: this.state.tokenCount, method: "pruned" };
    }
  }

  /** Rough estimate of current context size in tokens from message content. */
  private estimateContextTokens(): number {
    let chars = this.systemPrompt.length;
    for (const msg of this.state.messages) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") chars += block.text.length;
          else if (block.type === "tool_result") {
            chars += typeof block.content === "string" ? block.content.length : 100;
          } else if (block.type === "tool_use") {
            chars += JSON.stringify(block.input).length;
          }
        }
      }
    }
    return Math.ceil(chars / 4); // ~4 chars per token
  }

  // ─── Usage Tracking ─────────────────────────────────────────────

  private accumulateUsage(usage: TokenUsage): void {
    this.cumulativeUsage.inputTokens += usage.inputTokens;
    this.cumulativeUsage.outputTokens += usage.outputTokens;
    this.cumulativeUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    this.cumulativeUsage.cacheReadInputTokens += usage.cacheReadInputTokens;

    // Update legacy tokenCount
    this.state.tokenCount =
      this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
  }

  // ─── Router Helpers ────────────────────────────────────────────

  /**
   * Extract text from recent messages for routing heuristics.
   * Looks at the last few messages (user + tool results) to detect content type.
   */
  private getRecentMessageText(): string {
    const parts: string[] = [];
    // Check the last 4 messages (enough to catch recent tool results)
    const recent = this.state.messages.slice(-4);
    for (const msg of recent) {
      if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push(block.text);
          } else if (block.type === "tool_result") {
            if (typeof block.content === "string") {
              parts.push(block.content);
            } else {
              for (const sub of block.content) {
                if (sub.type === "text") {
                  parts.push(sub.text);
                }
              }
            }
          }
        }
      }
    }
    return parts.join("\n");
  }

  // ─── State Access ───────────────────────────────────────────────

  getState(): ConversationState {
    return { ...this.state };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  getCompactThreshold(): number {
    return this.compactThreshold;
  }

  setCompactThreshold(value: number): void {
    this.compactThreshold = Math.max(0, Math.min(0.99, value));
  }

  getTurnCosts(): TurnCostEntry[] {
    return [...this.turnCosts];
  }

  formatCostBreakdown(): string {
    if (this.turnCosts.length === 0) return "";
    const lines: string[] = ["", "Turn-by-turn breakdown:"];
    for (const t of this.turnCosts) {
      const toolSuffix = t.toolCalls.length > 0 ? ` (${t.toolCalls.length} tool${t.toolCalls.length !== 1 ? "s" : ""})` : "";
      const costStr = t.costUsd > 0
        ? (t.costUsd < 0.01 ? `$${t.costUsd.toFixed(4)}` : `$${t.costUsd.toFixed(2)}`)
        : "$0.00";
      lines.push(
        `  Turn ${t.turnIndex}: ${t.model}${toolSuffix} — ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out — ${costStr}`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Save a checkpoint of the current conversation state.
   * @param label Optional label for the checkpoint (defaults to auto-generated)
   */
  saveCheckpoint(label?: string): void {
    const cpLabel = label ?? `checkpoint-${this.checkpoints.length + 1}`;
    // Only checkpoint if message count is reasonable (avoid OOM)
    if (this.state.messages.length > 500) return;

    this.checkpoints.push({
      label: cpLabel,
      messageIndex: this.state.messages.length,
      undoSize: this.undoManager.size,
      timestamp: Date.now(),
    });
    if (this.checkpoints.length > ConversationManager.MAX_CHECKPOINTS) {
      this.checkpoints.shift();
    }
  }

  /**
   * Rewind conversation to a specific checkpoint by index.
   * If no index is provided, rewinds to the most recent checkpoint.
   * Also undoes file changes back to that point.
   * Returns a description of what was rewound, or null if no checkpoints.
   */
  rewindToCheckpoint(index?: number): string | null {
    if (this.checkpoints.length === 0) return null;

    // Determine which checkpoint to rewind to
    let cpIndex: number;
    if (index === undefined) {
      cpIndex = this.checkpoints.length - 1;
    } else if (index < 0 || index >= this.checkpoints.length) {
      return `Invalid checkpoint index ${index}. Available: 0-${this.checkpoints.length - 1}`;
    } else {
      cpIndex = index;
    }

    const cp = this.checkpoints[cpIndex]!;

    // Remove this checkpoint and all after it
    this.checkpoints = this.checkpoints.slice(0, cpIndex);

    // Undo file changes back to checkpoint's undo stack size
    const undosNeeded = this.undoManager.size - cp.undoSize;
    const undone: string[] = [];
    for (let i = 0; i < undosNeeded; i++) {
      const result = this.undoManager.undo();
      if (result) undone.push(result);
    }

    // Truncate messages back to checkpoint's message index (clamped to current length in case pruning shortened the array)
    const safeIndex = Math.min(cp.messageIndex, this.state.messages.length);
    this.state.messages = this.state.messages.slice(0, safeIndex);
    const age = Math.round((Date.now() - cp.timestamp) / 1000);

    return [
      `Rewound to checkpoint "${cp.label}" (${age}s ago, message index ${cp.messageIndex})`,
      undone.length > 0 ? `File changes undone:\n${undone.join("\n")}` : "No file changes to undo.",
      `Remaining checkpoints: ${this.checkpoints.length}`,
    ].join("\n");
  }

  /**
   * List all saved checkpoints with their labels and timestamps.
   */
  listCheckpoints(): Array<{ index: number; label: string; messageIndex: number; timestamp: number; age: string }> {
    return this.checkpoints.map((cp, i) => {
      const ageMs = Date.now() - cp.timestamp;
      const ageSec = Math.round(ageMs / 1000);
      let age: string;
      if (ageSec < 60) age = `${ageSec}s ago`;
      else if (ageSec < 3600) age = `${Math.round(ageSec / 60)}m ago`;
      else age = `${Math.round(ageSec / 3600)}h ago`;

      return {
        index: i,
        label: cp.label,
        messageIndex: cp.messageIndex,
        timestamp: cp.timestamp,
        age,
      };
    });
  }

  /**
   * Get number of available checkpoints.
   */
  getCheckpointCount(): number {
    return this.checkpoints.length;
  }

  /**
   * Restore messages from a previous session (for --continue).
   * Sets the message history and estimates token count from content length.
   */
  restoreMessages(messages: Message[]): void {
    this.state.messages = [...messages];
    // Rough token estimate: ~4 chars per token
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            totalChars += block.text.length;
          } else if (block.type === "thinking") {
            totalChars += block.thinking.length;
          } else if (block.type === "tool_use") {
            totalChars += JSON.stringify(block.input).length;
          } else if (block.type === "tool_result") {
            totalChars += typeof block.content === "string"
              ? block.content.length
              : JSON.stringify(block.content).length;
          }
        }
      }
    }
    this.state.tokenCount = Math.ceil(totalChars / 4);
  }

  /**
   * Fork the conversation: keep current messages but start a new transcript.
   * Optionally truncate to a specific message count (fork from a point in history).
   */
  forkConversation(keepMessages?: number): { messageCount: number; sessionId: string } {
    const previousSessionId = this.sessionId;
    const msgs = keepMessages
      ? this.state.messages.slice(0, keepMessages)
      : [...this.state.messages];
    // Start a new transcript (only if session persistence is enabled)
    this.transcript = new TranscriptManager();
    const summary = msgs.length > 0
      ? (typeof msgs[0].content === "string" ? msgs[0].content : "[forked session]").slice(0, 80)
      : "forked session";
    if (!this.config.noSessionPersistence) {
      this.transcript.startSession(`[FORK] ${summary}`);
    }
    this.state.messages = msgs;

    // Generate new session ID for the fork
    const newSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionId = newSessionId;

    // Persist branch relationship (only if session persistence is enabled)
    if (!this.config.noSessionPersistence) {
      try {
        const bm = getBranchManager();
        // Ensure parent branch is registered (if not already)
        const parentBranch = bm.getBranch(previousSessionId);
        if (!parentBranch) {
          bm.saveBranch(previousSessionId, null, summary, `session-${previousSessionId}`, msgs.length);
        }
        bm.saveBranch(newSessionId, previousSessionId, `[FORK] ${summary}`, `session-${newSessionId}`, msgs.length);
      } catch {
        // Branch persistence is best-effort; don't break fork if db fails
      }
    }

    return { messageCount: msgs.length, sessionId: newSessionId };
  }

  /**
   * Collect session data for the narrative system (Layer 10).
   */
  collectSessionData(): {
    project: string;
    messagesCount: number;
    toolsUsed: string[];
    actionsCount: number;
    topicsDiscussed: string[];
    errorsEncountered: number;
    filesModified: string[];
  } {
    const toolsUsed: string[] = [];
    const filesModified: string[] = [];
    let errorsEncountered = 0;

    for (const msg of this.state.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolsUsed.push(block.name);
            if (block.name === "Write" || block.name === "Edit") {
              const fp = String((block.input as any)?.file_path ?? "");
              if (fp && !filesModified.includes(fp)) filesModified.push(fp);
            }
          }
          if (block.type === "tool_result" && block.is_error) {
            errorsEncountered++;
          }
        }
      }
    }

    return {
      project: this.config.workingDirectory,
      messagesCount: this.state.messages.length,
      toolsUsed,
      actionsCount: this.state.toolUseCount,
      topicsDiscussed: [],
      errorsEncountered,
      filesModified,
    };
  }

  /**
   * Reset conversation state for a new session.
   */
  reset(): void {
    this.state = {
      messages: [],
      tokenCount: 0,
      toolUseCount: 0,
    };
    this.cumulativeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    this.turnCosts = [];
  }

  /** Fast string hash for cache comparison (djb2). */
  private hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /** Get session start time for elapsed time tracking. */
  getSessionStartTime(): number {
    return this.sessionStartTime;
  }

  /** Send a desktop notification (Linux: notify-send, macOS: osascript). */
  sendNotification(title: string, body: string): void {
    try {
      // Strip anything that could break shell quoting
      const safeTitle = title.replace(/[^a-zA-Z0-9 _.!?-]/g, "");
      const safeBody = body.replace(/[^a-zA-Z0-9 _.!?:,()-]/g, "");
      const { execSync } = require("node:child_process");
      if (process.platform === "linux") {
        execSync(`notify-send "${safeTitle}" "${safeBody}" 2>/dev/null`, { timeout: 3000 });
      } else if (process.platform === "darwin") {
        execSync(`osascript -e 'display notification "${safeBody}" with title "${safeTitle}"' 2>/dev/null`, { timeout: 3000 });
      }
    } catch {
      // Silent failure — notifications are best-effort
    }
  }

  /** Get list of files modified in this session (from undo manager). */
  getModifiedFiles(): string[] {
    const files: string[] = [];
    for (const msg of this.state.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit")) {
            const fp = String((block.input as any)?.file_path ?? "");
            if (fp && !files.includes(fp)) files.push(fp);
          }
        }
      }
    }
    return files;
  }
}
