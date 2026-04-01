// KCode - Plugin Sandbox
// Restricts plugin execution to safe operations within plugin directory.

import { resolve, relative, isAbsolute } from "node:path";

export interface SandboxOptions {
  timeout?: number; // ms, default: 30000
  maxMemoryMB?: number; // default: 256
  allowNetwork?: boolean; // default: false
  allowedPaths?: string[]; // additional allowed paths beyond plugin dir
}

export class PluginSandbox {
  private pluginDir: string;
  private options: Required<SandboxOptions>;
  private allowedPaths: Set<string>;

  constructor(pluginDir: string, options?: SandboxOptions) {
    this.pluginDir = resolve(pluginDir);
    this.options = {
      timeout: options?.timeout ?? 30_000,
      maxMemoryMB: options?.maxMemoryMB ?? 256,
      allowNetwork: options?.allowNetwork ?? false,
      allowedPaths: options?.allowedPaths ?? [],
    };
    this.allowedPaths = new Set([
      this.pluginDir,
      ...this.options.allowedPaths.map((p) => resolve(p)),
    ]);
  }

  /**
   * Validate that a file path is within the sandbox boundaries.
   */
  validatePath(filePath: string): {
    valid: boolean;
    resolved: string;
    error?: string;
  } {
    const resolved = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(this.pluginDir, filePath);

    // Check path traversal
    if (filePath.includes("..")) {
      const rel = relative(this.pluginDir, resolved);
      if (rel.startsWith("..")) {
        return {
          valid: false,
          resolved,
          error: `Path traversal detected: "${filePath}" resolves outside plugin directory`,
        };
      }
    }

    // Check against allowed paths
    for (const allowed of this.allowedPaths) {
      if (resolved.startsWith(allowed + "/") || resolved === allowed) {
        return { valid: true, resolved };
      }
    }

    return {
      valid: false,
      resolved,
      error: `Path "${filePath}" is outside allowed directories`,
    };
  }

  /**
   * Validate a command before execution.
   */
  validateCommand(command: string, args: string[]): {
    valid: boolean;
    error?: string;
  } {
    const blockedCommands = new Set([
      "rm",
      "rmdir",
      "mkfs",
      "dd",
      "fdisk",
      "kill",
      "killall",
      "pkill",
      "shutdown",
      "reboot",
      "halt",
      "systemctl",
      "service",
      "sudo",
      "su",
      "chmod",
      "chown",
      "chgrp",
      "mount",
      "umount",
    ]);

    const baseCmd = command.split("/").pop() || command;
    if (blockedCommands.has(baseCmd)) {
      return {
        valid: false,
        error: `Command "${baseCmd}" is not allowed in plugin sandbox`,
      };
    }

    // Check for shell injection patterns
    const fullCmd = [command, ...args].join(" ");
    const injectionPatterns = [
      /[;&|`$]/, // Shell operators
      /\$\(/, // Command substitution
      />\s*\//, // Redirect to absolute path
      /\|\s*sh/, // Pipe to shell
      /\|\s*bash/, // Pipe to bash
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(fullCmd)) {
        return {
          valid: false,
          error: `Potentially unsafe command pattern detected`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Execute a function with timeout enforcement.
   */
  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const timeout = timeoutMs ?? this.options.timeout;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`Plugin execution timed out after ${timeout}ms`),
        );
      }, timeout);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Run a subprocess within sandbox constraints.
   */
  async runProcess(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const cmdValidation = this.validateCommand(command, args);
    if (!cmdValidation.valid) {
      throw new Error(cmdValidation.error);
    }

    const cwd = options?.cwd || this.pluginDir;
    const cwdValidation = this.validatePath(cwd);
    if (!cwdValidation.valid) {
      throw new Error(cwdValidation.error);
    }

    // Sanitize environment - remove sensitive vars
    const env = { ...process.env, ...options?.env };
    const sensitiveKeys = [
      "KCODE_API_KEY",
      "KCODE_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ];
    for (const key of sensitiveKeys) {
      delete env[key];
    }

    if (!this.options.allowNetwork) {
      env.no_proxy = "*";
      env.NO_PROXY = "*";
    }

    const result = Bun.spawnSync([command, ...args], {
      cwd: cwdValidation.resolved,
      env,
      timeout: this.options.timeout,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  /**
   * Read a file within the sandbox.
   */
  async readFile(filePath: string): Promise<string> {
    const validation = this.validatePath(filePath);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    const file = Bun.file(validation.resolved);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filePath}`);
    }
    return file.text();
  }

  /**
   * Write a file within the sandbox.
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const validation = this.validatePath(filePath);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    await Bun.write(validation.resolved, content);
  }

  /**
   * List files within the sandbox directory.
   */
  listFiles(subdir?: string): string[] {
    const { readdirSync } = require("node:fs");
    const dir = subdir
      ? resolve(this.pluginDir, subdir)
      : this.pluginDir;
    const validation = this.validatePath(dir);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    try {
      return readdirSync(validation.resolved) as string[];
    } catch {
      return [];
    }
  }

  getPluginDir(): string {
    return this.pluginDir;
  }

  getOptions(): Required<SandboxOptions> {
    return { ...this.options };
  }
}

export function createSandbox(
  pluginDir: string,
  options?: SandboxOptions,
): PluginSandbox {
  return new PluginSandbox(pluginDir, options);
}
