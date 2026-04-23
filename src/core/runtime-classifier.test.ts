import { describe, expect, test } from "bun:test";
import {
  classifyRuntimeStatus,
  isFailedStatus,
  phaseForStatus,
} from "./runtime-classifier";

describe("runtime-classifier", () => {
  test("401 Unauthorized → failed_auth (EXACT #111 v273 line)", () => {
    // Real output from python-bitcoinrpc when the rpcuser/rpcpassword pair is wrong.
    const output =
      "Testing Bitcoin RPC connection...\n" +
      "❌ RPC Error: -342: non-JSON HTTP response with '401 Unauthorized' from server\n" +
      "Please check your RPC credentials and Bitcoin node configuration.";
    expect(classifyRuntimeStatus("python test_connection.py", 0, output)).toBe(
      "failed_auth",
    );
  });

  test("403 Forbidden → failed_auth", () => {
    expect(classifyRuntimeStatus("curl api", 0, "HTTP 403 Forbidden")).toBe(
      "failed_auth",
    );
  });

  test("Invalid credentials phrase → failed_auth", () => {
    expect(
      classifyRuntimeStatus("auth", 1, "Login failed: invalid credentials"),
    ).toBe("failed_auth");
  });

  test("ModuleNotFoundError → failed_dependency (before traceback)", () => {
    const output =
      "Traceback (most recent call last):\n" +
      '  File "test_connection.py", line 2, in <module>\n' +
      "    from bitcoinrpc.authproxy import AuthServiceProxy\n" +
      "ModuleNotFoundError: No module named 'bitcoinrpc'";
    expect(classifyRuntimeStatus("python test_connection.py", 1, output)).toBe(
      "failed_dependency",
    );
  });

  test("ImportError → failed_dependency", () => {
    expect(
      classifyRuntimeStatus("python m.py", 1, "ImportError: cannot import name 'X'"),
    ).toBe("failed_dependency");
  });

  test("Connection refused → failed_connection", () => {
    expect(
      classifyRuntimeStatus("python m.py", 1, "ConnectionRefusedError: [Errno 111] Connection refused"),
    ).toBe("failed_connection");
  });

  test("ECONNREFUSED → failed_connection", () => {
    expect(classifyRuntimeStatus("node s.js", 1, "Error: connect ECONNREFUSED 127.0.0.1:8332")).toBe(
      "failed_connection",
    );
  });

  test("SyntaxError → failed_traceback", () => {
    expect(
      classifyRuntimeStatus("python m.py", 1, "  File \"m.py\", line 5\n    x ==\n        ^\nSyntaxError: invalid syntax"),
    ).toBe("failed_traceback");
  });

  test("exit 124 alone → alive_timeout", () => {
    expect(classifyRuntimeStatus("python main.py", 124, "Starting dashboard...")).toBe(
      "alive_timeout",
    );
  });

  test("exit 0 clean → verified", () => {
    expect(classifyRuntimeStatus("python m.py", 0, "ok")).toBe("verified");
  });

  test("unclassified non-zero → failed_unknown", () => {
    expect(classifyRuntimeStatus("python m.py", 2, "some weird output")).toBe(
      "failed_unknown",
    );
  });

  test("isFailedStatus matches all failed_ variants", () => {
    expect(isFailedStatus("failed_auth")).toBe(true);
    expect(isFailedStatus("failed_connection")).toBe(true);
    expect(isFailedStatus("failed_traceback")).toBe(true);
    expect(isFailedStatus("failed_dependency")).toBe(true);
    expect(isFailedStatus("failed_unknown")).toBe(true);
    expect(isFailedStatus("verified")).toBe(false);
    expect(isFailedStatus("alive_timeout")).toBe(false);
    expect(isFailedStatus("started")).toBe(false);
  });

  test("phaseForStatus maps failed_auth to blocked, others to failed", () => {
    expect(phaseForStatus("failed_auth")).toBe("blocked");
    expect(phaseForStatus("failed_connection")).toBe("failed");
    expect(phaseForStatus("failed_traceback")).toBe("failed");
    expect(phaseForStatus("failed_dependency")).toBe("failed");
    expect(phaseForStatus("verified")).toBe("done");
    expect(phaseForStatus("alive_timeout")).toBe("verifying");
  });
});
