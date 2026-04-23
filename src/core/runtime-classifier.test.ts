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

  test("Error: Request-sent with exit 0 → started_unverified (v274 EXACT repro)", () => {
    // Real output: python caught python-bitcoinrpc's http.client error
    // and printed "Error: Request-sent" from the generic except handler.
    // Exit was 0 (process handled the exception gracefully).
    const output = "Error: Request-sent";
    expect(classifyRuntimeStatus("timeout 5 python3 main.py", 0, output)).toBe(
      "started_unverified",
    );
  });

  test("exit 0 with 'error:' prose and no positive signal → started_unverified", () => {
    expect(
      classifyRuntimeStatus("python m.py", 0, "error: could not connect to host"),
    ).toBe("started_unverified");
  });

  test("exit 0 with positive signal overrides ambiguous error text", () => {
    // App said it connected/is ready — ambiguity resolved in favor of verified.
    expect(
      classifyRuntimeStatus("python m.py", 0, "Error: old log line\nConnected to node, height=820000"),
    ).toBe("verified");
  });

  test("exit 0 with bare 'verified' output → verified (no false started_unverified)", () => {
    expect(classifyRuntimeStatus("python m.py", 0, "All good\nheight: 820000")).toBe(
      "verified",
    );
  });

  test("bash preflight refusal → runner_misfire (v275 EXACT repro)", () => {
    const output =
      "✗ Port 3000 is already in use.\n" +
      "  occupant: PID 2040642 (node)\n" +
      "  occupant cwd: /home/curly/projects\n" +
      "  Spawning bun-direct on this port would race and fail.";
    expect(classifyRuntimeStatus("bun run index.ts", null, output)).toBe(
      "runner_misfire",
    );
  });

  test("'race and fail' message alone → runner_misfire", () => {
    expect(
      classifyRuntimeStatus(
        "bun run app.ts",
        null,
        "bun-direct on this port would race and fail",
      ),
    ).toBe("runner_misfire");
  });

  test("runner_misfire takes precedence over dependency/traceback tokens", () => {
    // Preflight output can contain framework names (Next.js, Vite) —
    // make sure we don't degrade to dep/traceback just because the
    // preflight mentions them.
    const output =
      "✗ Port 3000 is already in use. Spawning bun-direct on this port would race and fail. (hint: Next.js)";
    expect(classifyRuntimeStatus("bun run index.ts", null, output)).toBe(
      "runner_misfire",
    );
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
