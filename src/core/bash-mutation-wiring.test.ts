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
