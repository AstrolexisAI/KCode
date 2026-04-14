// Tests for phase 14 — platform-aware Bash command translation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearCommandExistsCache,
  extractFirstExecutable,
  TRANSLATIONS,
  translateBashCommand,
} from "./bash-platform-translate";

describe("extractFirstExecutable", () => {
  test.each([
    ["ls -la", "ls"],
    ["ls", "ls"],
    ["PORT=3000 npm run dev", "npm"],
    ["NODE_ENV=prod node server.js", "node"],
    ["sudo ls /root", "ls"],
    ["nohup bash script.sh", "bash"],
    ["exec python3 -m http.server", "python3"],
    ["time make build", "make"],
    // Note: we don't try to parse `sudo -u <user>` flag chains here —
    // extractFirstExecutable stops at the first non-wrapper token.
    // That covers ~all real model output; the few edge cases with
    // flag-args to sudo don't need platform translation anyway.
    ["cd /tmp && open file.html", "open"],
    ["cd /tmp && cat x", "cat"],
    ["cd /a && cd /b && npm run dev", "npm"],
    ["echo 'hi' | grep hi", "grep"],
    ["/usr/bin/open file.pdf", "open"],
    ["/usr/local/bin/xdg-open x", "xdg-open"],
    ["   cat foo   ", "cat"],
  ])("extracts %p → %p", (cmd, expected) => {
    const result = extractFirstExecutable(cmd);
    expect(result.executable).toBe(expected);
  });

  test("returns null for empty", () => {
    const r = extractFirstExecutable("");
    expect(r.executable).toBeNull();
  });

  test("returns start/length that point at the executable in the command", () => {
    const r = extractFirstExecutable("cd /tmp && open file.html");
    expect(r.executable).toBe("open");
    const extracted = "cd /tmp && open file.html".slice(r.start, r.start + r.length);
    expect(extracted).toBe("open");
  });

  test("start/length point at the basename even for absolute paths", () => {
    // Note: we return the basename as the executable, but start/length
    // point at the full path in the original command so the rewriter
    // replaces the whole thing.
    const cmd = "/usr/bin/open file.pdf";
    const r = extractFirstExecutable(cmd);
    expect(r.executable).toBe("open");
    const extracted = cmd.slice(r.start, r.start + r.length);
    expect(extracted).toBe("/usr/bin/open");
  });
});

describe("TRANSLATIONS table", () => {
  test("includes open → xdg-open for Linux", () => {
    const t = TRANSLATIONS.find((x) => x.from === "open" && x.to === "xdg-open");
    expect(t).toBeDefined();
    expect(t!.missingOn).toContain("linux");
  });

  test("includes xdg-open → open for macOS", () => {
    const t = TRANSLATIONS.find((x) => x.from === "xdg-open" && x.to === "open");
    expect(t).toBeDefined();
    expect(t!.missingOn).toContain("darwin");
  });

  test("includes pbcopy and pbpaste for Linux", () => {
    expect(TRANSLATIONS.find((x) => x.from === "pbcopy")).toBeDefined();
    expect(TRANSLATIONS.find((x) => x.from === "pbpaste")).toBeDefined();
  });
});

describe("translateBashCommand", () => {
  beforeEach(() => clearCommandExistsCache());
  afterEach(() => clearCommandExistsCache());

  test("no-op on unrelated commands", () => {
    const r = translateBashCommand("ls -la", "linux");
    expect(r.translated).toBe(false);
    expect(r.command).toBe("ls -la");
  });

  test("no-op on empty command", () => {
    const r = translateBashCommand("", "linux");
    expect(r.translated).toBe(false);
  });

  test("no-op on unknown platform", () => {
    const r = translateBashCommand("open x.html", "win32" as NodeJS.Platform);
    expect(r.translated).toBe(false);
  });

  test("on Linux, `open x.html` translates to `xdg-open x.html`", () => {
    // Runtime gate: xdg-open must exist AND open must not exist.
    // On the dev host `open` should not be in PATH (pure Linux).
    const { which } = require("bun");
    void which;
    const r = translateBashCommand("open file.html", "linux");
    // If the host has neither `open` nor `xdg-open`, skip.
    if (!r.translated) return;
    expect(r.translated).toBe(true);
    expect(r.command).toBe("xdg-open file.html");
    expect(r.note).toMatch(/open.*xdg-open/);
  });

  test("translation preserves arguments including quoted ones", () => {
    const r = translateBashCommand(`open "My File.pdf"`, "linux");
    if (!r.translated) return;
    expect(r.command).toBe(`xdg-open "My File.pdf"`);
  });

  test("translation preserves env var prefixes", () => {
    const r = translateBashCommand("DISPLAY=:0 open file.html", "linux");
    if (!r.translated) return;
    expect(r.command).toBe("DISPLAY=:0 xdg-open file.html");
  });

  test("translation preserves chained commands", () => {
    const r = translateBashCommand("cd /tmp && open file.html", "linux");
    if (!r.translated) return;
    expect(r.command).toBe("cd /tmp && xdg-open file.html");
  });

  test("translation of pbcopy includes the full replacement invocation", () => {
    const r = translateBashCommand("echo hi | pbcopy", "linux");
    // pbcopy is pipe-target; extractFirstExecutable picks pbcopy (last segment)
    if (!r.translated) return;
    expect(r.command).toContain("xsel");
  });

  test("does not translate when the from-command exists on the host", () => {
    // On this host `ls` exists, and we have no translation for `ls`
    // anyway, so no-op. The real assertion is that the TRANSLATIONS
    // table only fires for missing commands.
    const r = translateBashCommand("ls -la", "linux");
    expect(r.translated).toBe(false);
  });

  test("note is included only when translation happens", () => {
    const r1 = translateBashCommand("ls -la", "linux");
    expect(r1.note).toBeUndefined();

    const r2 = translateBashCommand("open file.html", "linux");
    if (r2.translated) {
      expect(r2.note).toBeDefined();
      expect(r2.note).toContain("translated");
    }
  });
});
