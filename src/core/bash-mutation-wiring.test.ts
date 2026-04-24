// Tests for the bash mutation → scope wiring landed in v289.
// Issue #111 v288 repro: final 'Files: none created or edited' despite
// transcript showing 'cat > .env.example', 'mv index.ts index.tsx',
// 'touch foo', etc. Bash-tool paths never hit recordMutation.
//
// These tests verify the regex/path extraction logic for each Bash
// mutation shape. The full tool-executor integration is exercised
// manually; here we just lock down the detection patterns.

import { describe, expect, test } from "bun:test";
import { extractBashFileMutations } from "./audit-guards";

describe("bash mutation wiring (v289)", () => {
  describe("extractBashFileMutations — redirect/sed/perl/awk", () => {
    test("cat > X redirect is detected", () => {
      const out = extractBashFileMutations("cat > .env.example << 'EOF'\n# content\nEOF");
      expect(out).toContain(".env.example");
    });

    test("echo > X redirect is detected", () => {
      const out = extractBashFileMutations("echo 'hello' > config.yml");
      expect(out).toContain("config.yml");
    });

    test("sed -i file is detected", () => {
      const out = extractBashFileMutations("sed -i 's/old/new/g' src/main.py");
      expect(out).toContain("src/main.py");
    });

    test("perl -i file is detected", () => {
      const out = extractBashFileMutations("perl -i -pe 's/old/new/g' config.ts");
      expect(out).toContain("config.ts");
    });

    test("awk -i inplace file is detected", () => {
      const out = extractBashFileMutations("awk -i inplace '/pattern/d' main.py");
      expect(out).toContain("main.py");
    });
  });

  describe("heredoc + arrow-function false positives (v290)", () => {
    test("heredoc body with .then(() => {}) does NOT capture '{' (v290 repro)", () => {
      // The v290 repro had: cat > index.ts << 'EOF'\n...\n.then(() => {\n... })\nEOF
      // which captured `{` as a redirect target. After the fix, only
      // the actual redirect target (index.ts) should be returned.
      const cmd =
        "cat > index.ts << 'EOF'\n" +
        "import blessed from 'blessed';\n" +
        "testConnection().then(() => {\n" +
        "  console.log('Iniciando TUI...');\n" +
        "  const screen = blessed.screen({ smartCSR: true });\n" +
        "});\n" +
        "EOF";
      const out = extractBashFileMutations(cmd);
      expect(out).toContain("index.ts");
      expect(out).not.toContain("{");
      expect(out).not.toContain("}");
      // Arrow functions and block opens inside the heredoc body
      // should not leak through.
      expect(out.filter((p) => p.length === 1)).toHaveLength(0);
    });

    test("=> arrow function outside heredoc does NOT match", () => {
      const cmd = "echo 'x => y' > notes.txt";
      const out = extractBashFileMutations(cmd);
      expect(out).toContain("notes.txt");
      // The `=>` inside the quoted string shouldn't create a phantom target.
      expect(out).not.toContain("y");
    });

    test("numeric fd redirects (2>&1) are ignored", () => {
      const cmd = "make build > build.log 2>&1";
      const out = extractBashFileMutations(cmd);
      expect(out).toContain("build.log");
      expect(out).not.toContain("1");
      expect(out).not.toContain("&1");
    });

    test("path sanity — punctuation-only captures are dropped", () => {
      // Direct call to the extractor with a deliberately malformed
      // redirect to confirm validation kicks in.
      const cmd = "weird > { && other > } ; real > file.txt";
      const out = extractBashFileMutations(cmd);
      expect(out).toContain("file.txt");
      expect(out).not.toContain("{");
      expect(out).not.toContain("}");
    });
  });

  describe("mv / touch / cp regex detection (raw patterns used in tool-executor)", () => {
    test("mv src dst captures dst", () => {
      const m = "cd /proj && mv index.ts index.tsx".match(
        /\bmv\s+(?:-[a-zA-Z]*\s+)?(\S+)\s+(\S+)/,
      );
      expect(m?.[2]).toBe("index.tsx");
    });

    test("mv with -v flag still captures dst", () => {
      const m = "mv -v a.ts b.ts".match(/\bmv\s+(?:-[a-zA-Z]*\s+)?(\S+)\s+(\S+)/);
      expect(m?.[2]).toBe("b.ts");
    });

    test("touch FILE is detected", () => {
      const matches = [
        ..."touch foo.py bar.ts".matchAll(/\btouch\s+([^\s;&|<>`]+)/g),
      ];
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]![1]).toBe("foo.py");
    });

    test("cp src dst captures dst", () => {
      const m = "cp template.ts newfile.ts".match(
        /\bcp\s+(?:-[a-zA-Z]*\s+)?(\S+)\s+(\S+)/,
      );
      expect(m?.[2]).toBe("newfile.ts");
    });
  });
});
