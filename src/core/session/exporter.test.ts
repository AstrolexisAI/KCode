import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionExporter } from "./exporter";
import { SessionSearch } from "./search";

function createExporter(): { search: SessionSearch; exporter: SessionExporter } {
  const db = new Database(":memory:");
  const search = new SessionSearch(db);
  return { search, exporter: new SessionExporter(search) };
}

function seedSession(search: SessionSearch, sessionId = "test-session"): void {
  search.indexTurn(sessionId, 0, "user", "How do I fix this bug?");
  search.indexTurn(sessionId, 1, "assistant", "Let me look at the code.");
  search.indexTurn(sessionId, 2, "tool", '{"file": "src/main.ts", "content": "..."}');
  search.indexTurn(sessionId, 3, "assistant", "The issue is on line 42.");
}

describe("SessionExporter", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch {}
      }
    }
    tmpFiles.length = 0;
  });

  test("markdown format includes headers and content", async () => {
    const { search, exporter } = createExporter();
    seedSession(search);

    const md = await exporter.exportSession({
      sessionId: "test-session",
      format: "markdown",
    });

    expect(md).toContain("# Session Transcript");
    expect(md).toContain("## User (Turn 0)");
    expect(md).toContain("## Assistant (Turn 1)");
    expect(md).toContain("How do I fix this bug?");
    expect(md).toContain("Let me look at the code.");
    // Tool output should be in code block
    expect(md).toContain("```");
  });

  test("json format is valid JSON with correct structure", async () => {
    const { search, exporter } = createExporter();
    seedSession(search);

    const jsonStr = await exporter.exportSession({
      sessionId: "test-session",
      format: "json",
    });

    const parsed = JSON.parse(jsonStr);
    expect(parsed.sessionId).toBe("test-session");
    expect(parsed.turnCount).toBe(4);
    expect(parsed.turns).toHaveLength(4);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[0].content).toBe("How do I fix this bug?");
    expect(parsed.turns[0].turnIndex).toBe(0);
  });

  test("html format includes HTML tags", async () => {
    const { search, exporter } = createExporter();
    seedSession(search);

    const html = await exporter.exportSession({
      sessionId: "test-session",
      format: "html",
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("Session Transcript");
    expect(html).toContain("User (Turn 0)");
    expect(html).toContain("How do I fix this bug?");
    expect(html).toContain("</html>");
  });

  test("html format escapes HTML entities", async () => {
    const { search, exporter } = createExporter();
    search.indexTurn("s1", 0, "user", 'Use <script> & "quotes"');

    const html = await exporter.exportSession({
      sessionId: "s1",
      format: "html",
    });

    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quotes&quot;");
  });

  test("txt format uses separators", async () => {
    const { search, exporter } = createExporter();
    seedSession(search);

    const txt = await exporter.exportSession({
      sessionId: "test-session",
      format: "txt",
    });

    expect(txt).toContain("---");
    expect(txt).toContain("[User] Turn 0");
    expect(txt).toContain("[Assistant] Turn 1");
    expect(txt).toContain("How do I fix this bug?");
  });

  test("includeTimestamps adds timestamps when true", async () => {
    const { search, exporter } = createExporter();
    seedSession(search);

    const withTs = await exporter.exportSession({
      sessionId: "test-session",
      format: "markdown",
      includeTimestamps: true,
    });
    // ISO timestamp pattern
    expect(withTs).toMatch(/\d{4}-\d{2}-\d{2}T/);

    const withoutTs = await exporter.exportSession({
      sessionId: "test-session",
      format: "markdown",
      includeTimestamps: false,
    });
    // Should not contain timestamp markers used in markdown format
    expect(withoutTs).not.toMatch(/\*\d{4}-\d{2}-\d{2}T/);
  });

  test("includeToolCalls false filters out tool turns", async () => {
    const { search, exporter } = createExporter();
    seedSession(search);

    const jsonStr = await exporter.exportSession({
      sessionId: "test-session",
      format: "json",
      includeToolCalls: false,
    });

    const parsed = JSON.parse(jsonStr);
    expect(parsed.turnCount).toBe(3);
    const roles = parsed.turns.map((t: { role: string }) => t.role);
    expect(roles).not.toContain("tool");
  });

  test("outputPath writes to file", async () => {
    const { search, exporter } = createExporter();
    seedSession(search);

    const outPath = join(tmpdir(), `kcode-export-test-${Date.now()}.md`);
    tmpFiles.push(outPath);

    const content = await exporter.exportSession({
      sessionId: "test-session",
      format: "markdown",
      outputPath: outPath,
    });

    expect(existsSync(outPath)).toBe(true);
    const fileContent = await Bun.file(outPath).text();
    expect(fileContent).toBe(content);
  });

  test("empty session produces minimal output", async () => {
    const { exporter } = createExporter();

    const md = await exporter.exportSession({
      sessionId: "nonexistent",
      format: "markdown",
    });
    expect(md).toContain("No turns recorded");

    const jsonStr = await exporter.exportSession({
      sessionId: "nonexistent",
      format: "json",
    });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.turnCount).toBe(0);
    expect(parsed.turns).toHaveLength(0);

    const html = await exporter.exportSession({
      sessionId: "nonexistent",
      format: "html",
    });
    expect(html).toContain("No turns recorded");

    const txt = await exporter.exportSession({
      sessionId: "nonexistent",
      format: "txt",
    });
    expect(txt).toContain("No turns recorded");
  });
});
