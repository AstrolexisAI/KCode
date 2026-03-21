import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import {
  executeBash,
  setSudoPasswordPromptFn,
  clearSudoPasswordCache,
  type SudoPasswordPromptFn,
} from "./bash.ts";

let hasBash = false;
try { execFileSync("bash", ["--version"], { stdio: "pipe" }); hasBash = true; } catch {}

// Clean up askpass files after each test
function cleanupAskpass() {
  try {
    for (const f of readdirSync("/tmp")) {
      if (f.startsWith(".kcode-askpass-")) {
        try { unlinkSync(`/tmp/${f}`); } catch {}
      }
    }
  } catch {}
}

(hasBash ? describe : describe.skip)("bash sudo & security guards", () => {
  beforeEach(() => {
    clearSudoPasswordCache();
    setSudoPasswordPromptFn(undefined);
  });

  afterEach(() => {
    clearSudoPasswordCache();
    setSudoPasswordPromptFn(undefined);
    cleanupAskpass();
  });

  // ─── Password injection guards ───

  test("blocks echo piped to sudo", async () => {
    const result = await executeBash({ command: 'echo "mypass" | sudo apt install foo' });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("password injection");
  });

  test("blocks printf piped to sudo", async () => {
    const result = await executeBash({ command: 'printf "pass\\n" | sudo -S apt install foo' });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("blocks here-string with sudo", async () => {
    const result = await executeBash({ command: 'sudo -S apt install foo <<< "password"' });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("blocks sudo -S flag used by LLM", async () => {
    const result = await executeBash({ command: "sudo -S apt install foo" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("blocks variable assignment piped to sudo", async () => {
    const result = await executeBash({ command: 'PASS="secret"; echo $PASS | sudo -S sh -c "id"' });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("allows normal sudo without password injection", async () => {
    // sudo will fail (no TTY, no password prompt fn set) but should NOT be blocked by guards
    const result = await executeBash({ command: "sudo echo test", timeout: 2000 });
    expect(result.content).not.toContain("BLOCKED");
  });

  // ─── msfconsole guard ───

  test("blocks interactive msfconsole", async () => {
    const result = await executeBash({ command: "msfconsole" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("non-interactive");
  });

  test("allows msfconsole -r flag (not blocked by guard)", async () => {
    // Just test that the msfconsole guard does NOT trigger — don't actually run it
    const result = await executeBash({ command: "echo 'msfconsole -q -r /tmp/test.rc would run'" });
    expect(result.content).not.toContain("BLOCKED");
  });

  test("allows msfconsole -x flag (not blocked by guard)", async () => {
    const result = await executeBash({ command: 'echo \'msfconsole -q -x "exit" would run\'' });
    expect(result.content).not.toContain("BLOCKED");
  });

  // ─── Sudo password prompt fn ───

  test("sudo cancelled returns error when user provides null", async () => {
    setSudoPasswordPromptFn(async () => null);
    const result = await executeBash({ command: "sudo whoami", timeout: 3000 });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("cancelled");
  });

  test("sudo password prompt fn is called when sudo is in command", async () => {
    let called = false;
    setSudoPasswordPromptFn(async () => {
      called = true;
      return null; // cancel immediately
    });
    await executeBash({ command: "sudo whoami", timeout: 3000 });
    expect(called).toBe(true);
  });

  test("sudo prompt fn is NOT called for non-sudo commands", async () => {
    let called = false;
    setSudoPasswordPromptFn(async () => {
      called = true;
      return null;
    });
    await executeBash({ command: "echo hello-world", timeout: 3000 });
    expect(called).toBe(false);
  });

  test("sudo password is cached after first prompt", async () => {
    let callCount = 0;
    setSudoPasswordPromptFn(async () => {
      callCount++;
      return null; // cancel to avoid running actual sudo
    });

    // First call — should prompt, then cancel
    await executeBash({ command: "sudo echo first", timeout: 2000 });
    expect(callCount).toBe(1);

    // Cancelled password (null) should NOT be cached
    // So second call should also prompt
    await executeBash({ command: "sudo echo second", timeout: 2000 });
    expect(callCount).toBe(2);
  });

  test("non-null password is cached and prompt not called again", async () => {
    let callCount = 0;
    setSudoPasswordPromptFn(async () => {
      callCount++;
      return "testpass"; // provide a password
    });

    // First call — prompts and gets password, then runs (will fail with wrong pass)
    await executeBash({ command: "sudo echo first", timeout: 2000 });
    expect(callCount).toBe(1);

    // Second call — should use cached password, NOT prompt again
    await executeBash({ command: "sudo echo second", timeout: 2000 });
    expect(callCount).toBe(1); // still 1
  }, 15000); // longer bun timeout for two sudo executions

  test("clearSudoPasswordCache forces re-prompt", async () => {
    let callCount = 0;
    setSudoPasswordPromptFn(async () => {
      callCount++;
      return "testpass";
    });

    await executeBash({ command: "sudo echo first", timeout: 2000 });
    expect(callCount).toBe(1);

    clearSudoPasswordCache();

    await executeBash({ command: "sudo echo second", timeout: 2000 });
    expect(callCount).toBe(2); // prompted again after cache clear
  }, 15000);

  // ─── Heredoc detection ───

  test("heredoc detection regex matches various heredoc styles", () => {
    const heredocRegex = /<<[-~]?\s*['"]?\w+['"]?/;
    expect(heredocRegex.test("sudo cat << EOF")).toBe(true);
    expect(heredocRegex.test("sudo cat <<'EOF'")).toBe(true);
    expect(heredocRegex.test("sudo cat <<\"EOF\"")).toBe(true);
    expect(heredocRegex.test("sudo cat <<-EOF")).toBe(true);
    expect(heredocRegex.test("sudo cat <<~MARKER")).toBe(true);
    // Non-heredoc
    expect(heredocRegex.test("sudo echo test")).toBe(false);
    expect(heredocRegex.test("echo 'no heredoc'")).toBe(false);
  });

  test("heredoc with sudo creates and cleans up askpass file", async () => {
    setSudoPasswordPromptFn(async () => "testpassword");

    // Run a heredoc+sudo command — should use ASKPASS, not stdin
    await executeBash({
      command: `sudo python3 << 'EOF'
print("hello from heredoc")
EOF`,
      timeout: 3000,
    });

    // Askpass file should be cleaned up after execution
    const leftover = readdirSync("/tmp").filter(f => f.startsWith(".kcode-askpass-"));
    expect(leftover.length).toBe(0);
  }, 15000);

  test("simple sudo does NOT create askpass file", async () => {
    setSudoPasswordPromptFn(async () => "testpass");

    await executeBash({ command: "sudo echo simple", timeout: 2000 });

    // No askpass file should exist
    const leftover = readdirSync("/tmp").filter(f => f.startsWith(".kcode-askpass-"));
    expect(leftover.length).toBe(0);
  });

  // ─── Noise filter regex ───

  test("noise filter matches English sudo prompt", () => {
    const pattern = /^\[sudo\] (?:password for|contraseña para) .*:.*$/m;
    expect(pattern.test("[sudo] password for curly: ")).toBe(true);
  });

  test("noise filter matches Spanish sudo prompt", () => {
    const pattern = /^\[sudo\] (?:password for|contraseña para) .*:.*$/m;
    expect(pattern.test("[sudo] contraseña para curly: ")).toBe(true);
  });

  test("noise filter matches stty errors (English)", () => {
    const pattern = /^stty:.*Inappropriate ioctl.*$/m;
    expect(pattern.test("stty: standard input: Inappropriate ioctl for device")).toBe(true);
  });

  test("noise filter matches stty errors (Spanish)", () => {
    const pattern = /^stty:.*Función ioctl.*$/m;
    expect(pattern.test("stty: 'standard input': Función ioctl no apropiada para el dispositivo")).toBe(true);
  });

  test("noise filter does NOT match regular output", () => {
    const pattern = /^\[sudo\] (?:password for|contraseña para) .*:.*$/m;
    expect(pattern.test("nmap scan results")).toBe(false);
    expect(pattern.test("password found: admin")).toBe(false);
    expect(pattern.test("[info] Starting scan")).toBe(false);
  });

  // ─── Security tool timeout extension ───

  test("security tools get recognized without blocking", async () => {
    // nmap --version should run fine, not be blocked
    const result = await executeBash({ command: "nmap --version 2>/dev/null || echo 'nmap not found'", timeout: 5000 });
    expect(result.content).not.toContain("BLOCKED");
  });

  // ─── Port guard: no false positives on scripts ───

  test("python3 socket code is NOT blocked by port guard", async () => {
    const result = await executeBash({
      command: `python3 -c "
import socket, json
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
sock.settimeout(3)
sock.bind(('', 38899))
print('ok')
sock.close()
"`,
      timeout: 5000,
    });
    expect(result.content).not.toContain("BLOCKED");
  });

  test("echo piped to socat is NOT blocked by port guard", async () => {
    const result = await executeBash({
      command: `echo '{"id":1}' | socat - UDP:127.0.0.1:38899,connect-timeout=1 2>&1 || true`,
      timeout: 5000,
    });
    expect(result.content).not.toContain("BLOCKED");
    expect(result.content).not.toContain("Chrome");
  });

  // ─── Background sudo ───

  test("background sudo with password starts successfully", async () => {
    setSudoPasswordPromptFn(async () => "bgpass");

    const result = await executeBash({
      command: "sudo echo bg-sudo-test",
      run_in_background: true,
      timeout: 10000,
    });

    // Should have started (may fail due to wrong password, but shouldn't crash)
    expect(result.content).toBeTruthy();
  });
});
