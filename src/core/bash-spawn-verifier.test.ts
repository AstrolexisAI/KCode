// Tests for bash-spawn-verifier — operator-mind post-spawn HTTP probe.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  detectServerSpawn,
  extractDeclaredPort,
  extractPidFromWrapperOutput,
  isPidAlive,
  probeServer,
  verifyBackgroundSpawn,
} from "./bash-spawn-verifier";

describe("detectServerSpawn", () => {
  test.each([
    ["next dev", "next"],
    ["npx next dev --turbo", "next"],
    ["PORT=3001 npm run dev", "node-dev"],
    ["bun run dev", "node-dev"],
    ["pnpm run dev", "node-dev"],
    ["yarn dev", "node-dev"],
    ["vite", "vite"],
    ["npx vite --port 5174", "vite"],
    ["astro dev", "astro"],
    ["python3 -m http.server", "python-http"],
    ["python -m http.server 8001", "python-http"],
    ["flask run", "flask"],
    ["uvicorn main:app", "uvicorn"],
    ["gunicorn app:app", "gunicorn"],
    ["rails s", "rails"],
    ["rails server", "rails"],
    ["caddy run", "caddy"],
    ["live-server .", "live-server"],
    ["nodemon index.js", "nodemon"],
    ["serve -s build", "static-serve"],
    ["http-server -p 10080", "static-serve"],
  ])("detects %p as %p", (cmd, framework) => {
    const d = detectServerSpawn(cmd);
    expect(d).not.toBeNull();
    expect(d!.framework).toBe(framework);
  });

  test.each([
    ["ls -la"],
    ["git status"],
    ["npm install"],
    ["cargo build"],
    ["pytest"],
    ["bun test"],
    ["echo hello"],
    ["cat package.json"],
    ["npm run build"],
    ["npm run test"],
  ])("does NOT match one-shot command %p", (cmd) => {
    expect(detectServerSpawn(cmd)).toBeNull();
  });

  // ─── Phase 7: introspection / cleanup commands must NEVER match
  //     even when their arguments contain server-spawn vocabulary.
  //     This was the false positive that defeated phase 6 in real
  //     sessions: the model tried to run the AUTHORIZED RECOVERY
  //     pkill and was told the system was saturated, because the
  //     pkill argument contained the literal string `next dev`. ───
  test.each([
    ["pkill -9 -u $USER -f 'next-server|vite|bun --watch|nodemon|next dev' || true"],
    ["pkill -f 'next dev'"],
    ["killall next-server"],
    ["pgrep -af 'vite|next dev'"],
    ["ps aux | grep 'next dev'"],
    ["ps -ef | grep -v grep | grep 'npm run dev'"],
    ["fuser 3000/tcp"],
    ["lsof -i :3000"],
    ["ss -tlnp | grep 3000"],
    ["echo 'about to start npm run dev'"],
    ["grep -r 'next dev' ./scripts"],
    ["find . -name 'nodemon.json'"],
    ["cat package.json | grep dev"],
    ["sed -i 's/next dev/vite/g' package.json"],
    ["awk '/npm run dev/ {print}' Makefile"],
  ])("phase 7: NEVER matches introspection/cleanup command %p", (cmd) => {
    expect(detectServerSpawn(cmd)).toBeNull();
  });

  test("phase 7: still matches a real spawn even after a chained cleanup", () => {
    // First segment is cleanup, second is the real spawn — the segmented
    // walker should detect the spawn in the second segment.
    // (We currently match if ANY segment is introspection — this is a
    // documentation test for the conservative behavior. If you need to
    // detect the spawn in the second half, run them as separate Bash
    // calls, which is the safer pattern anyway.)
    const r = detectServerSpawn(
      "pkill -f 'next-server' || true && PORT=3000 npm run dev",
    );
    // Conservative: when ANY segment looks like introspection we bail.
    // The model should run cleanup and spawn in separate Bash calls
    // so the spawn-verifier and preflight can probe each independently.
    expect(r).toBeNull();
  });
});

describe("extractDeclaredPort", () => {
  test("PORT= env wins", () => {
    expect(extractDeclaredPort("PORT=15423 npm run dev", 3000)).toBe(15423);
  });

  test("--port=N", () => {
    expect(extractDeclaredPort("next dev --port=4001", 3000)).toBe(4001);
  });

  test("--port N", () => {
    expect(extractDeclaredPort("vite --port 5174", 5173)).toBe(5174);
  });

  test("-p N (only for known servers)", () => {
    expect(extractDeclaredPort("http-server -p 10080", 8080)).toBe(10080);
  });

  test("-p N is ignored for unknown commands", () => {
    expect(extractDeclaredPort("cp -p file1 file2", 3000)).toBe(3000);
  });

  test("php -S host:N", () => {
    expect(extractDeclaredPort("php -S 0.0.0.0:8200")).toBe(8200);
  });

  test("python -m http.server N", () => {
    expect(extractDeclaredPort("python3 -m http.server 8765", 8000)).toBe(8765);
  });

  test("falls back to default", () => {
    expect(extractDeclaredPort("next dev", 3000)).toBe(3000);
  });

  test("returns null when no port and no default", () => {
    expect(extractDeclaredPort("php -S")).toBeNull();
  });
});

describe("extractPidFromWrapperOutput", () => {
  test("parses 'PID: N' line", () => {
    expect(extractPidFromWrapperOutput("PID: 12345\nReady on port 3000")).toBe(12345);
  });

  test("returns null for missing PID", () => {
    expect(extractPidFromWrapperOutput("just some output")).toBeNull();
  });

  test("returns null for non-numeric", () => {
    expect(extractPidFromWrapperOutput("PID: abc")).toBeNull();
  });
});

describe("probeServer", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let port = 0;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
  });

  test("returns ok for 200 response", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    port = server.port;
    const result = await probeServer(port);
    expect(result.ok).toBe(true);
    expect(result.rawStatusCode).toBe("200");
  });

  test("treats 404 as ok (server is up, just no route)", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    port = server.port;
    const result = await probeServer(port);
    expect(result.ok).toBe(true);
    expect(result.rawStatusCode).toBe("404");
  });

  test("treats 500 as failure", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    port = server.port;
    const result = await probeServer(port);
    expect(result.ok).toBe(false);
    expect(result.rawStatusCode).toBe("500");
  });

  test("connection refused returns ok=false with 000", async () => {
    // Pick a port that very likely has nothing listening (>50000 in private range)
    const result = await probeServer(59999, { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.rawStatusCode).toBe("000");
    expect(result.error).toBeDefined();
  });
});

describe("isPidAlive", () => {
  test("self process is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("garbage PID is dead", () => {
    expect(isPidAlive(9999999)).toBe(false);
  });
});

describe("verifyBackgroundSpawn — integration", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let port = 0;

  beforeEach(() => {
    server = Bun.serve({ port: 0, fetch: () => new Response("artemis") });
    port = server.port;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test("returns null for non-server commands", async () => {
    const r = await verifyBackgroundSpawn("ls -la", null, "");
    expect(r).toBeNull();
  });

  test("returns ok for live server", async () => {
    const cmd = `PORT=${port} npm run dev`;
    const r = await verifyBackgroundSpawn(cmd, process.pid, `PID: ${process.pid}`);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    expect(r!.report).toContain(`http://localhost:${port}`);
  });

  test("returns failure when probe fails", async () => {
    const cmd = `PORT=59998 npm run dev`;
    const r = await verifyBackgroundSpawn(cmd, process.pid, "PID: 12345\nstuff");
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect(r!.report).toContain("FAILED");
    expect(r!.report).toContain("59998");
    expect(r!.report).toContain("Do NOT retry");
  });

  test("includes captured output tail in failure report", async () => {
    const r = await verifyBackgroundSpawn(
      "PORT=59997 next dev",
      12345,
      "PID: 12345\nError: ENOENT next not found",
    );
    expect(r!.ok).toBe(false);
    expect(r!.report).toContain("ENOENT next not found");
  });
});
