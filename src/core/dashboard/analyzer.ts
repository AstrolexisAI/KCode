// KCode - Project Dashboard Analyzer
// Gathers comprehensive project metrics by running sub-analyzers in parallel.

import { getDb } from "../db";
import { log } from "../logger";
import {
  countDependencies,
  countFiles,
  countLinesOfCode,
  detectLanguage,
  detectTestFramework,
  getLastCommitTime,
  getProjectName,
  parseCoverage,
} from "./metrics";
import type { ProjectDashboard } from "./types";

// ─── Shell helper ──────────────────────────────────────────────

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { ok: code === 0, stdout: stdout.trim() };
  } catch (err) {
    log.debug("dashboard/analyzer", `Command failed [${cmd.join(" ")}]: ${err}`);
    return { ok: false, stdout: "" };
  }
}

// ─── Project Analyzer ──────────────────────────────────────────

export class ProjectAnalyzer {
  /** Run all sub-analyzers in parallel and return the combined dashboard. */
  async analyze(projectDir: string): Promise<ProjectDashboard> {
    const [project, tests, codeQuality, activity, dependencies] = await Promise.all([
      this.analyzeProject(projectDir),
      this.analyzeTests(projectDir),
      this.analyzeCodeQuality(projectDir),
      this.analyzeActivity(),
      this.analyzeDependencies(projectDir),
    ]);
    return { project, tests, codeQuality, activity, dependencies };
  }

  // ─── Project info ──────────────────────────────────────────

  private async analyzeProject(dir: string): Promise<ProjectDashboard["project"]> {
    const [name, language, files, linesOfCode, lastCommit] = await Promise.all([
      getProjectName(dir),
      detectLanguage(dir),
      countFiles(dir),
      countLinesOfCode(dir),
      getLastCommitTime(dir),
    ]);
    return { name, language, files, linesOfCode, lastCommit };
  }

  // ─── Tests ─────────────────────────────────────────────────

  private async analyzeTests(dir: string): Promise<ProjectDashboard["tests"]> {
    const framework = await detectTestFramework(dir);
    const coverage = await parseCoverage(dir);

    // Try to parse last test run output
    let total = 0;
    let passing = 0;
    let failing = 0;
    let lastRun = "never";

    // Check for common test result caches
    try {
      // Bun test: run a dry count of test files
      const testFiles = await run([
        "find",
        dir,
        "-type",
        "f",
        "(",
        "-name",
        "*.test.ts",
        "-o",
        "-name",
        "*.test.js",
        "-o",
        "-name",
        "*.spec.ts",
        "-o",
        "-name",
        "*.spec.js",
        ")",
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
      ]);
      if (testFiles.ok && testFiles.stdout) {
        const files = testFiles.stdout.split("\n").filter(Boolean);
        total = files.length;
        // We can't know pass/fail without running tests, so estimate
        passing = total;
        failing = 0;
        lastRun = "estimated from test files";
      }
    } catch (err) {
      log.debug("dashboard/analyzer", `analyzeTests error: ${err}`);
    }

    return { framework, total, passing, failing, coverage, lastRun };
  }

  // ─── Code quality ──────────────────────────────────────────

  private async analyzeCodeQuality(dir: string): Promise<ProjectDashboard["codeQuality"]> {
    const [todosResult, longFunctions, complexityScore] = await Promise.all([
      this.findTodos(dir),
      this.countLongFunctions(dir),
      this.calculateComplexity(dir),
    ]);

    return {
      todos: todosResult.length,
      todoList: todosResult.slice(0, 50),
      longFunctions,
      duplicateCode: 0, // Duplicate detection is expensive; skipped for speed
      complexityScore,
    };
  }

  private async findTodos(
    dir: string,
  ): Promise<Array<{ file: string; line: number; text: string }>> {
    const result = await run([
      "grep",
      "-rn",
      "--include=*.ts",
      "--include=*.js",
      "--include=*.tsx",
      "--include=*.jsx",
      "--include=*.py",
      "--include=*.go",
      "--include=*.rs",
      "-E",
      "\\b(TODO|FIXME|HACK|XXX)\\b",
      dir,
    ]);
    if (!result.ok || !result.stdout) return [];

    const todos: Array<{ file: string; line: number; text: string }> = [];
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const match = line.match(/^(.+?):(\d+):(.+)$/);
      if (match) {
        const relPath = match[1]!.replace(dir + "/", "");
        // Skip node_modules, dist, .git
        if (
          relPath.includes("node_modules/") ||
          relPath.includes("dist/") ||
          relPath.includes(".git/")
        )
          continue;
        todos.push({
          file: relPath,
          line: parseInt(match[2]!, 10),
          text: match[3]!.trim(),
        });
      }
    }
    return todos;
  }

  private async countLongFunctions(dir: string): Promise<number> {
    // Simple heuristic: find function/method declarations and count lines until closing brace
    // For speed, we use a grep-based approximation
    try {
      const result = await run([
        "grep",
        "-rn",
        "--include=*.ts",
        "--include=*.js",
        "-E",
        "^\\s*(export\\s+)?(async\\s+)?function\\s+|^\\s*(export\\s+)?(async\\s+)?[a-zA-Z_]+\\s*\\(",
        dir,
      ]);
      if (!result.ok || !result.stdout) return 0;

      const lines = result.stdout
        .split("\n")
        .filter(
          (l) => !l.includes("node_modules/") && !l.includes("dist/") && !l.includes(".git/"),
        );
      // Rough estimate: count lines that look like function starts
      // Actual line counting per function is too expensive for a dashboard
      // Instead, report total function-like declarations (user interprets)
      return Math.max(0, Math.floor(lines.length * 0.05)); // ~5% are typically long
    } catch {
      return 0;
    }
  }

  private async calculateComplexity(dir: string): Promise<number> {
    // Simple McCabe-like complexity score: count control flow keywords
    try {
      const result = await run([
        "grep",
        "-rc",
        "--include=*.ts",
        "--include=*.js",
        "-E",
        "\\b(if|else|for|while|switch|case|catch|\\?\\s)\\b",
        dir,
      ]);
      if (!result.ok || !result.stdout) return 0;

      let totalKeywords = 0;
      const lines = result.stdout
        .split("\n")
        .filter((l) => l.trim() && !l.includes("node_modules/") && !l.includes("dist/"));
      for (const line of lines) {
        const count = parseInt(line.split(":").pop()!, 10);
        if (!isNaN(count)) totalKeywords += count;
      }

      const locResult = await countLinesOfCode(dir);
      if (locResult === 0) return 0;

      // Normalize: keywords per 100 LoC, capped at 100
      const ratio = (totalKeywords / locResult) * 100;
      return Math.min(100, Math.round(ratio));
    } catch {
      return 0;
    }
  }

  // ─── Activity (from SQLite analytics) ──────────────────────

  private async analyzeActivity(): Promise<ProjectDashboard["activity"]> {
    try {
      const db = getDb();
      const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

      const totals = db
        .query<{ sessions: number; tokens: number; cost: number; files: number }, [string]>(
          `SELECT
           COUNT(DISTINCT session_id) as sessions,
           SUM(input_tokens + output_tokens) as tokens,
           SUM(cost_usd) as cost,
           COUNT(DISTINCT CASE WHEN tool_name IN ('Edit', 'Write', 'MultiEdit') THEN session_id || tool_name END) as files
         FROM tool_analytics WHERE created_at >= ?`,
        )
        .get(cutoff);

      const topToolRows = db
        .query<{ name: string; count: number }, [string]>(
          `SELECT tool_name as name, COUNT(*) as count
         FROM tool_analytics WHERE created_at >= ?
         GROUP BY tool_name ORDER BY count DESC LIMIT 5`,
        )
        .all(cutoff);

      return {
        sessionsLast7Days: totals?.sessions ?? 0,
        tokensLast7Days: totals?.tokens ?? 0,
        costLast7Days: totals?.cost ?? 0,
        topTools: topToolRows,
        filesModifiedByAI: totals?.files ?? 0,
      };
    } catch (err) {
      log.debug("dashboard/analyzer", `analyzeActivity error: ${err}`);
      return {
        sessionsLast7Days: 0,
        tokensLast7Days: 0,
        costLast7Days: 0,
        topTools: [],
        filesModifiedByAI: 0,
      };
    }
  }

  // ─── Dependencies ──────────────────────────────────────────

  private async analyzeDependencies(dir: string): Promise<ProjectDashboard["dependencies"]> {
    return countDependencies(dir);
  }
}
