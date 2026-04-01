import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), `kcode-audit-test-${Date.now()}`);
const TEST_OUTPUT = join(TEST_HOME, "output");

describe("enterprise/audit-export", () => {
  beforeEach(() => {
    process.env.KCODE_HOME = TEST_HOME;
    process.env.KCODE_DB_PATH = ":memory:";
    mkdirSync(TEST_HOME, { recursive: true });
    mkdirSync(TEST_OUTPUT, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.KCODE_HOME;
    delete process.env.KCODE_DB_PATH;
  });

  test("redactSensitiveData removes API keys", async () => {
    const { redactSensitiveData } = await import("./audit-export");
    const input = 'api_key: "sk-abcdef1234567890abcdef1234567890"';
    const result = redactSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcdef1234567890abcdef1234567890");
  });

  test("redactSensitiveData removes Bearer tokens", async () => {
    const { redactSensitiveData } = await import("./audit-export");
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret";
    const result = redactSensitiveData(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("redactSensitiveData removes GitHub tokens", async () => {
    const { redactSensitiveData } = await import("./audit-export");
    const input = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = redactSensitiveData(input);
    expect(result).toContain("[REDACTED]");
  });

  test("redactSensitiveData preserves normal text", async () => {
    const { redactSensitiveData } = await import("./audit-export");
    const input = "This is a normal log message about Read tool";
    expect(redactSensitiveData(input)).toBe(input);
  });

  test("formatCsv produces correct CSV header and rows", async () => {
    const { formatCsv } = await import("./audit-export");
    const entries = [
      {
        timestamp: "2026-01-01T00:00:00Z",
        user: "session-123",
        tool: "Read",
        parameters_summary: "file: /tmp/test.ts",
        result_status: "success",
        duration_ms: 42,
      },
      {
        timestamp: "2026-01-01T00:01:00Z",
        user: "session-123",
        tool: "Bash",
        parameters_summary: "command: ls",
        result_status: "error",
        duration_ms: 100,
      },
    ];

    const csv = formatCsv(entries);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("timestamp,user,tool,parameters_summary,result_status,duration_ms");
    expect(lines.length).toBe(3); // header + 2 rows
    expect(lines[1]).toContain("Read");
    expect(lines[2]).toContain("Bash");
    expect(lines[2]).toContain("error");
  });

  test("formatCsv escapes quotes in fields", async () => {
    const { formatCsv } = await import("./audit-export");
    const entries = [
      {
        timestamp: "2026-01-01T00:00:00Z",
        user: 'session "quoted"',
        tool: "Write",
        parameters_summary: "test",
        result_status: "success",
        duration_ms: 10,
      },
    ];

    const csv = formatCsv(entries);
    expect(csv).toContain('""quoted""');
  });

  test("formatCsv handles empty array", async () => {
    const { formatCsv } = await import("./audit-export");
    const csv = formatCsv([]);
    expect(csv).toBe("timestamp,user,tool,parameters_summary,result_status,duration_ms");
  });

  test("formatJson produces valid JSON array", async () => {
    const { formatJson } = await import("./audit-export");
    const entries = [
      {
        timestamp: "2026-01-01T00:00:00Z",
        user: "session-1",
        tool: "Grep",
        parameters_summary: "pattern: TODO",
        result_status: "success",
        duration_ms: 55,
      },
    ];

    const json = formatJson(entries);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].tool).toBe("Grep");
    expect(parsed[0].duration_ms).toBe(55);
  });

  test("formatJson handles empty array", async () => {
    const { formatJson } = await import("./audit-export");
    const json = formatJson([]);
    expect(JSON.parse(json)).toEqual([]);
  });

  test("exportAuditLog throws if from > to", async () => {
    const { exportAuditLog } = await import("./audit-export");
    const outputPath = join(TEST_OUTPUT, "audit.json");
    expect(
      exportAuditLog({
        from: new Date("2026-12-31"),
        to: new Date("2026-01-01"),
        format: "json",
        outputPath,
      }),
    ).rejects.toThrow("'from' date must be before 'to' date");
  });

  test("exportAuditLog writes JSON file", async () => {
    const { exportAuditLog } = await import("./audit-export");
    const outputPath = join(TEST_OUTPUT, "audit.json");
    const result = await exportAuditLog({
      from: new Date("2020-01-01"),
      to: new Date("2030-12-31"),
      format: "json",
      outputPath,
    });

    expect(result).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("exportAuditLog writes CSV file", async () => {
    const { exportAuditLog } = await import("./audit-export");
    const outputPath = join(TEST_OUTPUT, "audit.csv");
    const result = await exportAuditLog({
      from: new Date("2020-01-01"),
      to: new Date("2030-12-31"),
      format: "csv",
      outputPath,
    });

    expect(result).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf-8");
    expect(content.startsWith("timestamp,")).toBe(true);
  });

  test("queryAuditEntries returns entries with correct shape", async () => {
    const { queryAuditEntries } = await import("./audit-export");
    const entries = queryAuditEntries(new Date("2020-01-01"), new Date("2030-12-31"));
    expect(Array.isArray(entries)).toBe(true);
    for (const e of entries) {
      expect(typeof e.timestamp).toBe("string");
      expect(typeof e.user).toBe("string");
      expect(typeof e.tool).toBe("string");
      expect(typeof e.parameters_summary).toBe("string");
      expect(typeof e.result_status).toBe("string");
      expect(typeof e.duration_ms).toBe("number");
    }
  });
});
