import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMemoryStoreSchema } from "../memory-store";
import {
  buildUserPrompt,
  EXTRACTOR_SYSTEM_PROMPT,
  generateFilename,
  getMemoryTitles,
  parseExtractionResponse,
  runAutoMemoryExtraction,
  saveExtractedMemories,
  titleToSlug,
} from "./extractor";
import type { ExtractedMemory } from "./types";
import { DEFAULT_AUTO_MEMORY_CONFIG } from "./types";

// ─── parseExtractionResponse ────────────────────────────────────

describe("parseExtractionResponse", () => {
  test("parses valid JSON with memories", () => {
    const raw = JSON.stringify({
      memories: [
        {
          type: "user",
          title: "Curly is the lead developer",
          description: "User role",
          content: "Curly is the lead developer of KCode",
          confidence: 0.9,
        },
      ],
      reasoning: "User mentioned their role",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.type).toBe("user");
    expect(result.memories[0]!.title).toBe("Curly is the lead developer");
    expect(result.memories[0]!.confidence).toBe(0.9);
    expect(result.reasoning).toBe("User mentioned their role");
  });

  test("parses JSON wrapped in markdown code block", () => {
    const raw = '```json\n{"memories": [], "reasoning": "Nothing"}\n```';
    const result = parseExtractionResponse(raw);
    expect(result.memories).toHaveLength(0);
    expect(result.reasoning).toBe("Nothing");
  });

  test("parses JSON wrapped in plain code block", () => {
    const raw = '```\n{"memories": [], "reasoning": "Nothing"}\n```';
    const result = parseExtractionResponse(raw);
    expect(result.memories).toHaveLength(0);
  });

  test("handles empty memories array", () => {
    const raw = '{"memories": [], "reasoning": "Nothing memorable"}';
    const result = parseExtractionResponse(raw);
    expect(result.memories).toHaveLength(0);
    expect(result.reasoning).toBe("Nothing memorable");
  });

  test("handles invalid JSON gracefully", () => {
    const result = parseExtractionResponse("not json at all");
    expect(result.memories).toHaveLength(0);
    expect(result.reasoning).toContain("Failed");
  });

  test("filters memories with invalid types", () => {
    const raw = JSON.stringify({
      memories: [
        { type: "invalid", title: "Test", content: "Content", confidence: 0.9 },
        { type: "user", title: "Valid", content: "Valid content", confidence: 0.8 },
      ],
      reasoning: "test",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.title).toBe("Valid");
  });

  test("filters memories with missing required fields", () => {
    const raw = JSON.stringify({
      memories: [
        { type: "user", title: "No Content" }, // missing content
        { type: "user", content: "No Title" }, // missing title
        { type: "user", title: "Valid", content: "Has both", confidence: 0.8 },
      ],
      reasoning: "test",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.title).toBe("Valid");
  });

  test("clamps confidence to 0-1 range", () => {
    const raw = JSON.stringify({
      memories: [
        { type: "user", title: "High", content: "Content", confidence: 1.5 },
        { type: "user", title: "Low", content: "Content", confidence: -0.5 },
      ],
      reasoning: "test",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories[0]!.confidence).toBe(1);
    expect(result.memories[1]!.confidence).toBe(0);
  });

  test("truncates titles longer than 80 chars", () => {
    const longTitle = "A".repeat(100);
    const raw = JSON.stringify({
      memories: [{ type: "user", title: longTitle, content: "Content", confidence: 0.9 }],
      reasoning: "test",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories[0]!.title.length).toBe(80);
  });

  test("defaults missing confidence to 0.5", () => {
    const raw = JSON.stringify({
      memories: [{ type: "user", title: "Test", content: "Content" }],
      reasoning: "test",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories[0]!.confidence).toBe(0.5);
  });

  test("uses title as description fallback", () => {
    const raw = JSON.stringify({
      memories: [{ type: "user", title: "My Title", content: "Content", confidence: 0.9 }],
      reasoning: "test",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories[0]!.description).toBe("My Title");
  });

  test("extracts feedback-type memory when user corrects", () => {
    const raw = JSON.stringify({
      memories: [
        {
          type: "feedback",
          title: "No mocks in tests",
          description: "User prefers real implementations over mocks",
          content:
            "User said: 'Don't use mocks in tests, I prefer real implementations because they catch more bugs.'",
          confidence: 0.95,
        },
      ],
      reasoning: "User gave explicit feedback about testing approach",
    });
    const result = parseExtractionResponse(raw);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.type).toBe("feedback");
    expect(result.memories[0]!.confidence).toBe(0.95);
  });
});

// ─── titleToSlug ────────────────────────────────────────────────

describe("titleToSlug", () => {
  test("converts spaces to underscores", () => {
    expect(titleToSlug("Hello World")).toBe("hello_world");
  });

  test("removes special characters", () => {
    expect(titleToSlug("Don't use mocks!")).toBe("dont_use_mocks");
  });

  test("collapses multiple underscores", () => {
    expect(titleToSlug("hello   world")).toBe("hello_world");
  });

  test("trims leading/trailing underscores", () => {
    expect(titleToSlug(" hello ")).toBe("hello");
  });

  test("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(titleToSlug(long).length).toBeLessThanOrEqual(60);
  });

  test("handles empty string", () => {
    expect(titleToSlug("")).toBe("untitled");
  });

  test("handles string with only special chars", () => {
    expect(titleToSlug("!!!")).toBe("untitled");
  });
});

// ─── generateFilename ───────────────────────────────────────────

describe("generateFilename", () => {
  test("generates correct format", () => {
    expect(generateFilename("user", "Curly is lead dev")).toBe("user_curly_is_lead_dev.md");
  });

  test("handles feedback type", () => {
    expect(generateFilename("feedback", "No mocks in tests")).toBe("feedback_no_mocks_in_tests.md");
  });
});

// ─── buildUserPrompt ────────────────────────────────────────────

describe("buildUserPrompt", () => {
  test("includes context messages", () => {
    const messages = [
      { role: "user", content: "I'm the lead dev of KCode" },
      { role: "assistant", content: "Got it!" },
    ];
    const prompt = buildUserPrompt(messages, [], "2026-03-31");
    expect(prompt).toContain("[user]: I'm the lead dev of KCode");
    expect(prompt).toContain("[assistant]: Got it!");
  });

  test("includes current date", () => {
    const prompt = buildUserPrompt([], [], "2026-03-31");
    expect(prompt).toContain("2026-03-31");
  });

  test("includes existing titles", () => {
    const prompt = buildUserPrompt([], ["User Profile", "Project Roadmap"], "2026-03-31");
    expect(prompt).toContain("- User Profile");
    expect(prompt).toContain("- Project Roadmap");
  });

  test("shows (none) when no existing titles", () => {
    const prompt = buildUserPrompt([], [], "2026-03-31");
    expect(prompt).toContain("(none)");
  });
});

// ─── saveExtractedMemories ──────────────────────────────────────

describe("saveExtractedMemories", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-auto-memory-test-"));
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    initMemoryStoreSchema(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("saves memory files with correct frontmatter", async () => {
    const memories: ExtractedMemory[] = [
      {
        type: "user",
        title: "Test Memory",
        description: "A test memory for validation",
        content: "This is the memory content",
        confidence: 0.9,
      },
    ];

    const result = await saveExtractedMemories(memories, { projectPath: tempDir, db });
    expect(result.saved).toBe(1);
    expect(result.errors).toHaveLength(0);

    // The getMemoryDir uses a hash of projectPath, so let's check the db instead
    const rows = db.prepare("SELECT * FROM memory_store").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("Test Memory");
    expect(rows[0].source).toBe("auto");
    expect(rows[0].category).toBe("fact");
  });

  test("saves multiple memories", async () => {
    const memories: ExtractedMemory[] = [
      {
        type: "user",
        title: "Memory One",
        description: "First memory",
        content: "Content one",
        confidence: 0.9,
      },
      {
        type: "feedback",
        title: "Memory Two",
        description: "Second memory",
        content: "Content two",
        confidence: 0.85,
      },
    ];

    const result = await saveExtractedMemories(memories, { projectPath: tempDir, db });
    expect(result.saved).toBe(2);

    const rows = db.prepare("SELECT * FROM memory_store ORDER BY id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe("Memory One");
    expect(rows[1].key).toBe("Memory Two");
    expect(rows[1].category).toBe("convention"); // feedback -> convention
  });

  test("handles empty memories array", async () => {
    const result = await saveExtractedMemories([], { projectPath: tempDir, db });
    expect(result.saved).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── runAutoMemoryExtraction (integration) ──────────────────────

describe("runAutoMemoryExtraction", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-auto-memory-extract-"));
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    initMemoryStoreSchema(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("extracts and saves user role memory", async () => {
    const mockResponse = JSON.stringify({
      memories: [
        {
          type: "user",
          title: "User is a backend engineer",
          description: "The user is a backend engineer specializing in Go",
          content:
            "The user mentioned they are a backend engineer who primarily works with Go and PostgreSQL.",
          confidence: 0.9,
        },
      ],
      reasoning: "User mentioned their role and tech stack",
    });

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }],
          usage: { prompt_tokens: 200, completion_tokens: 100 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await runAutoMemoryExtraction({
      recentMessages: [
        { role: "user", content: "I'm a backend engineer, mainly working with Go and PostgreSQL" },
        { role: "assistant", content: "Got it! Let me help you with your Go project." },
      ],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG },
      projectPath: tempDir,
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    expect(result.saved).toBe(1);
    expect(result.total).toBe(1);

    // Check SQLite
    const rows = db.prepare("SELECT * FROM memory_store").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("User is a backend engineer");
    expect(rows[0].source).toBe("auto");
  });

  test("extracts feedback memory when user corrects", async () => {
    const mockResponse = JSON.stringify({
      memories: [
        {
          type: "feedback",
          title: "Prefer real implementations over mocks",
          description: "Testing feedback: use real implementations",
          content: "User explicitly said to not use mocks in tests because they hide real bugs.",
          confidence: 0.95,
        },
      ],
      reasoning: "User gave testing preference feedback",
    });

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }],
          usage: { prompt_tokens: 200, completion_tokens: 80 },
        }),
        { status: 200 },
      );
    };

    const result = await runAutoMemoryExtraction({
      recentMessages: [
        {
          role: "user",
          content:
            "Don't use mocks in the tests. I prefer real implementations because they catch more bugs.",
        },
        { role: "assistant", content: "Understood, I'll use real implementations." },
      ],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG },
      projectPath: tempDir,
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    expect(result.saved).toBe(1);
  });

  test("does NOT extract when nothing memorable", async () => {
    const mockResponse = JSON.stringify({
      memories: [],
      reasoning: "Nothing memorable in this exchange",
    });

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }),
        { status: 200 },
      );
    };

    const result = await runAutoMemoryExtraction({
      recentMessages: [
        { role: "user", content: "What is 2 + 2?" },
        { role: "assistant", content: "4." },
      ],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG },
      projectPath: tempDir,
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    expect(result.saved).toBe(0);
    expect(result.total).toBe(0);
  });

  test("respects minConfidence", async () => {
    const mockResponse = JSON.stringify({
      memories: [
        {
          type: "user",
          title: "Maybe uses Python",
          description: "Uncertain language preference",
          content: "User might use Python",
          confidence: 0.5,
        },
      ],
      reasoning: "Low confidence extraction",
    });

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200 },
      );
    };

    const result = await runAutoMemoryExtraction({
      recentMessages: [{ role: "user", content: "I sometimes use Python" }],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG, minConfidence: 0.7 },
      projectPath: tempDir,
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    expect(result.saved).toBe(0);
    expect(result.total).toBe(1);
  });

  test("respects maxPerTurn", async () => {
    const mockResponse = JSON.stringify({
      memories: [
        { type: "user", title: "Mem A", description: "A", content: "A content", confidence: 0.9 },
        { type: "user", title: "Mem B", description: "B", content: "B content", confidence: 0.8 },
        { type: "user", title: "Mem C", description: "C", content: "C content", confidence: 0.7 },
      ],
      reasoning: "Multiple memories",
    });

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }],
          usage: { prompt_tokens: 200, completion_tokens: 100 },
        }),
        { status: 200 },
      );
    };

    const result = await runAutoMemoryExtraction({
      recentMessages: [{ role: "user", content: "Big info dump" }],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG, maxPerTurn: 2 },
      projectPath: tempDir,
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    expect(result.saved).toBe(2);
    expect(result.total).toBe(3);
  });

  test("detects duplicates and skips them", async () => {
    const mockResponse = JSON.stringify({
      memories: [
        {
          type: "user",
          title: "User Profile",
          description: "Updated profile",
          content: "Updated content",
          confidence: 0.9,
        },
      ],
      reasoning: "Duplicate check",
    });

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }],
          usage: { prompt_tokens: 200, completion_tokens: 50 },
        }),
        { status: 200 },
      );
    };

    const result = await runAutoMemoryExtraction({
      recentMessages: [{ role: "user", content: "Something" }],
      existingTitles: ["User Profile"],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG },
      projectPath: tempDir,
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    expect(result.saved).toBe(0);
    expect(result.total).toBe(1);
  });

  test("returns zero when disabled", async () => {
    const result = await runAutoMemoryExtraction({
      recentMessages: [{ role: "user", content: "Hello" }],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG, enabled: false },
      projectPath: tempDir,
      db,
    });

    expect(result.saved).toBe(0);
    expect(result.total).toBe(0);
  });

  test("handles API failure silently", async () => {
    const failFetch = async () => {
      return new Response("Server Error", { status: 500 });
    };

    const result = await runAutoMemoryExtraction({
      recentMessages: [{ role: "user", content: "Hello" }],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG },
      projectPath: tempDir,
      customFetch: failFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    expect(result.saved).toBe(0);
    expect(result.total).toBe(0);
  });

  test("does not block (fire-and-forget timing)", async () => {
    const mockFetch = async () => {
      // Simulate a small delay
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"memories": [], "reasoning": "none"}' } }],
          usage: {},
        }),
        { status: 200 },
      );
    };

    const start = Date.now();
    const promise = runAutoMemoryExtraction({
      recentMessages: [{ role: "user", content: "Hello" }],
      existingTitles: [],
      config: { ...DEFAULT_AUTO_MEMORY_CONFIG },
      projectPath: tempDir,
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      db,
    });

    // The function returns a promise, so it can be fire-and-forget
    // In real usage: runAutoMemoryExtraction(...).catch(() => {})
    // Here we await to verify it completes
    await promise;
    const elapsed = Date.now() - start;
    // Should complete quickly (just the 10ms mock delay)
    expect(elapsed).toBeLessThan(5000);
  });
});

// ─── getMemoryTitles ────────────────────────────────────────────

describe("getMemoryTitles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-memory-titles-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when no MEMORY.md exists", async () => {
    const titles = await getMemoryTitles(tempDir);
    expect(titles).toEqual([]);
  });
});
