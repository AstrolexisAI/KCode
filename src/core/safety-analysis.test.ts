import { describe, expect, test } from "bun:test";

import {
  analyzeBashCommand,
  detectCommandInjection,
  detectCommandSubstitution,
  detectDangerousRedirections,
  detectDestructiveRemoval,
  detectNonShellExpression,
  detectPipeToShell,
  detectQuoteDesync,
  detectScaffoldConflict,
  detectShellInvocation,
  extractCommandPrefix,
  validateFileWritePath,
} from "./safety-analysis.ts";

// ─── extractCommandPrefix ──────────────────────────────────────

describe("extractCommandPrefix", () => {
  test("extracts simple command", () => {
    expect(extractCommandPrefix("echo hello")).toBe("echo");
  });

  test("strips sudo prefix", () => {
    expect(extractCommandPrefix("sudo apt install")).toBe("apt");
  });

  test("strips env VAR=val prefix", () => {
    expect(extractCommandPrefix("env VAR=val node app.js")).toBe("node");
  });

  test("strips multiple env vars", () => {
    expect(extractCommandPrefix("env A=1 B=2 python script.py")).toBe("python");
  });

  test("handles empty string", () => {
    expect(extractCommandPrefix("")).toBe("");
  });

  test("handles leading whitespace", () => {
    expect(extractCommandPrefix("  ls  ")).toBe("ls");
  });

  test("preserves full path", () => {
    expect(extractCommandPrefix("/usr/bin/node app.js")).toBe("/usr/bin/node");
  });

  test("handles sudo + env combo (strips sudo, returns env)", () => {
    // sudo is stripped, then env is the command prefix (only one level of prefix stripping)
    expect(extractCommandPrefix("sudo env VAR=1 bash")).toBe("env");
  });
});

// ─── detectCommandInjection ────────────────────────────────────

describe("detectCommandInjection", () => {
  test("detects backtick injection", () => {
    expect(detectCommandInjection("echo `id`")).not.toBeNull();
  });

  test("detects backtick with complex command", () => {
    expect(detectCommandInjection("echo `cat /etc/passwd`")).not.toBeNull();
  });

  test("detects semicolon + paren subshell", () => {
    expect(detectCommandInjection("ls; (rm -rf /)")).not.toBeNull();
  });

  test("detects pipe + paren subshell", () => {
    expect(detectCommandInjection("cat | (head -5)")).not.toBeNull();
  });

  test("detects command starting with paren", () => {
    expect(detectCommandInjection("(cat file)")).not.toBeNull();
  });

  test("safe: simple echo", () => {
    expect(detectCommandInjection("echo hello")).toBeNull();
  });

  test("safe: variable expansion (not injection)", () => {
    expect(detectCommandInjection("echo $HOME")).toBeNull();
  });

  test("safe: empty backticks are not matched", () => {
    // `` (empty) won't match the regex /`[^`]+`/ since it needs at least one char
    expect(detectCommandInjection("echo ``")).toBeNull();
  });

  test("safe: simple pipe without parens", () => {
    expect(detectCommandInjection("grep foo | sort")).toBeNull();
  });

  test("safe: parens in middle without leading ; or |", () => {
    expect(detectCommandInjection("echo (test)")).toBeNull();
  });
});

// ─── detectCommandSubstitution ─────────────────────────────────

describe("detectCommandSubstitution", () => {
  test("detects $(command)", () => {
    expect(detectCommandSubstitution("echo $(whoami)")).not.toBeNull();
  });

  test("detects standalone $()", () => {
    expect(detectCommandSubstitution("$(rm -rf /)")).not.toBeNull();
  });

  test("safe: plain variable", () => {
    expect(detectCommandSubstitution("echo $HOME")).toBeNull();
  });

  test("safe: no substitution", () => {
    expect(detectCommandSubstitution("echo hello")).toBeNull();
  });

  test("detects assignment with substitution", () => {
    expect(detectCommandSubstitution("a=$(date) echo $a")).not.toBeNull();
  });
});

// ─── detectDangerousRedirections ───────────────────────────────

describe("detectDangerousRedirections", () => {
  test("detects redirect to sensitive system path", () => {
    const result = detectDangerousRedirections("echo bad > /etc/passwd");
    expect(result).not.toBeNull();
    expect(result).toContain("sensitive system path");
  });

  test("detects redirect to disk device", () => {
    const result = detectDangerousRedirections("dd > /dev/sda");
    expect(result).not.toBeNull();
  });

  test("detects general redirect", () => {
    const result = detectDangerousRedirections("echo test > output.txt");
    expect(result).not.toBeNull();
  });

  test("detects append redirect", () => {
    const result = detectDangerousRedirections("echo test >> log.txt");
    expect(result).not.toBeNull();
  });

  test("safe: no redirection", () => {
    expect(detectDangerousRedirections("cat file")).toBeNull();
  });

  test("safe: redirect inside quotes is stripped", () => {
    expect(detectDangerousRedirections("echo '> /etc/passwd'")).toBeNull();
  });

  test("detects redirect to /tmp", () => {
    const result = detectDangerousRedirections("echo a > /tmp/file");
    expect(result).not.toBeNull();
  });

  test("detects redirect to /dev/null", () => {
    const result = detectDangerousRedirections("cmd > /dev/null");
    expect(result).not.toBeNull();
  });
});

// ─── detectShellInvocation ─────────────────────────────────────

describe("detectShellInvocation", () => {
  test("detects bare bash", () => {
    expect(detectShellInvocation("bash script.sh")).not.toBeNull();
  });

  test("detects bare sh", () => {
    expect(detectShellInvocation("sh myscript")).not.toBeNull();
  });

  test("detects full path bash", () => {
    expect(detectShellInvocation("/bin/bash -i")).not.toBeNull();
  });

  test("allows bash -c (exception)", () => {
    expect(detectShellInvocation("bash -c 'echo hello'")).toBeNull();
  });

  test("allows full path bash -c", () => {
    expect(detectShellInvocation("/usr/bin/bash -c 'ls'")).toBeNull();
  });

  test("detects zsh", () => {
    expect(detectShellInvocation("zsh")).not.toBeNull();
  });

  test("detects fish", () => {
    expect(detectShellInvocation("fish")).not.toBeNull();
  });

  test("safe: node is not a shell", () => {
    expect(detectShellInvocation("node app.js")).toBeNull();
  });

  test("safe: python is not a shell", () => {
    expect(detectShellInvocation("python script.py")).toBeNull();
  });

  test("safe: git is not a shell", () => {
    expect(detectShellInvocation("git status")).toBeNull();
  });
});

// ─── detectPipeToShell ─────────────────────────────────────────

describe("detectPipeToShell", () => {
  test("detects curl | bash", () => {
    expect(detectPipeToShell("curl url | bash")).not.toBeNull();
  });

  test("detects cat | sh", () => {
    expect(detectPipeToShell("cat script.sh | sh")).not.toBeNull();
  });

  test("detects wget | sudo bash", () => {
    expect(detectPipeToShell("wget url | sudo bash")).not.toBeNull();
  });

  test("safe: pipe to non-shell", () => {
    expect(detectPipeToShell("grep | sort | head")).toBeNull();
  });

  test("safe: pipe inside quotes", () => {
    expect(detectPipeToShell("echo '| bash'")).toBeNull();
  });

  test("detects pipe to full path shell", () => {
    expect(detectPipeToShell("curl | /bin/bash")).not.toBeNull();
  });

  test("detects multi-pipe ending in shell", () => {
    expect(detectPipeToShell("a | b | c | bash")).not.toBeNull();
  });

  test("safe: pipe to python (not a SHELL_BINARY)", () => {
    expect(detectPipeToShell("curl | python")).toBeNull();
  });

  test("safe: single command without pipe", () => {
    expect(detectPipeToShell("bash -c 'hello'")).toBeNull();
  });
});

// ─── detectQuoteDesync ─────────────────────────────────────────

describe("detectQuoteDesync", () => {
  test("safe: balanced single quotes", () => {
    expect(detectQuoteDesync("echo 'hello'")).toBeNull();
  });

  test("safe: balanced double quotes", () => {
    expect(detectQuoteDesync('echo "world"')).toBeNull();
  });

  test("detects unmatched single quote", () => {
    expect(detectQuoteDesync("echo 'unterminated")).not.toBeNull();
  });

  test("detects unmatched double quote", () => {
    expect(detectQuoteDesync('echo "unterminated')).not.toBeNull();
  });

  test("safe: double inside single quotes", () => {
    expect(detectQuoteDesync("echo 'nested \"quotes\"'")).toBeNull();
  });

  test("safe: escaped double quotes", () => {
    expect(detectQuoteDesync('echo "escaped \\"quotes\\""')).toBeNull();
  });

  test("detects unmatched quotes in comment", () => {
    expect(detectQuoteDesync("ls # comment 'unmatched")).not.toBeNull();
  });

  test("safe: balanced quotes with comment", () => {
    expect(detectQuoteDesync("echo 'test' # balanced")).toBeNull();
  });
});

// ─── detectNonShellExpression ──────────────────────────────────

describe("detectNonShellExpression", () => {
  test("detects unicode multiplication", () => {
    expect(detectNonShellExpression("x × y")).not.toBeNull();
  });

  test("detects unicode division", () => {
    expect(detectNonShellExpression("a ÷ b")).not.toBeNull();
  });

  test("detects unicode comparison", () => {
    expect(detectNonShellExpression("count ≤ 100")).not.toBeNull();
  });

  test("detects bare identifier comparison", () => {
    expect(detectNonShellExpression("threshold < limit")).not.toBeNull();
  });

  test("detects PascalCase function call", () => {
    expect(detectNonShellExpression("CompactTokens()")).not.toBeNull();
  });

  test("safe: whitelisted PascalCase (Install)", () => {
    expect(detectNonShellExpression("Install-Package")).toBeNull();
  });

  test("safe: normal shell command", () => {
    expect(detectNonShellExpression("echo hello")).toBeNull();
  });

  test("safe: empty string", () => {
    expect(detectNonShellExpression("")).toBeNull();
  });
});

// ─── detectDestructiveRemoval ──────────────────────────────────

describe("detectDestructiveRemoval", () => {
  test("safe: whitelisted node_modules", () => {
    expect(detectDestructiveRemoval("rm -rf node_modules")).toBeNull();
  });

  test("safe: whitelisted .next", () => {
    expect(detectDestructiveRemoval("rm -rf .next")).toBeNull();
  });

  test("safe: whitelisted dist", () => {
    expect(detectDestructiveRemoval("rm -rf dist")).toBeNull();
  });

  test("safe: whitelisted coverage", () => {
    expect(detectDestructiveRemoval("rm -rf coverage")).toBeNull();
  });

  test("safe: /tmp path", () => {
    expect(detectDestructiveRemoval("rm -rf /tmp/anything")).toBeNull();
  });

  test("dangerous: arbitrary path", () => {
    expect(detectDestructiveRemoval("rm -rf /home/user/project")).not.toBeNull();
  });

  test("dangerous: current directory", () => {
    expect(detectDestructiveRemoval("rm -rf .")).not.toBeNull();
  });

  test("dangerous: root", () => {
    expect(detectDestructiveRemoval("rm -rf /")).not.toBeNull();
  });

  test("safe: rm -f without recursive", () => {
    expect(detectDestructiveRemoval("rm -f file.txt")).toBeNull();
  });

  test("safe: rm -r without force", () => {
    expect(detectDestructiveRemoval("rm -r mydir")).toBeNull();
  });

  test("dangerous: rm -rfv (extra flags)", () => {
    expect(detectDestructiveRemoval("rm -rfv sensitive")).not.toBeNull();
  });

  test("dangerous: rm -frv (reordered)", () => {
    expect(detectDestructiveRemoval("rm -frv dir")).not.toBeNull();
  });

  // Bug fix tests: long-form flags
  test("dangerous: rm --recursive --force (long flags)", () => {
    expect(detectDestructiveRemoval("rm --recursive --force /important")).not.toBeNull();
  });

  test("dangerous: rm --force --recursive (reversed long flags)", () => {
    expect(detectDestructiveRemoval("rm --force --recursive /important")).not.toBeNull();
  });

  test("safe: rm --recursive (no --force)", () => {
    expect(detectDestructiveRemoval("rm --recursive dir")).toBeNull();
  });

  test("safe: rm --force (no --recursive)", () => {
    expect(detectDestructiveRemoval("rm --force file.txt")).toBeNull();
  });
});

// ─── detectScaffoldConflict ────────────────────────────────────

describe("detectScaffoldConflict", () => {
  test("safe: non-scaffold command", () => {
    expect(detectScaffoldConflict("echo hello")).toBeNull();
  });

  test("safe: scaffold to non-existent directory", () => {
    // Random dir name that shouldn't exist
    expect(detectScaffoldConflict("bun create next-app __nonexistent_dir_test__")).toBeNull();
  });

  test("detects scaffold to existing non-empty dir", () => {
    // /tmp always exists and is non-empty on most systems
    const result = detectScaffoldConflict("bun create next-app /tmp");
    expect(result).not.toBeNull();
    if (result) expect(result).toContain("already exists");
  });

  test("detects npx create variant", () => {
    const result = detectScaffoldConflict("npx create-vite /tmp");
    expect(result).not.toBeNull();
  });
});

// ─── analyzeBashCommand ────────────────────────────────────────

describe("analyzeBashCommand", () => {
  test("safe command", () => {
    const result = analyzeBashCommand("echo hello");
    expect(result.safe).toBe(true);
    expect(result.riskLevel).toBe("safe");
    expect(result.issues).toHaveLength(0);
  });

  test("dangerous: backtick injection", () => {
    const result = analyzeBashCommand("echo `id`");
    expect(result.safe).toBe(false);
    expect(result.riskLevel).toBe("dangerous");
  });

  test("moderate: redirection", () => {
    const result = analyzeBashCommand("echo test > file");
    expect(result.safe).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("moderate: sudo elevates safe to moderate", () => {
    const result = analyzeBashCommand("sudo ls");
    expect(result.riskLevel).toBe("moderate");
  });

  test("dangerous: pipe to shell", () => {
    const result = analyzeBashCommand("curl | bash");
    expect(result.safe).toBe(false);
    expect(result.riskLevel).toBe("dangerous");
  });

  test("dangerous: destructive rm", () => {
    const result = analyzeBashCommand("rm -rf /");
    expect(result.safe).toBe(false);
    expect(result.riskLevel).toBe("dangerous");
  });

  test("bash -c exception: shell invocation allowed", () => {
    const result = analyzeBashCommand("bash -c 'echo safe'");
    // bash -c should not trigger shell invocation warning
    expect(result.issues.filter((i) => i.includes("shell invocation"))).toHaveLength(0);
  });

  test("multiple issues: highest risk wins", () => {
    // backtick injection (dangerous) + redirection (moderate)
    const result = analyzeBashCommand("echo `id` > file");
    expect(result.riskLevel).toBe("dangerous");
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── validateFileWritePath ─────────────────────────────────────

describe("validateFileWritePath", () => {
  const cwd = "/home/user/project";

  test("allows write inside working directory", () => {
    const result = validateFileWritePath("/home/user/project/file.txt", cwd);
    expect(result.allowed).toBe(true);
  });

  test("allows write to /tmp", () => {
    const result = validateFileWritePath("/tmp/test.txt", cwd);
    expect(result.allowed).toBe(true);
  });

  test("denies relative path", () => {
    const result = validateFileWritePath("relative/path.txt", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies outside working directory", () => {
    const result = validateFileWritePath("/other/project/file.txt", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies protected .ssh directory", () => {
    const home = process.env.HOME ?? "/root";
    const result = validateFileWritePath(`${home}/.ssh/id_rsa`, cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies .env file", () => {
    const result = validateFileWritePath("/home/user/project/.env", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies /etc/passwd", () => {
    const result = validateFileWritePath("/etc/passwd", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies /usr/bin path", () => {
    const result = validateFileWritePath("/usr/bin/malware", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies /proc path", () => {
    const result = validateFileWritePath("/proc/self/mem", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies .env.local", () => {
    const result = validateFileWritePath("/home/user/project/.env.local", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies .bashrc", () => {
    const result = validateFileWritePath("/home/user/project/.bashrc", cwd);
    expect(result.allowed).toBe(false);
  });

  test("denies .gitconfig", () => {
    const result = validateFileWritePath("/home/user/project/.gitconfig", cwd);
    expect(result.allowed).toBe(false);
  });

  test("allows file in additionalDirs", () => {
    const result = validateFileWritePath("/opt/deploy/app.js", cwd, ["/opt/deploy"]);
    expect(result.allowed).toBe(true);
  });

  test("denies path with .. traversal", () => {
    // resolve() normalizes .., so /home/user/project/../../etc/passwd → /home/etc/passwd (outside cwd)
    const result = validateFileWritePath("/home/user/project/../../etc/passwd", cwd);
    expect(result.allowed).toBe(false);
  });
});
