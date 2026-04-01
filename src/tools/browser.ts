// KCode - Browser Automation Tool
// Uses Playwright for headless browser control: navigate, screenshot, extract, interact.
// Falls back to curl + readability if Playwright is not installed.

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../core/logger";
import type { ToolDefinition, ToolResult } from "../core/types";

// ─── Detection ──────────────────────────────────────────────────

let _hasPlaywright: boolean | null = null;

function hasPlaywright(): boolean {
  if (_hasPlaywright === null) {
    try {
      execSync("npx playwright --version 2>/dev/null", { stdio: "pipe", timeout: 5000 });
      _hasPlaywright = true;
    } catch {
      _hasPlaywright = false;
    }
  }
  return _hasPlaywright;
}

// ─── Tool Definition ────────────────────────────────────────────

export const browserDefinition: ToolDefinition = {
  name: "Browser",
  description: `Automate a headless browser (Chromium). Actions:

- **navigate**: Go to a URL and return page text content
  url: "https://example.com"
- **screenshot**: Take a screenshot of a page
  url: "https://example.com", output?: "/tmp/screenshot.png"
- **extract**: Extract specific CSS-selected content from a page
  url: "https://example.com", selector: "article", attribute?: "innerText"
- **click**: Click an element on the page
  url: "https://example.com", selector: "button.submit"
- **fill**: Fill a form field
  url: "https://example.com", selector: "input[name=q]", value: "search term"
- **evaluate**: Run JavaScript on a page
  url: "https://example.com", script: "document.title"

Requires Playwright installed (npx playwright install chromium). Falls back to curl for simple navigate/extract.`,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Browser action to perform",
        enum: ["navigate", "screenshot", "extract", "click", "fill", "evaluate"],
      },
      url: { type: "string", description: "URL to navigate to" },
      selector: { type: "string", description: "CSS selector for extract/click/fill" },
      value: { type: "string", description: "Value for fill action" },
      script: { type: "string", description: "JavaScript to evaluate" },
      output: { type: "string", description: "Output file path for screenshot" },
      attribute: {
        type: "string",
        description: "Element attribute to extract (default: innerText)",
      },
      wait: { type: "number", description: "Wait time in ms after navigation (default: 2000)" },
    },
    required: ["action", "url"],
  },
};

// ─── Playwright Script Generator ────────────────────────────────

function generatePlaywrightScript(input: Record<string, unknown>): string {
  const { action, url, selector, value, script, output, attribute, wait } = input as {
    action: string;
    url: string;
    selector?: string;
    value?: string;
    script?: string;
    output?: string;
    attribute?: string;
    wait?: number;
  };

  const waitMs = wait ?? 2000;
  const screenshotPath = output ?? join(tmpdir(), `kcode-screenshot-${Date.now()}.png`);

  // Generate a self-contained Playwright script
  const lines = [
    `const { chromium } = require('playwright');`,
    `(async () => {`,
    `  const browser = await chromium.launch({ headless: true });`,
    `  const page = await browser.newPage();`,
    `  try {`,
    `    await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });`,
    `    await page.waitForTimeout(${waitMs});`,
  ];

  switch (action) {
    case "navigate":
      lines.push(`    const text = await page.evaluate(() => document.body.innerText);`);
      lines.push(`    console.log(text.slice(0, 50000));`);
      break;

    case "screenshot":
      lines.push(
        `    await page.screenshot({ path: ${JSON.stringify(screenshotPath)}, fullPage: true });`,
      );
      lines.push(`    console.log("Screenshot saved: ${screenshotPath}");`);
      break;

    case "extract":
      if (!selector) throw new Error("selector is required for extract action");
      lines.push(`    const elements = await page.$$(${JSON.stringify(selector)});`);
      lines.push(`    const results = [];`);
      lines.push(`    for (const el of elements) {`);
      if (attribute && attribute !== "innerText") {
        lines.push(`      results.push(await el.getAttribute(${JSON.stringify(attribute)}));`);
      } else {
        lines.push(`      results.push(await el.innerText());`);
      }
      lines.push(`    }`);
      lines.push(`    console.log(results.join('\\n---\\n'));`);
      break;

    case "click":
      if (!selector) throw new Error("selector is required for click action");
      lines.push(`    await page.click(${JSON.stringify(selector)});`);
      lines.push(`    await page.waitForTimeout(1000);`);
      lines.push(`    const text = await page.evaluate(() => document.body.innerText);`);
      lines.push(`    console.log(text.slice(0, 50000));`);
      break;

    case "fill":
      if (!selector || !value) throw new Error("selector and value are required for fill action");
      lines.push(`    await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)});`);
      lines.push(`    console.log("Filled " + ${JSON.stringify(selector)} + " with value");`);
      break;

    case "evaluate":
      if (!script) throw new Error("script is required for evaluate action");
      // SECURITY: new Function() runs inside Playwright's browser sandbox (page.evaluate),
      // NOT in Node.js. The browser context is isolated from the host. JSON.stringify prevents
      // breaking out of the string literal. This is safe by design — equivalent to DevTools console.
      lines.push(`    const __script = ${JSON.stringify(script)};`);
      lines.push(
        `    const result = await page.evaluate((__s) => { return new Function(__s)(); }, __script);`,
      );
      lines.push(
        `    console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result));`,
      );
      break;
  }

  lines.push(`  } finally {`);
  lines.push(`    await browser.close();`);
  lines.push(`  }`);
  lines.push(`})();`);

  return lines.join("\n");
}

// ─── Fallback: curl + basic extraction ──────────────────────────

async function fallbackNavigate(url: string): Promise<string> {
  try {
    const html = execSync(
      `curl -sL --max-time 15 -H "User-Agent: Mozilla/5.0" ${JSON.stringify(url)}`,
      { stdio: "pipe", timeout: 20_000, maxBuffer: 5 * 1024 * 1024 },
    ).toString();

    // Strip HTML tags for basic text extraction
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, 50_000);
  } catch (err) {
    throw new Error(`curl fetch failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Executor ───────────────────────────────────────────────────

export async function executeBrowser(input: Record<string, unknown>): Promise<ToolResult> {
  const { requirePro } = await import("../core/pro.js");
  await requirePro("browser");

  const { action, url } = input as { action: string; url: string };

  if (!url) {
    return { tool_use_id: "", content: "url is required", is_error: true };
  }

  // Block non-HTTP URLs
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return {
      tool_use_id: "",
      content: "Only http:// and https:// URLs are supported",
      is_error: true,
    };
  }

  // If Playwright is not available, fall back for simple actions
  if (!hasPlaywright()) {
    if (action === "navigate" || action === "extract") {
      log.info("tool", `Browser: Playwright not available, using curl fallback for ${action}`);
      try {
        const text = await fallbackNavigate(url);
        return { tool_use_id: "", content: text };
      } catch (err) {
        return {
          tool_use_id: "",
          content: `Browser error: ${err instanceof Error ? err.message : err}`,
          is_error: true,
        };
      }
    }

    return {
      tool_use_id: "",
      content: `Playwright is required for '${action}' action but is not installed. Install with: npx playwright install chromium\n\nFor simple page fetching, use WebFetch instead.`,
      is_error: true,
    };
  }

  // Generate and execute Playwright script
  try {
    const script = generatePlaywrightScript(input);
    const tmpScript = join(tmpdir(), `kcode-browser-${Date.now()}.js`);
    await Bun.write(tmpScript, script);

    const output = execSync(
      `npx playwright test --reporter=list ${tmpScript} 2>/dev/null || node ${tmpScript}`,
      {
        stdio: "pipe",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
      },
    )
      .toString()
      .trim();

    // Cleanup
    try {
      unlinkSync(tmpScript);
    } catch {
      /* ignore */
    }

    return { tool_use_id: "", content: output || "(no output)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("tool", `Browser error: ${msg}`);
    return {
      tool_use_id: "",
      content: `Browser error: ${msg.slice(0, 1000)}`,
      is_error: true,
    };
  }
}
