// KCode - Auto-Memory Extractor
// Analyzes recent conversation turns and extracts memorable information.
// Uses the Forked Agent pattern for background LLM calls.

import { type ForkedAgentResult, runForkedAgent, simplifyMessage } from "../forked-agent";
import { log } from "../logger";
import {
  getMemoryDir,
  type MemoryMeta,
  readMemoryIndex,
  writeMemoryFile,
  writeMemoryIndex,
} from "../memory";
import { addMemory as addMemoryToStore } from "../memory-store";
import type { Message } from "../types";
import { extractTitlesFromIndex, filterMemories } from "./relevance-filter";
import type { AutoMemoryConfig, ExtractedMemory, ExtractionResult } from "./types";
import { DEFAULT_AUTO_MEMORY_CONFIG, parseAutoMemoryConfig } from "./types";

// ─── Prompts ────────────────────────────────────────────────────

export const EXTRACTOR_SYSTEM_PROMPT = `You are a memory extractor. You analyze conversations and decide if there is information worth remembering for future conversations.

MEMORY TYPES:
- user: Role, preferences, knowledge about the user
- feedback: Corrections or validations of approach ("don't do X", "yes, that's right")
- project: Decisions, deadlines, work-in-progress states
- reference: Pointers to external systems (URLs, project names, channels)

RULES:
1. Only extract what CANNOT be derived from code or git
2. Do NOT save code patterns, file conventions, or project structure
3. Convert relative dates to absolute (e.g., "on Thursday" -> actual date)
4. For feedback, include the WHY (reason given by the user)
5. Confidence >= 0.7 to save. If in doubt, don't extract.
6. Maximum 3 memories per turn (avoid spam)
7. ALWAYS respond in valid JSON

If there is nothing memorable, respond: {"memories": [], "reasoning": "Nothing memorable"}`;

export function buildUserPrompt(
  contextMessages: Array<{ role: string; content: string }>,
  existingTitles: string[],
  currentDate: string,
): string {
  const formatted = contextMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");

  const titlesSection =
    existingTitles.length > 0 ? existingTitles.map((t) => `- ${t}`).join("\n") : "(none)";

  return `Analyze this recent conversation and extract memories if any.
Current date: ${currentDate}

CONVERSATION:
${formatted}

EXISTING MEMORIES (to avoid duplicates):
${titlesSection}

Respond in JSON:`;
}

// ─── JSON Parsing ───────────────────────────────────────────────

/**
 * Parse the extractor's response into an ExtractionResult.
 * Handles both clean JSON and markdown-wrapped JSON (```json ... ```).
 */
export function parseExtractionResponse(raw: string): ExtractionResult {
  // Try to extract JSON from markdown code blocks
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);

    if (!parsed || typeof parsed !== "object") {
      return { memories: [], reasoning: "Invalid response format" };
    }

    const memories: ExtractedMemory[] = [];
    if (Array.isArray(parsed.memories)) {
      for (const m of parsed.memories) {
        if (
          m &&
          typeof m === "object" &&
          typeof m.type === "string" &&
          ["user", "feedback", "project", "reference"].includes(m.type) &&
          typeof m.title === "string" &&
          typeof m.content === "string"
        ) {
          memories.push({
            type: m.type,
            title: String(m.title).slice(0, 80),
            description: typeof m.description === "string" ? m.description : m.title,
            content: m.content,
            confidence:
              typeof m.confidence === "number" ? Math.max(0, Math.min(1, m.confidence)) : 0.5,
          });
        }
      }
    }

    return {
      memories,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    log.debug("auto-memory", `Failed to parse extraction response: ${raw.slice(0, 200)}`);
    return { memories: [], reasoning: "Failed to parse JSON response" };
  }
}

// ─── Slug Generation ────────────────────────────────────────────

/**
 * Generate a filesystem-safe slug from a title.
 */
export function titleToSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/**
 * Generate a memory filename from type and title.
 */
export function generateFilename(type: string, title: string): string {
  return `${type}_${titleToSlug(title)}.md`;
}

// ─── Save Extracted Memories ────────────────────────────────────

export interface SaveMemoryOptions {
  /** Project path for memory directory resolution */
  projectPath: string;
  /** Optional injected database (for testing) */
  db?: import("bun:sqlite").Database;
}

/**
 * Save a list of extracted memories to the filesystem and SQLite store.
 * Updates MEMORY.md index and respects the 200-line limit.
 */
export async function saveExtractedMemories(
  memories: ExtractedMemory[],
  opts: SaveMemoryOptions,
): Promise<{ saved: number; errors: string[] }> {
  const { projectPath, db } = opts;
  const memoryDir = getMemoryDir(projectPath);
  let saved = 0;
  const errors: string[] = [];

  for (const memory of memories) {
    try {
      const filename = generateFilename(memory.type, memory.title);
      const meta: MemoryMeta = {
        type: memory.type,
        title: memory.title,
        auto_extracted: true,
        date: new Date().toISOString(),
        confidence: memory.confidence,
      };

      await writeMemoryFile(memoryDir, filename, meta, memory.content);

      // Register in SQLite store
      try {
        // Map memory types to store categories
        const categoryMap: Record<string, string> = {
          user: "fact",
          feedback: "convention",
          project: "decision",
          reference: "fact",
        };
        addMemoryToStore(
          {
            category: (categoryMap[memory.type] ?? "fact") as any,
            key: memory.title,
            content: memory.content,
            confidence: memory.confidence,
            source: "auto" as any,
            approved: false,
          },
          db,
        );
      } catch (dbErr) {
        // Non-fatal: file was saved, just SQLite failed
        log.debug("auto-memory", `SQLite store failed for "${memory.title}": ${dbErr}`);
      }

      // Update MEMORY.md index
      try {
        await updateMemoryIndex(projectPath, memory, filename);
      } catch (indexErr) {
        log.debug("auto-memory", `Index update failed for "${memory.title}": ${indexErr}`);
      }

      saved++;
    } catch (err) {
      const msg = `Failed to save memory "${memory.title}": ${err instanceof Error ? err.message : err}`;
      errors.push(msg);
      log.debug("auto-memory", msg);
    }
  }

  return { saved, errors };
}

async function updateMemoryIndex(
  projectPath: string,
  memory: ExtractedMemory,
  filename: string,
): Promise<void> {
  const existing = (await readMemoryIndex(projectPath)) ?? "# Memory Index\n";
  const newLine = `- [${memory.title}](${filename}) -- ${memory.description}`;

  // Check if already referenced
  if (existing.includes(filename)) return;

  const updated = existing.trimEnd() + "\n" + newLine + "\n";
  await writeMemoryIndex(projectPath, updated);
}

// ─── Main Extraction Entrypoint ─────────────────────────────────

export interface RunAutoMemoryOptions {
  /** Recent messages (typically last 6) */
  recentMessages: Message[];
  /** Existing memory titles (to avoid duplicates) */
  existingTitles: string[];
  /** Auto-memory config */
  config: AutoMemoryConfig;
  /** Project working directory */
  projectPath: string;
  /** Optional model override */
  model?: string;
  /** Optional fetch override (for testing) */
  customFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Optional API base override (for testing) */
  apiBase?: string;
  /** Optional API key override (for testing) */
  apiKey?: string;
  /** Optional database (for testing) */
  db?: import("bun:sqlite").Database;
}

/**
 * Run the auto-memory extraction pipeline:
 * 1. Simplify messages for context
 * 2. Run forked agent with extractor prompt
 * 3. Parse and filter results
 * 4. Save accepted memories
 *
 * Returns a promise that resolves when extraction is complete.
 * Designed to be fire-and-forget (no await needed).
 */
export async function runAutoMemoryExtraction(
  opts: RunAutoMemoryOptions,
): Promise<{ saved: number; total: number }> {
  const {
    recentMessages,
    existingTitles,
    config,
    projectPath,
    model,
    customFetch,
    apiBase,
    apiKey,
    db,
  } = opts;

  if (!config.enabled) {
    return { saved: 0, total: 0 };
  }

  // Simplify messages for context
  const simplified = recentMessages.map(simplifyMessage);
  const currentDate = new Date().toISOString().split("T")[0]!;
  const userPrompt = buildUserPrompt(simplified, existingTitles, currentDate);

  return new Promise<{ saved: number; total: number }>((resolve) => {
    runForkedAgent({
      name: "auto-memory-extractor",
      systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
      contextMessages: recentMessages,
      userPrompt,
      model: model ?? config.model ?? undefined,
      timeoutMs: 15_000,
      maxTokens: 1500,
      customFetch,
      apiBase,
      apiKey,
      onComplete: async (result: ForkedAgentResult) => {
        try {
          const extraction = parseExtractionResponse(result.content);

          if (extraction.memories.length === 0) {
            log.debug("auto-memory", `No memories extracted: ${extraction.reasoning}`);
            resolve({ saved: 0, total: 0 });
            return;
          }

          // Filter against existing memories and config
          const { accepted, rejected } = filterMemories(
            extraction.memories,
            existingTitles,
            config,
          );

          for (const r of rejected) {
            log.debug("auto-memory", `Rejected "${r.memory.title}": ${r.reason}`);
          }

          if (accepted.length === 0) {
            resolve({ saved: 0, total: extraction.memories.length });
            return;
          }

          // Save accepted memories
          const { saved } = await saveExtractedMemories(accepted, { projectPath, db });
          log.info("auto-memory", `Extracted ${saved}/${extraction.memories.length} memories`);
          resolve({ saved, total: extraction.memories.length });
        } catch (err) {
          log.debug("auto-memory", `Post-extraction error: ${err}`);
          resolve({ saved: 0, total: 0 });
        }
      },
      onError: (err) => {
        log.debug("auto-memory", `Extraction failed: ${err.message}`);
        resolve({ saved: 0, total: 0 });
      },
    });
  });
}

/**
 * Get existing memory titles from the MEMORY.md index for a project.
 * Used to feed the extractor for duplicate detection.
 */
export async function getMemoryTitles(projectPath: string): Promise<string[]> {
  const index = await readMemoryIndex(projectPath);
  return extractTitlesFromIndex(index);
}
