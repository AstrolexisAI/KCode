// KCode - Template Engine
// Handles template expansion, parameter validation, and file parsing.

import { log } from "../logger";
import type { Template, TemplateParam } from "./types";

export class TemplateEngine {
  /**
   * Expand a template prompt with parameter values.
   * Supports: {{var}}, {{#if var}}...{{else}}...{{/if}}, {{#each var}}...{{/each}}
   */
  expandTemplate(prompt: string, params: Record<string, unknown>): string {
    let result = prompt;

    // Process {{#each var}}...{{/each}} blocks
    result = result.replace(
      /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (_match, key: string, body: string) => {
        const arr = params[key];
        if (!Array.isArray(arr)) return "";
        return arr.map((item) => body.replace(/\{\{this\}\}/g, String(item))).join("");
      },
    );

    // Process {{#if var}}...{{else}}...{{/if}} blocks
    result = result.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_match, key: string, ifBody: string, elseBody: string) => {
        return this.isTruthy(params[key]) ? ifBody : elseBody;
      },
    );

    // Process {{#if var}}...{{/if}} blocks (without else)
    result = result.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_match, key: string, body: string) => {
        return this.isTruthy(params[key]) ? body : "";
      },
    );

    // Process simple {{var}} substitutions
    result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      return params[key] !== undefined ? String(params[key]) : "";
    });

    return result;
  }

  /**
   * Validate parameters against a template definition.
   * Returns an array of validation error messages (empty = valid).
   */
  validateParams(template: Template, params: Record<string, unknown>): string[] {
    const errors: string[] = [];

    for (const param of template.parameters) {
      const value = params[param.name];

      // Check required
      if (param.required && (value === undefined || value === null || value === "")) {
        errors.push(`Missing required parameter: ${param.name}`);
        continue;
      }

      if (value === undefined || value === null) continue;

      // Check type
      switch (param.type) {
        case "boolean":
          if (typeof value !== "boolean" && value !== "true" && value !== "false") {
            errors.push(`Parameter "${param.name}" must be a boolean`);
          }
          break;

        case "choice":
          if (param.choices && !param.choices.includes(String(value))) {
            errors.push(`Parameter "${param.name}" must be one of: ${param.choices.join(", ")}`);
          }
          break;

        case "string":
          if (typeof value !== "string") {
            errors.push(`Parameter "${param.name}" must be a string`);
          }
          break;
      }
    }

    return errors;
  }

  /**
   * Apply default values for missing parameters.
   */
  applyDefaults(template: Template, params: Record<string, unknown>): Record<string, unknown> {
    const result = { ...params };
    for (const param of template.parameters) {
      if (result[param.name] === undefined && param.default !== undefined) {
        result[param.name] = param.default;
      }
    }
    return result;
  }

  /**
   * Parse AI response to extract generated files.
   * Looks for ---FILE: path--- ... ---END FILE--- markers.
   */
  parseFiles(content: string): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = [];
    const regex = /---FILE:\s*(.+?)---\n([\s\S]*?)---END FILE---/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const path = match[1]!.trim();
      const fileContent = match[2]!;
      // Sanitize path — no absolute paths or traversal
      if (path.startsWith("/") || path.includes("..")) {
        log.debug("templates", `Skipping unsafe file path: ${path}`);
        continue;
      }
      files.push({ path, content: fileContent });
    }

    return files;
  }

  /**
   * Interactive parameter prompting via stdin.
   */
  async interactivePrompt(template: Template): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    const rl = require("node:readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, resolve));

    try {
      for (const param of template.parameters) {
        let value: unknown;

        switch (param.type) {
          case "boolean": {
            const def = param.default === true ? "Y/n" : "y/N";
            const answer = await ask(`  ${param.name} — ${param.description} [${def}]: `);
            if (!answer.trim()) {
              value = param.default ?? false;
            } else {
              value = answer.trim().toLowerCase().startsWith("y");
            }
            break;
          }

          case "choice": {
            const choices = param.choices ?? [];
            console.log(`  ${param.name} — ${param.description}:`);
            choices.forEach((c, i) => {
              const marker = c === param.default ? " (default)" : "";
              console.log(`    ${i + 1}. ${c}${marker}`);
            });
            const answer = await ask(`  Choose [1-${choices.length}]: `);
            const idx = parseInt(answer.trim(), 10) - 1;
            value = (idx >= 0 && idx < choices.length) ? choices[idx] : param.default;
            break;
          }

          case "string":
          default: {
            const def = param.default ? ` [${param.default}]` : "";
            const answer = await ask(`  ${param.name} — ${param.description}${def}: `);
            value = answer.trim() || param.default || "";
            break;
          }
        }

        params[param.name] = value;
      }
    } finally {
      rl.close();
    }

    return params;
  }

  private isTruthy(value: unknown): boolean {
    if (value === false || value === "false" || value === 0 || value === "" || value === null || value === undefined) {
      return false;
    }
    return true;
  }
}
