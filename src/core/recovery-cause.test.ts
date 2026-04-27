import { describe, expect, test } from "bun:test";
import {
  derivePrimaryFailureCause,
  recommendedRecovery,
  speculationAllowed,
} from "./recovery-cause";

describe("derivePrimaryFailureCause", () => {
  test("the EXACT #109 bash output → missing_directory", () => {
    const output =
      "bash: línea 1: cd: /home/curly/proyectos/bitcoin-tui-dashboard: No existe el fichero o el directorio";
    expect(derivePrimaryFailureCause(output)).toBe("missing_directory");
  });

  test("English ENOENT variants", () => {
    expect(derivePrimaryFailureCause("ENOENT: no such file")).toBe("missing_directory");
    expect(derivePrimaryFailureCause("cannot stat '/tmp/foo'")).toBe("missing_directory");
    expect(derivePrimaryFailureCause("cannot access: No such file or directory")).toBe(
      "missing_directory",
    );
  });

  test("permission denied", () => {
    expect(derivePrimaryFailureCause("Permission denied")).toBe("permission_denied");
    expect(derivePrimaryFailureCause("EACCES: open '/etc/shadow'")).toBe("permission_denied");
  });

  test("python traceback", () => {
    expect(derivePrimaryFailureCause("Traceback (most recent call last):\n  File...")).toBe(
      "runtime_traceback",
    );
  });

  test("module not found → dependency_missing", () => {
    expect(derivePrimaryFailureCause("ModuleNotFoundError: No module named 'bitcoin'")).toBe(
      "dependency_missing",
    );
    expect(derivePrimaryFailureCause("Cannot find module 'express'")).toBe("dependency_missing");
  });

  test("timeout", () => {
    expect(derivePrimaryFailureCause("exit code 124")).toBe("timeout");
    expect(derivePrimaryFailureCause("command timed out")).toBe("timeout");
  });

  test("network", () => {
    expect(derivePrimaryFailureCause("connect ECONNREFUSED 127.0.0.1:5432")).toBe("network");
    expect(derivePrimaryFailureCause("connection refused")).toBe("network");
  });

  test("unknown when nothing matches", () => {
    expect(derivePrimaryFailureCause("some random text")).toBe("unknown");
    expect(derivePrimaryFailureCause("")).toBe("unknown");
  });
});

describe("speculationAllowed", () => {
  test("missing_directory/file/dependency/syntax ban speculation", () => {
    expect(speculationAllowed("missing_directory")).toBe(false);
    expect(speculationAllowed("missing_file")).toBe(false);
    expect(speculationAllowed("dependency_missing")).toBe(false);
    expect(speculationAllowed("syntax_error")).toBe(false);
  });

  test("permission/network/timeout/traceback/unknown allow speculation", () => {
    expect(speculationAllowed("permission_denied")).toBe(true);
    expect(speculationAllowed("network")).toBe(true);
    expect(speculationAllowed("timeout")).toBe(true);
    expect(speculationAllowed("runtime_traceback")).toBe(true);
    expect(speculationAllowed("unknown")).toBe(true);
  });
});

describe("recommendedRecovery", () => {
  test("#109 scenario: suggests create-and-verify, nothing else", () => {
    const rec = recommendedRecovery("missing_directory")!;
    expect(rec).toContain("Create and verify");
    expect(rec).not.toMatch(/process|dev server|interference/i);
  });

  test("timeout says 'started and stayed alive' explicitly", () => {
    expect(recommendedRecovery("timeout")).toContain("started and stayed alive");
    expect(recommendedRecovery("timeout")).toContain("end-to-end");
  });

  test("unknown returns null", () => {
    expect(recommendedRecovery("unknown")).toBeNull();
  });
});
