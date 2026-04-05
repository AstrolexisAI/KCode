// File and code inspection actions
// Extracted from utility-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleFileAction(action: string, ctx: ActionContext): Promise<string | null> {
  const { appConfig, args, setCompleted } = ctx;

  switch (action) {
    case "scan": {
      // Parse args: first token = path, optional flags
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const skipVerify = tokens.includes("--skip-verify");
      const pathToken = tokens.find((t) => !t.startsWith("--")) ?? ".";
      const { resolve: resolvePath } = await import("node:path");
      const { writeFileSync, existsSync, statSync } = await import("node:fs");
      const projectRoot = resolvePath(appConfig.workingDirectory, pathToken);

      if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
        return `  Path not found or not a directory: ${pathToken}`;
      }

      const { runAudit } = await import("../../core/audit-engine/audit-engine.js");
      const { generateMarkdownReport } = await import(
        "../../core/audit-engine/report-generator.js"
      );

      const { buildAuditLlmCallbackFromConfig } = await import(
        "../../core/audit-engine/llm-callback.js"
      );
      const llmCallback = skipVerify
        ? async () => "VERDICT: CONFIRMED\nREASONING: static-only mode\n"
        : buildAuditLlmCallbackFromConfig(appConfig);

      const result = await runAudit({
        projectRoot,
        llmCallback,
        maxFiles: 500,
        skipVerification: skipVerify,
      });

      const outputPath = resolvePath(projectRoot, "AUDIT_REPORT.md");
      writeFileSync(outputPath, generateMarkdownReport(result));

      const lines: string[] = [
        `  KCode Audit Engine`,
        `    Project:  ${projectRoot}`,
        skipVerify ? `    Mode:     static-only` : `    Model:    ${appConfig.model ?? "default"}`,
        "",
        `    ✓ Report written: ${outputPath}`,
        "",
        `    Files scanned:      ${result.files_scanned}`,
        `    Candidates found:   ${result.candidates_found}`,
        `    Confirmed findings: ${result.confirmed_findings}`,
        `    False positives:    ${result.false_positives}`,
        `    Duration:           ${(result.elapsed_ms / 1000).toFixed(1)}s`,
      ];
      if (result.findings.length > 0) {
        lines.push("", `  Top findings:`);
        for (const f of result.findings.slice(0, 5)) {
          const rel = f.file.replace(projectRoot + "/", "");
          const icon =
            f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "🟢";
          lines.push(`    ${icon} ${rel}:${f.line}  ${f.pattern_id}`);
        }
        if (result.findings.length > 5) {
          lines.push(`    ... and ${result.findings.length - 5} more (see AUDIT_REPORT.md)`);
        }
      }
      return lines.join("\n");
    }

    case "depgraph": {
      if (!args?.trim()) return "  Usage: /depgraph <file path>";

      const { resolve: resolvePath } = await import("node:path");
      const { readFileSync, existsSync } = await import("node:fs");
      const { dirname, basename, relative } = await import("node:path");

      const filePath = resolvePath(appConfig.workingDirectory, args.trim());
      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        return `  Cannot read: ${args.trim()}`;
      }

      // Extract imports (handles multiline imports)
      const importRegex =
        /(?:import\s+[\s\S]*?from\s+["'](.+?)["']|require\s*\(\s*["'](.+?)["']\s*\))/g;
      const imports: string[] = [];
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        imports.push((match[1] ?? match[2])!);
      }

      // Extract exports
      const exportRegex =
        /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
      const exports: string[] = [];
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]!);
      }
      // Also check for `export { ... }`
      const reExportRegex = /export\s*\{([^}]+)\}/g;
      while ((match = reExportRegex.exec(content)) !== null) {
        const names = match[1]!
          .split(",")
          .map((s) =>
            s
              .trim()
              .split(/\s+as\s+/)
              .pop()
              ?.trim(),
          )
          .filter(Boolean);
        exports.push(...(names as string[]));
      }

      const relPath = relative(appConfig.workingDirectory, filePath) || basename(filePath);
      const lines = [`  Dependency Graph: ${relPath}\n`];

      // Imports tree
      if (imports.length > 0) {
        lines.push(`  Imports (${imports.length}):`);
        for (let i = 0; i < imports.length; i++) {
          const isLast = i === imports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          const imp = imports[i]!;
          const isLocal = imp.startsWith(".") || imp.startsWith("/");
          const tag = isLocal ? "" : " (external)";
          lines.push(`    ${prefix} ${imp}${tag}`);
        }
      } else {
        lines.push(`  No imports found.`);
      }

      lines.push(``);

      // Exports tree
      if (exports.length > 0) {
        lines.push(`  Exports (${exports.length}):`);
        for (let i = 0; i < exports.length; i++) {
          const isLast = i === exports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          lines.push(`    ${prefix} ${exports[i]}`);
        }
      } else {
        lines.push(`  No exports found.`);
      }

      return lines.join("\n");
    }
    case "filesize": {
      const { execFileSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const rawPattern = args?.trim() || "**/*.*";
      // Sanitize pattern: only allow alphanumeric, *, ?, ., -, _, /
      const pattern = rawPattern.replace(/[^a-zA-Z0-9*?._\-/]/g, "");
      if (!pattern) return "  Invalid pattern. Use glob characters like *.ts or **/*.js";

      // Use find to get files matching pattern, sorted by size
      const files: Array<{ path: string; size: number }> = [];
      try {
        const namePattern = pattern.includes("*") ? pattern.split("/").pop() || "*" : pattern;
        const output = execFileSync(
          "find",
          [
            ".",
            "-type",
            "f",
            "-name",
            namePattern,
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/.git/*",
            "-printf",
            "%s\\t%p\\n",
          ],
          {
            cwd,
            timeout: 10000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        ).trim();
        // Sort by size descending and limit to 30
        const sorted = output
          .split("\n")
          .filter((l) => l.trim())
          .sort((a, b) => parseInt(b.split("\t")[0] ?? "0") - parseInt(a.split("\t")[0] ?? "0"))
          .slice(0, 30)
          .join("\n");
        if (sorted) {
          for (const line of sorted.split("\n")) {
            const [sizeStr, ...pathParts] = line.split("\t");
            const filePath = pathParts.join("\t");
            const size = parseInt(sizeStr ?? "0") || 0;
            if (filePath) files.push({ path: filePath.replace(/^\.\//, ""), size });
          }
        }
      } catch {
        return "  Error scanning files. Check the glob pattern.";
      }

      if (files.length === 0) return `  No files found matching: ${pattern}`;

      const maxSize = files[0]?.size ?? 1;
      const barWidth = 20;

      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };

      const lines = [`  File Sizes (top ${files.length}, pattern: ${pattern})\n`];
      for (const f of files) {
        const filled = Math.max(1, Math.round((f.size / maxSize) * barWidth));
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
        lines.push(`  ${bar} ${formatSize(f.size).padStart(10)}  ${f.path}`);
      }

      const totalSize = files.reduce((a, b) => a + b.size, 0);
      lines.push(`\n  Total: ${formatSize(totalSize)} across ${files.length} file(s)`);
      return lines.join("\n");
    }
    case "filediff": {
      if (!args?.trim()) return "  Usage: /filediff <file1> <file2>";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) return "  Usage: /filediff <file1> <file2>";

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const file1 = resolvePath(cwd, parts[0]!);
      const file2 = resolvePath(cwd, parts[1]!);

      if (!existsSync(file1)) return `  File not found: ${parts[0]}`;
      if (!existsSync(file2)) return `  File not found: ${parts[1]}`;

      try {
        // Use diff command (returns exit code 1 if files differ, which is normal)
        // Escape single quotes in paths to prevent injection
        const esc = (s: string) => s.replace(/'/g, "'\\''");
        const output = execSync(`diff -u '${esc(file1)}' '${esc(file2)}' 2>&1; true`, {
          cwd,
          timeout: 10000,
        })
          .toString()
          .trim();

        if (!output) return `  Files are identical: ${parts[0]} = ${parts[1]}`;

        const diffLines = output.split("\n");
        const lines = [`  File Diff: ${parts[0]} vs ${parts[1]}\n`];

        // Show first 50 lines of diff
        const maxLines = 50;
        for (let i = 0; i < Math.min(diffLines.length, maxLines); i++) {
          lines.push(`  ${diffLines[i]}`);
        }
        if (diffLines.length > maxLines) {
          lines.push(`\n  ... ${diffLines.length - maxLines} more lines`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "outline": {
      if (!args?.trim()) return "  Usage: /outline <file path>";

      const { existsSync, readFileSync } = await import("node:fs");
      const { resolve: resolvePath, extname, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      const { statSync: statSyncOutline } = await import("node:fs");
      if (statSyncOutline(filePath).size > 5 * 1024 * 1024)
        return "  File too large for outline (max 5 MB).";

      const content = readFileSync(filePath, "utf-8");
      const ext = extname(filePath).toLowerCase();
      const relPath = relative(cwd, filePath);
      const fileLines = content.split("\n");
      const symbols: Array<{ line: number; kind: string; name: string }> = [];

      // Language-specific patterns
      if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*export\s+(default\s+)?(async\s+)?function\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*(export\s+)?(async\s+)?function\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?interface\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "iface", name: m[2]! });
          else if ((m = l.match(/^\s*interface\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?type\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "type", name: m[2]! });
          else if ((m = l.match(/^\s*type\s+(\w+)\s*=/)))
            symbols.push({ line: i + 1, kind: "type", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(const|let|var)\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "var", name: m[2]! });
          else if ((m = l.match(/^\s*const\s+(\w+)\s*=\s*(async\s+)?\(/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
        }
      } else if ([".py"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^(\s*)def\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
          else if ((m = l.match(/^(\s*)async\s+def\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
        }
      } else if ([".go"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "method", name: `${m[2]}.${m[3]}` });
          else if ((m = l.match(/^func\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+struct/)))
            symbols.push({ line: i + 1, kind: "struct", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+interface/)))
            symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
        }
      } else if ([".rs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(pub\s+)?fn\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?struct\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?enum\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?trait\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "trait", name: m[2]! });
          else if ((m = l.match(/^\s*impl\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "impl", name: m[1]! });
        }
      } else if ([".swift"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?func\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/)))
            symbols.push({ line: i + 1, kind: "proto", name: m[2]! });
        }
      } else {
        // Generic: look for common patterns
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if (
            (m = l.match(
              /^\s*(public|private|protected)?\s*(static\s+)?(void|int|string|boolean|async)?\s*(\w+)\s*\(/,
            ))
          ) {
            if (!["if", "for", "while", "switch", "catch", "return", "else"].includes(m[4]!)) {
              symbols.push({ line: i + 1, kind: "fn", name: m[4]! });
            }
          }
        }
      }

      if (symbols.length === 0) return `  No symbols found in ${relPath}`;

      const kindIcons: Record<string, string> = {
        fn: "f",
        method: "m",
        class: "C",
        struct: "S",
        iface: "I",
        type: "T",
        var: "v",
        enum: "E",
        trait: "R",
        impl: "M",
        proto: "P",
      };

      const lines = [
        `  Outline: ${relPath} (${symbols.length} symbols, ${fileLines.length} lines)\n`,
      ];
      for (const sym of symbols) {
        const icon = kindIcons[sym.kind] ?? "?";
        lines.push(`  ${String(sym.line).padStart(5)}  [${icon}] ${sym.name}`);
      }

      return lines.join("\n");
    }
    case "csv": {
      if (!args?.trim()) return "  Usage: /csv <file path>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const ext = extname(filePath).toLowerCase();

      // Detect delimiter
      const delimiter =
        ext === ".tsv" || content.split("\t").length > content.split(",").length ? "\t" : ",";
      const delimName = delimiter === "\t" ? "TAB" : "COMMA";

      const rows = content.split("\n").filter((l) => l.trim());
      if (rows.length === 0) return "  Empty file.";

      // Parse with simple CSV logic (handles quoted fields)
      const parseRow = (line: string): string[] => {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i]!;
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if (ch === delimiter && !inQuotes) {
            fields.push(current.trim());
            current = "";
          } else {
            current += ch;
          }
        }
        fields.push(current.trim());
        return fields;
      };

      const headers = parseRow(rows[0]!);
      const dataRows = rows.slice(1).map(parseRow);

      // Column widths for preview
      const colWidths = headers.map((h, i) => {
        const values = [h, ...dataRows.slice(0, 10).map((r) => r[i] ?? "")];
        return Math.min(Math.max(...values.map((v) => v.length), 3), 25);
      });

      const lines = [
        `  CSV Inspector: ${relPath}\n`,
        `  Delimiter: ${delimName}`,
        `  Columns:   ${headers.length}`,
        `  Rows:      ${dataRows.length}`,
        `  Size:      ${(stat.size / 1024).toFixed(1)} KB`,
        ``,
        `  Columns: ${headers.map((h, i) => `${h} (${i + 1})`).join(", ")}`,
        ``,
      ];

      // Table preview (header + first 10 rows)
      const formatRow = (fields: string[]) =>
        fields
          .map((f, i) =>
            f.length > colWidths[i]!
              ? f.slice(0, colWidths[i]! - 1) + "\u2026"
              : f.padEnd(colWidths[i]!),
          )
          .join("  ");

      lines.push(`  ${formatRow(headers)}`);
      lines.push(`  ${colWidths.map((w) => "\u2500".repeat(w)).join("  ")}`);
      for (const row of dataRows.slice(0, 10)) {
        lines.push(`  ${formatRow(row)}`);
      }
      if (dataRows.length > 10) {
        lines.push(`\n  ... ${dataRows.length - 10} more rows`);
      }

      return lines.join("\n");
    }
    case "json": {
      if (!args?.trim()) return "  Usage: /json <file path or JSON text>";

      const input = args.trim();
      let text = input;
      let isFile = false;

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const filePath = resolvePath(appConfig.workingDirectory, input);

      if (existsSync(filePath) && statSyncFn(filePath).isFile()) {
        if (statSyncFn(filePath).size > 5 * 1024 * 1024) return "  File too large (max 5 MB).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return `  Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Analyze structure
      const countKeys = (
        obj: unknown,
        depth = 0,
      ): { keys: number; maxDepth: number; arrays: number; objects: number } => {
        const result = { keys: 0, maxDepth: depth, arrays: 0, objects: 0 };
        if (depth > 100) return result;
        if (Array.isArray(obj)) {
          result.arrays++;
          for (const item of obj) {
            const sub = countKeys(item, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        } else if (obj && typeof obj === "object") {
          result.objects++;
          const entries = Object.entries(obj as Record<string, unknown>);
          result.keys += entries.length;
          for (const [, val] of entries) {
            const sub = countKeys(val, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        }
        return result;
      };

      const stats = countKeys(parsed);
      const formatted = JSON.stringify(parsed, null, 2);
      const preview = formatted.split("\n").slice(0, 30).join("\n");

      const lines = [
        `  JSON Inspector${isFile ? ` (${input})` : ""}\n`,
        `  Valid:    \u2713`,
        `  Type:     ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        `  Keys:     ${stats.keys}`,
        `  Depth:    ${stats.maxDepth}`,
        `  Objects:  ${stats.objects}`,
        `  Arrays:   ${stats.arrays}`,
        `  Size:     ${text.length.toLocaleString()} chars`,
        ``,
        `  Preview:`,
      ];

      for (const line of preview.split("\n")) {
        lines.push(`  ${line}`);
      }
      if (formatted.split("\n").length > 30) {
        lines.push(`  ... ${formatted.split("\n").length - 30} more lines`);
      }

      return lines.join("\n");
    }
    case "dotenv": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args?.trim() || ".env");

      if (!existsSync(filePath)) return `  File not found: ${relative(cwd, filePath)}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 1024 * 1024) return "  File too large (max 1 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const rawLines = content.split("\n");

      const keys: string[] = [];
      const duplicates: string[] = [];
      const empty: string[] = [];
      const comments = rawLines.filter((l) => l.trim().startsWith("#")).length;
      const seen = new Set<string>();

      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();

        keys.push(key);
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
        if (!val || val === '""' || val === "''") empty.push(key);
      }

      const lines = [
        `  Dotenv Inspector: ${relPath}\n`,
        `  Variables:   ${keys.length}`,
        `  Unique:      ${seen.size}`,
        `  Comments:    ${comments}`,
        `  Empty:       ${empty.length}`,
        `  Duplicates:  ${duplicates.length}`,
        ``,
        `  Keys:`,
      ];

      for (const key of [...seen].sort()) {
        const flags: string[] = [];
        if (duplicates.includes(key)) flags.push("DUP");
        if (empty.includes(key)) flags.push("EMPTY");
        lines.push(`    ${key}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
      }

      if (duplicates.length > 0) {
        lines.push(`\n  \u26a0 Duplicate keys: ${[...new Set(duplicates)].join(", ")}`);
      }
      if (empty.length > 0) {
        lines.push(`  \u26a0 Empty values: ${empty.join(", ")}`);
      }

      return lines.join("\n");
    }
    case "count": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const target = args?.trim() || ".";
      const targetPath = resolvePath(cwd, target);

      if (!existsSync(targetPath)) return `  Not found: ${target}`;

      const stat = statSyncFn(targetPath);

      if (stat.isFile()) {
        if (stat.size > 50 * 1024 * 1024) return "  File too large (max 50 MB).";
        const content = readFileSync(targetPath, "utf-8");
        const lineCount = content.split("\n").length;
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        const charCount = content.length;
        const relPath = relative(cwd, targetPath);

        return [
          `  Count: ${relPath}\n`,
          `  Lines:      ${lineCount.toLocaleString()}`,
          `  Words:      ${wordCount.toLocaleString()}`,
          `  Characters: ${charCount.toLocaleString()}`,
          `  Size:       ${(stat.size / 1024).toFixed(1)} KB`,
        ].join("\n");
      }

      // Directory: count files by extension
      try {
        const output = execSync(
          `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`,
          { cwd, timeout: 10000 },
        )
          .toString()
          .trim();

        if (!output) return "  No files found.";

        const files = output.split("\n");
        const extCounts: Record<string, { count: number; lines: number }> = {};
        let totalLines = 0;
        const totalFiles = files.length;

        for (const file of files) {
          const ext = extname(file).toLowerCase() || "(no ext)";
          if (!extCounts[ext]) extCounts[ext] = { count: 0, lines: 0 };
          extCounts[ext]!.count++;
        }

        // Batch line count via wc -l (much faster than reading each file)
        try {
          const wcOutput = execSync(
            `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -size -1M -exec wc -l {} + 2>/dev/null | tail -1`,
            { cwd, timeout: 15000 },
          )
            .toString()
            .trim();
          const totalMatch = wcOutput.match(/^\s*(\d+)\s+total$/);
          if (totalMatch) totalLines = parseInt(totalMatch[1]!);
        } catch {
          /* skip line counting */
        }

        const sorted = Object.entries(extCounts).sort((a, b) => b[1].count - a[1].count);
        const relDir = relative(cwd, targetPath) || ".";

        const lines = [
          `  Count: ${relDir}\n`,
          `  Total files: ${totalFiles.toLocaleString()}`,
          `  Total lines: ${totalLines > 0 ? totalLines.toLocaleString() : "(unknown)"}`,
          ``,
        ];

        const maxExtLen = Math.max(...sorted.map(([e]) => e.length), 5);
        lines.push(`  ${"Ext".padEnd(maxExtLen)}  ${"Files".padStart(6)}`);
        lines.push(`  ${"\u2500".repeat(maxExtLen)}  ${"\u2500".repeat(6)}`);

        for (const [ext, data] of sorted.slice(0, 20)) {
          lines.push(`  ${ext.padEnd(maxExtLen)}  ${String(data.count).padStart(6)}`);
        }
        if (sorted.length > 20) lines.push(`\n  ... ${sorted.length - 20} more extensions`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "sort_lines": {
      if (!args?.trim()) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;

      const parts = args.trim().split(/\s+/);
      const flags = new Set(parts.filter((p) => p.startsWith("--")));
      const filePart = parts.find((p) => !p.startsWith("--"));
      if (!filePart) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const filePath = resolvePath(cwd, filePart);
      if (!existsSync(filePath)) return `  File not found: ${filePart}`;

      const { statSync: statSyncFn } = await import("node:fs");
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      let lines = content.split("\n");

      // Remove trailing empty line if present
      if (lines[lines.length - 1] === "") lines.pop();

      const originalCount = lines.length;

      // Sort
      if (flags.has("--numeric")) {
        lines.sort((a, b) => {
          const na = parseFloat(a) || 0;
          const nb = parseFloat(b) || 0;
          return na - nb;
        });
      } else {
        lines.sort((a, b) => a.localeCompare(b));
      }

      if (flags.has("--reverse")) lines.reverse();
      if (flags.has("--unique")) lines = [...new Set(lines)];

      const relPath = relative(cwd, filePath);
      const removed = originalCount - lines.length;

      writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      return [
        `  Sorted: ${relPath}`,
        ``,
        `  Lines:   ${originalCount}${removed > 0 ? ` \u2192 ${lines.length} (${removed} duplicates removed)` : ""}`,
        `  Order:   ${flags.has("--numeric") ? "numeric" : "alphabetic"}${flags.has("--reverse") ? " (reversed)" : ""}`,
        `  Unique:  ${flags.has("--unique") ? "yes" : "no"}`,
      ].join("\n");
    }
    case "markdown_toc": {
      if (!args?.trim()) return "  Usage: /markdown-toc <file.md>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 2 * 1024 * 1024) return "  File too large (max 2 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);

      // Extract headings (skip code blocks)
      let inCodeBlock = false;
      const headings: { level: number; text: string; anchor: string }[] = [];

      for (const line of content.split("\n")) {
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          const level = headingMatch[1]!.length;
          const text = headingMatch[2]!.trim();
          const anchor = text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-{2,}/g, "-");
          headings.push({ level, text, anchor });
        }
      }

      if (headings.length === 0) return `  No headings found in ${relPath}`;

      const minLevel = Math.min(...headings.map((h) => h.level));
      const lines = [`  Table of Contents: ${relPath}\n`];

      for (const h of headings.slice(0, 100)) {
        const indent = "  ".repeat(h.level - minLevel);
        lines.push(`  ${indent}- [${h.text}](#${h.anchor})`);
      }
      if (headings.length > 100) {
        lines.push(`  ... and ${headings.length - 100} more`);
      }

      lines.push(``);
      lines.push(
        `  Headings: ${headings.length}  |  Levels: ${minLevel}-${Math.max(...headings.map((h) => h.level))}`,
      );

      return lines.join("\n");
    }
    default:
      return null;
  }
}
