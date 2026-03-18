// KCode - Test Runner Tool
// Detects test framework and runs tests with failure parsing

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../core/types";

export const testRunnerDefinition: ToolDefinition = {
  name: "TestRunner",
  description:
    "Run tests for the project. Auto-detects the test framework (bun, jest, vitest, pytest, go, cargo, etc.) " +
    "and runs all tests or a specific test file/pattern. Returns structured results with pass/fail counts.",
  input_schema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "Specific test file or pattern to run (optional — runs all tests if omitted)",
      },
      framework: {
        type: "string",
        enum: ["bun", "jest", "vitest", "pytest", "go", "cargo", "npm", "make"],
        description: "Override auto-detection and use a specific test framework",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 120, max: 600)",
      },
    },
  },
};

interface DetectedFramework {
  name: string;
  command: string;
  fileArg: "append" | "flag" | "none";
}

function detectFramework(cwd: string): DetectedFramework | null {
  // Check for framework-specific files in priority order
  const checks: Array<{ files: string[]; framework: DetectedFramework }> = [
    {
      files: ["bunfig.toml"],
      framework: { name: "bun", command: "bun test", fileArg: "append" },
    },
    {
      files: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"],
      framework: { name: "vitest", command: "npx vitest run", fileArg: "append" },
    },
    {
      files: ["jest.config.ts", "jest.config.js", "jest.config.mjs"],
      framework: { name: "jest", command: "npx jest", fileArg: "append" },
    },
    {
      files: ["pytest.ini", "pyproject.toml", "setup.cfg", "conftest.py"],
      framework: { name: "pytest", command: "python -m pytest -v", fileArg: "append" },
    },
    {
      files: ["go.mod"],
      framework: { name: "go", command: "go test -v", fileArg: "append" },
    },
    {
      files: ["Cargo.toml"],
      framework: { name: "cargo", command: "cargo test", fileArg: "append" },
    },
    {
      files: ["Makefile"],
      framework: { name: "make", command: "make test", fileArg: "none" },
    },
  ];

  for (const check of checks) {
    for (const file of check.files) {
      if (existsSync(join(cwd, file))) {
        // For pyproject.toml, verify it's a Python project with pytest
        if (file === "pyproject.toml") {
          try {
            const content = readFileSync(join(cwd, file), "utf-8");
            if (!content.includes("pytest") && !content.includes("[tool.pytest")) continue;
          } catch { continue; }
        }
        return check.framework;
      }
    }
  }

  // Check package.json for test script
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test) {
        // Detect the actual runner from the script
        const testScript = pkg.scripts.test;
        if (testScript.includes("vitest")) {
          return { name: "vitest", command: "npx vitest run", fileArg: "append" };
        }
        if (testScript.includes("jest")) {
          return { name: "jest", command: "npx jest", fileArg: "append" };
        }
        if (testScript.includes("bun test")) {
          return { name: "bun", command: "bun test", fileArg: "append" };
        }
        return { name: "npm", command: "npm test --", fileArg: "append" };
      }
    }
  } catch { /* ignore */ }

  return null;
}

function parseTestOutput(output: string, framework: string): { passed: number; failed: number; skipped: number; errors: string[] } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  const lines = output.split("\n");

  switch (framework) {
    case "bun": {
      // "309 pass", "0 fail"
      for (const line of lines) {
        const passMatch = line.match(/(\d+)\s+pass/);
        const failMatch = line.match(/(\d+)\s+fail/);
        const skipMatch = line.match(/(\d+)\s+skip/);
        if (passMatch) passed = parseInt(passMatch[1], 10);
        if (failMatch) failed = parseInt(failMatch[1], 10);
        if (skipMatch) skipped = parseInt(skipMatch[1], 10);
      }
      break;
    }
    case "jest":
    case "vitest": {
      // "Tests: 5 failed, 20 passed, 25 total" or "Test Files  1 failed | 3 passed"
      for (const line of lines) {
        const summaryMatch = line.match(/(\d+)\s+failed.*?(\d+)\s+passed/);
        if (summaryMatch) {
          failed = parseInt(summaryMatch[1], 10);
          passed = parseInt(summaryMatch[2], 10);
        }
        const passOnly = line.match(/Tests:\s+(\d+)\s+passed/);
        if (passOnly && !summaryMatch) {
          passed = parseInt(passOnly[1], 10);
        }
        const skipMatch = line.match(/(\d+)\s+skipped/);
        if (skipMatch) skipped = parseInt(skipMatch[1], 10);
      }
      break;
    }
    case "pytest": {
      // "5 passed, 2 failed, 1 skipped"
      for (const line of lines) {
        const passMatch = line.match(/(\d+)\s+passed/);
        const failMatch = line.match(/(\d+)\s+failed/);
        const skipMatch = line.match(/(\d+)\s+skipped/);
        if (passMatch) passed = parseInt(passMatch[1], 10);
        if (failMatch) failed = parseInt(failMatch[1], 10);
        if (skipMatch) skipped = parseInt(skipMatch[1], 10);
      }
      break;
    }
    case "go": {
      // "ok" or "FAIL" per package, "--- FAIL:" per test
      for (const line of lines) {
        if (line.match(/^---\s+PASS:/)) passed++;
        if (line.match(/^---\s+FAIL:/)) failed++;
        if (line.match(/^---\s+SKIP:/)) skipped++;
      }
      // If no individual test lines, count ok/FAIL packages
      if (passed === 0 && failed === 0) {
        for (const line of lines) {
          if (line.startsWith("ok")) passed++;
          if (line.startsWith("FAIL")) failed++;
        }
      }
      break;
    }
    case "cargo": {
      // "test result: ok. 5 passed; 0 failed; 0 ignored"
      for (const line of lines) {
        const m = line.match(/test result:.*?(\d+)\s+passed.*?(\d+)\s+failed.*?(\d+)\s+ignored/);
        if (m) {
          passed = parseInt(m[1], 10);
          failed = parseInt(m[2], 10);
          skipped = parseInt(m[3], 10);
        }
      }
      break;
    }
  }

  // Extract failure messages (last 30 lines of stderr-like output)
  if (failed > 0) {
    const failLines: string[] = [];
    let inFailure = false;
    for (const line of lines) {
      if (line.match(/FAIL|FAILED|Error|AssertionError|assert|panic|thread.*panicked/i)) {
        inFailure = true;
      }
      if (inFailure) {
        failLines.push(line);
        if (failLines.length >= 30) break;
      }
    }
    if (failLines.length > 0) {
      errors.push(failLines.join("\n"));
    }
  }

  return { passed, failed, skipped, errors };
}

export async function executeTestRunner(input: Record<string, unknown>): Promise<ToolResult> {
  const cwd = process.cwd();
  const file = String(input.file ?? "").trim();
  const timeoutSec = Math.max(10, Math.min(600, Number(input.timeout ?? 120)));
  const timeoutMs = timeoutSec * 1000;

  // Detect or use specified framework
  let framework: DetectedFramework;
  if (input.framework) {
    const name = String(input.framework).trim();
    const manualFrameworks: Record<string, DetectedFramework> = {
      bun: { name: "bun", command: "bun test", fileArg: "append" },
      jest: { name: "jest", command: "npx jest", fileArg: "append" },
      vitest: { name: "vitest", command: "npx vitest run", fileArg: "append" },
      pytest: { name: "pytest", command: "python -m pytest -v", fileArg: "append" },
      go: { name: "go", command: "go test -v", fileArg: "append" },
      cargo: { name: "cargo", command: "cargo test", fileArg: "append" },
      npm: { name: "npm", command: "npm test --", fileArg: "append" },
      make: { name: "make", command: "make test", fileArg: "none" },
    };
    const manual = manualFrameworks[name];
    if (!manual) {
      return { tool_use_id: "", content: `Error: Unknown framework "${name}".`, is_error: true };
    }
    framework = manual;
  } else {
    const detected = detectFramework(cwd);
    if (!detected) {
      return {
        tool_use_id: "",
        content: "Error: Could not auto-detect test framework. No bunfig.toml, jest.config.*, vitest.config.*, pytest.ini, go.mod, Cargo.toml, or package.json test script found. Use framework= to specify.",
        is_error: true,
      };
    }
    framework = detected;
  }

  // Build command — sanitize file argument to prevent shell injection
  let cmd = framework.command;
  if (file && framework.fileArg === "append") {
    // Reject shell metacharacters in file argument
    if (/[;|&`$(){}[\]<>!#"'\n\r]/.test(file)) {
      return { tool_use_id: "", content: "Error: file argument contains invalid characters.", is_error: true };
    }
    // Quote the file argument to handle spaces safely
    cmd += ` "${file}"`;
  }

  try {
    const output = execSync(cmd, {
      cwd,
      stdio: "pipe",
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    }).toString();

    const parsed = parseTestOutput(output, framework.name);
    const total = parsed.passed + parsed.failed + parsed.skipped;

    return {
      tool_use_id: "",
      content: [
        `Test Results (${framework.name}):`,
        `  Passed:  ${parsed.passed}`,
        `  Failed:  ${parsed.failed}`,
        `  Skipped: ${parsed.skipped}`,
        `  Total:   ${total}`,
        "",
        parsed.failed === 0 ? "All tests passed." : "",
        parsed.errors.length > 0 ? `\nFailures:\n${parsed.errors.join("\n\n")}` : "",
        "",
        output.length > 2000 ? output.slice(-2000) : output,
      ].join("\n"),
    };
  } catch (err: unknown) {
    // Test failures often cause non-zero exit codes
    const error = err as { stdout?: Buffer; stderr?: Buffer; status?: number; message?: string };
    const stdout = error.stdout?.toString() ?? "";
    const stderr = error.stderr?.toString() ?? "";
    const output = stdout || stderr || error.message || "Unknown error";

    const parsed = parseTestOutput(output, framework.name);
    const total = parsed.passed + parsed.failed + parsed.skipped;

    if (total > 0) {
      // Test ran but some failed
      return {
        tool_use_id: "",
        content: [
          `Test Results (${framework.name}):`,
          `  Passed:  ${parsed.passed}`,
          `  Failed:  ${parsed.failed}`,
          `  Skipped: ${parsed.skipped}`,
          `  Total:   ${total}`,
          "",
          parsed.errors.length > 0 ? `Failures:\n${parsed.errors.join("\n\n")}` : "",
          "",
          output.length > 2000 ? output.slice(-2000) : output,
        ].join("\n"),
        is_error: parsed.failed > 0,
      };
    }

    return {
      tool_use_id: "",
      content: `Error running tests (${framework.name}):\n${output.slice(0, 3000)}`,
      is_error: true,
    };
  }
}
