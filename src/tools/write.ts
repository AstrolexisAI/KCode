// KCode - Write Tool
// Creates or overwrites files

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult, FileWriteInput } from "../core/types";

export const writeDefinition: ToolDefinition = {
  name: "Write",
  description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["file_path", "content"],
  },
};

const SENSITIVE_PATTERNS = [
  /\.(env|env\.\w+)$/,
  /\.(pem|key|crt|cert)$/,
  /\.ssh\//,
  /credentials/i,
  /\.aws\//,
  /\.kube\/config/,
  /id_rsa/,
  /id_ed25519/,
];

export async function executeWrite(input: Record<string, unknown>): Promise<ToolResult> {
  const { file_path, content } = input as FileWriteInput;

  // Block writes to sensitive files
  const isSensitive = SENSITIVE_PATTERNS.some(p => p.test(file_path));
  if (isSensitive) {
    return {
      tool_use_id: "",
      content: `BLOCKED: Writing to "${file_path}" is blocked because it matches a sensitive file pattern (.env, .pem, .ssh, credentials, etc.). If you need to write this file, ask the user to do it manually.`,
      is_error: true,
    };
  }

  try {
    // Detect inline HTML/CSS/JS in TypeScript files — common model mistake
    const isTS = file_path.endsWith(".ts") || file_path.endsWith(".tsx");
    const hasInlineHTML = isTS && /<\s*(html|div|span|body|head|style|script|form|button|input|table|section|header|footer|nav|main|article)\b/i.test(content);
    const isLargeInline = hasInlineHTML && content.length > 2000;

    if (isLargeInline) {
      return {
        tool_use_id: "",
        content: `BLOCKED: You are embedding HTML inside a TypeScript file (${file_path}). This will cause parsing errors because backticks, \${}, and HTML attributes conflict with TypeScript syntax.\n\nYou MUST create separate files instead:\n1. public/index.html — for HTML\n2. public/styles.css — for CSS\n3. public/app.js — for frontend JavaScript\n4. ${file_path} — for ONLY the TypeScript server code\n\nUse Bun.file() to serve static files:\n  if (url.pathname === "/") return new Response(Bun.file("public/index.html"));\n\nRewrite your approach using separate files.`,
        is_error: true,
      };
    }

    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, "utf-8");

    const lineCount = content.split("\n").length;
    let warning = "";
    if (hasInlineHTML) {
      warning = "\n⚠️ Warning: This file contains HTML inside TypeScript. Consider moving HTML/CSS/JS to separate files in public/ to avoid template literal issues.";
    }
    return {
      tool_use_id: "",
      content: `File written successfully: ${file_path} (${lineCount} lines)${warning}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error writing file: ${msg}`,
      is_error: true,
    };
  }
}
