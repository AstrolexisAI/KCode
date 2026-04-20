// Code-analysis actions: /debug, /depgraph, /filesize, /filediff, /outline.
// Split out of file-actions.ts.

import type { ActionContext } from "./action-helpers.js";

export async function handleAnalysisAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;

  switch (action) {
    case "debug": {
      const targetArgs = (args ?? "").trim();
      if (!targetArgs) {
        return "  Usage: /debug <file> or /debug <error description>\n  Example: /debug src/auth.ts\n  Example: /debug TypeError: Cannot read property 'id' of null";
      }

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { collectEvidence } = await import(
        "../../core/debug-engine/evidence-collector.js"
      );

      // Parse: if first arg is a file, treat as target. Otherwise it's an error description.
      const tokens = targetArgs.split(/\s+/);
      const firstToken = tokens[0] ?? "";
      const isFile = existsSync(resolvePath(appConfig.workingDirectory, firstToken));

      const files = isFile ? [firstToken] : [];
      const errorMessage = isFile ? tokens.slice(1).join(" ") || undefined : targetArgs;

      const evidence = await collectEvidence({
        files,
        errorMessage,
        cwd: appConfig.workingDirectory,
      });

      const lines: string[] = [
        "  KCode Debug Engine",
        `    Target: ${evidence.targetFiles.join(", ") || "(auto-detected)"}`,
        "",
        `    📁 Files analyzed:    ${evidence.fileContents.size}`,
        `    🔍 Error patterns:    ${evidence.errorPatterns.length}`,
        `    🧪 Test files found:  ${evidence.testFiles.length}`,
        `    📞 Callers found:     ${evidence.callers.length}`,
        `    📜 Git changes:       ${evidence.recentChanges ? "yes" : "none"}`,
        `    🔬 Git blame:         ${evidence.blame ? "yes" : "n/a"}`,
      ];

      if (evidence.testOutput) {
        const passed = evidence.testOutput.includes("PASS") || evidence.testOutput.includes("passed");
        const failed = evidence.testOutput.includes("FAIL") || evidence.testOutput.includes("failed");
        lines.push(`    ✅ Tests run:          ${passed ? "PASS" : failed ? "FAIL" : "completed"}`);
      }

      lines.push("");
      lines.push("  Evidence package ready. Sending to model for diagnosis...");
      lines.push("");
      lines.push("  " + "─".repeat(50));

      // Summary of evidence
      if (evidence.errorPatterns.length > 0) {
        lines.push("  Error hotspots detected:");
        for (const ep of evidence.errorPatterns.slice(0, 5)) {
          lines.push(`    ⚠️ ${ep.type} — ${ep.file}:${ep.line}: ${ep.code.slice(0, 60)}`);
        }
      }

      return lines.join("\n");
    }

    case "depgraph": {
      if (!args?.trim()) return "  Usage: /depgraph <file path>";

      const { resolve: resolvePath } = await import("node:path");
      const { readFileSync, existsSync } = await import("node:fs");
      const { basename, relative } = await import("node:path");

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

    default:
      return null;
  }
}
