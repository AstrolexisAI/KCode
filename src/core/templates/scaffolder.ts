// KCode - Template Scaffolder
// Orchestrates project generation from templates via AI model calls.

import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { log } from "../logger";
import { TemplateEngine } from "./engine";
import type { Template, ScaffoldResult } from "./types";

// ─── Direct model call (avoids importing full conversation loop) ─

async function callModel(
  systemPrompt: string,
  userPrompt: string,
  apiBase: string,
  model: string,
  apiKey?: string,
): Promise<string> {
  const url = `${apiBase.replace(/\/$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 16384,
    temperature: 0.3,
  });

  const response = await fetch(url, { method: "POST", headers, body });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model API error (${response.status}): ${text.slice(0, 200)}`);
  }

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

// ─── Scaffolder ────────────────────────────────────────────────

const SCAFFOLD_SYSTEM_PROMPT = `You are a project scaffolder. Generate a complete project structure.
For each file, output:
---FILE: path/to/file.ext---
(file content here)
---END FILE---

Generate ALL files. No placeholders, no TODOs, no "implement here".
Every file must be complete and working.
Do not wrap the output in markdown code blocks.`;

export class Scaffolder {
  private engine = new TemplateEngine();

  /**
   * Generate a project from a template.
   */
  async scaffold(
    template: Template,
    params: Record<string, unknown>,
    outputDir: string,
    options: { apiBase: string; model: string; apiKey?: string },
  ): Promise<ScaffoldResult> {
    // 1. Apply defaults and validate
    const fullParams = this.engine.applyDefaults(template, params);
    const errors = this.engine.validateParams(template, fullParams);
    if (errors.length > 0) {
      throw new Error(`Invalid parameters:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    }

    // 2. Expand template prompt
    const userPrompt = this.engine.expandTemplate(template.prompt, fullParams);

    // 3. Call model
    log.debug("scaffolder", `Calling model for template "${template.name}"`);
    const response = await callModel(
      SCAFFOLD_SYSTEM_PROMPT,
      userPrompt,
      options.apiBase,
      options.model,
      options.apiKey,
    );

    // 4. Parse files from response
    const files = this.engine.parseFiles(response);
    if (files.length === 0) {
      throw new Error("Model did not generate any files. Response may be malformed.");
    }

    // 5. Write files to disk
    const createdFiles: Array<{ path: string; size: number }> = [];
    for (const file of files) {
      const fullPath = join(outputDir, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      await Bun.write(fullPath, file.content);
      createdFiles.push({ path: file.path, size: file.content.length });
      log.debug("scaffolder", `Created: ${file.path} (${file.content.length} bytes)`);
    }

    // 6. Run post-setup commands
    const postSetupResults: Array<{ command: string; success: boolean }> = [];
    if (template.postSetup) {
      for (const cmd of template.postSetup) {
        try {
          const parts = cmd.split(" ");
          const proc = Bun.spawn(parts, { cwd: outputDir, stdout: "pipe", stderr: "pipe" });
          const exitCode = await proc.exited;
          postSetupResults.push({ command: cmd, success: exitCode === 0 });
          log.debug("scaffolder", `Post-setup "${cmd}": exit ${exitCode}`);
        } catch (err) {
          log.debug("scaffolder", `Post-setup "${cmd}" failed: ${err}`);
          postSetupResults.push({ command: cmd, success: false });
        }
      }
    }

    return {
      filesCreated: createdFiles.length,
      outputDir,
      files: createdFiles,
      postSetupResults,
    };
  }

  /**
   * Preview the expanded prompt without calling the AI.
   */
  dryRun(template: Template, params: Record<string, unknown>): string {
    const fullParams = this.engine.applyDefaults(template, params);
    const errors = this.engine.validateParams(template, fullParams);
    if (errors.length > 0) {
      return `Validation errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`;
    }
    return this.engine.expandTemplate(template.prompt, fullParams);
  }
}
