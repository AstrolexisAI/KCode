// KCode - Prompt-Based Hooks
// LLM-powered hooks that use natural language prompting for decisions.
// Sends tool context to a fast local model and parses the response for approve/deny/warn.

import type { PromptHookConfig } from "./hooks";
import { log } from "./logger";
import { getModelBaseUrl } from "./models";

// ─── Types ──────────────────────────────────────────────────────

export interface PromptHookResult {
  decision: "allow" | "block" | "deny" | "warn";
  reason?: string;
}

// ─── Template Expansion ─────────────────────────────────────────

function expandPromptTemplate(template: string, context: Record<string, unknown>): string {
  return template
    .replace(/\$TOOL_NAME/g, String(context.tool_name ?? ""))
    .replace(/\$TOOL_INPUT/g, JSON.stringify(context.tool_input ?? context, null, 2))
    .replace(/\$TOOL_RESULT/g, JSON.stringify(context.tool_result ?? "", null, 2))
    .replace(/\$USER_PROMPT/g, String(context.user_prompt ?? ""))
    .replace(/\$EVENT/g, String(context.event ?? ""))
    .replace(/\$COMMAND/g, String((context.tool_input as Record<string, unknown>)?.command ?? ""))
    .replace(
      /\$FILE_PATH/g,
      String((context.tool_input as Record<string, unknown>)?.file_path ?? ""),
    );
}

// ─── Response Parsing ───────────────────────────────────────────

const BLOCK_KEYWORDS = ["deny", "block", "reject", "denied", "blocked", "rejected"];
const WARN_KEYWORDS = ["warn", "warning", "caution"];
const ALLOW_KEYWORDS = ["approve", "allow", "accept", "approved", "allowed", "accepted"];

function parsePromptResponse(response: string): PromptHookResult {
  const lower = response.toLowerCase().trim();

  const firstLine = lower.split("\n")[0] ?? "";

  for (const kw of BLOCK_KEYWORDS) {
    if (firstLine.includes(kw)) {
      return { decision: "block", reason: response.trim() };
    }
  }

  for (const kw of WARN_KEYWORDS) {
    if (firstLine.includes(kw)) {
      return { decision: "warn", reason: response.trim() };
    }
  }

  for (const kw of ALLOW_KEYWORDS) {
    if (firstLine.includes(kw)) {
      return { decision: "allow", reason: response.trim() };
    }
  }

  // Check the full response if first line didn't match
  for (const kw of BLOCK_KEYWORDS) {
    if (lower.includes(kw)) {
      return { decision: "block", reason: response.trim() };
    }
  }

  for (const kw of WARN_KEYWORDS) {
    if (lower.includes(kw)) {
      return { decision: "warn", reason: response.trim() };
    }
  }

  // Default to allow if no keywords found
  return { decision: "allow", reason: response.trim() };
}

// ─── Evaluation ─────────────────────────────────────────────────

const DEFAULT_PROMPT_HOOK_MODEL = "mnemo:code3-nano";
const DEFAULT_PROMPT_HOOK_TIMEOUT = 15_000;

export async function evaluatePromptHook(
  config: PromptHookConfig,
  jsonData: string,
): Promise<PromptHookResult> {
  const model = config.model ?? DEFAULT_PROMPT_HOOK_MODEL;
  const timeout = config.timeout ?? DEFAULT_PROMPT_HOOK_TIMEOUT;

  let context: Record<string, unknown> = {};
  try {
    context = JSON.parse(jsonData);
  } catch {
    /* use empty context */
  }

  const expandedPrompt = expandPromptTemplate(config.prompt, context);

  const systemPrompt = `You are a security and code review hook. Analyze the following tool invocation and respond with one of: APPROVE, DENY, or WARN.

Your first line MUST be one of:
- "APPROVE" — the action is safe to proceed
- "DENY" — the action should be blocked (explain why)
- "WARN" — the action is suspicious but not necessarily dangerous (explain why)

Then explain your reasoning briefly.`;

  try {
    const baseUrl = await getModelBaseUrl(model);
    const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: expandedPrompt },
        ],
        max_tokens: 256,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      log.warn("prompt-hooks", `Model response error: ${response.status} ${response.statusText}`);
      return {
        decision: "allow",
        reason: `Prompt hook model error (${response.status}), defaulting to allow`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { decision: "allow", reason: "No response from prompt hook model" };
    }

    return parsePromptResponse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("prompt-hooks", `Prompt hook evaluation failed: ${msg}`);
    return { decision: "allow", reason: `Prompt hook error: ${msg}` };
  }
}
