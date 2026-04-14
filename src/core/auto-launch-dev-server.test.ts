// Tests for phase 22 auto-launch dev server hook.

import { afterEach, describe, expect, test } from "bun:test";
import {
  __autoLaunchSessionState,
  extractRequestedPort,
  hasRunnableWriteInTurn,
  hasRuntimeIntent,
  resetAutoLaunchState,
} from "./auto-launch-dev-server";
import type { Message } from "./types";

afterEach(() => {
  resetAutoLaunchState();
});

describe("hasRuntimeIntent", () => {
  test("fires on Spanish action verbs", () => {
    expect(hasRuntimeIntent(["levantalo"])).toBe(true);
    expect(hasRuntimeIntent(["levanta el servidor web"])).toBe(true);
    expect(hasRuntimeIntent(["ejecuta el proyecto"])).toBe(true);
    expect(hasRuntimeIntent(["arrancame el dashboard"])).toBe(true);
    expect(hasRuntimeIntent(["lanzalo"])).toBe(true);
    expect(hasRuntimeIntent(["corre la app"])).toBe(true);
  });

  test("fires on English action verbs", () => {
    expect(hasRuntimeIntent(["run the server"])).toBe(true);
    expect(hasRuntimeIntent(["launch it"])).toBe(true);
    expect(hasRuntimeIntent(["spin up the dashboard"])).toBe(true);
    expect(hasRuntimeIntent(["start the app"])).toBe(true);
  });

  test("fires on runtime nouns and port references", () => {
    expect(hasRuntimeIntent(["quiero un dashboard"])).toBe(true);
    expect(hasRuntimeIntent(["abre en http://localhost:3000"])).toBe(true);
    expect(hasRuntimeIntent(["en el puerto 24564"])).toBe(true);
    expect(hasRuntimeIntent(["on port 3000"])).toBe(true);
    expect(hasRuntimeIntent(["que se levante automaticamente"])).toBe(true);
    expect(hasRuntimeIntent(["to see it running"])).toBe(true);
  });

  test("fires on the actual Orbital prompt fragment", () => {
    const orbitalFragment =
      "Incluir al final del archivo un servidor web simple usando Node.js + Express " +
      "que levante automáticamente la aplicación en el puerto 24564";
    expect(hasRuntimeIntent([orbitalFragment])).toBe(true);
  });

  test("does NOT fire on off-topic prompts", () => {
    expect(hasRuntimeIntent(["fix the typo in config.ts"])).toBe(false);
    expect(hasRuntimeIntent(["explain how this function works"])).toBe(false);
    expect(hasRuntimeIntent(["write a markdown summary"])).toBe(false);
    expect(hasRuntimeIntent([])).toBe(false);
    expect(hasRuntimeIntent([""])).toBe(false);
  });

  test("scans all user messages, not just the latest", () => {
    const texts = [
      "levanta el servidor web en puerto 24564",
      "ahora cambia el color del header",
      "y añade un footer",
    ];
    expect(hasRuntimeIntent(texts)).toBe(true);
  });
});

describe("hasRunnableWriteInTurn", () => {
  test("returns true when this turn contains a successful Write", () => {
    const messages: Message[] = [
      { role: "user", content: "create orbital.html" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "w1",
            name: "Write",
            input: { file_path: "/tmp/orbital.html", content: "<html></html>" },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "w1",
            is_error: false,
            content: "Created /tmp/orbital.html (1026 lines)",
          } as unknown as never,
        ],
      },
    ];
    expect(hasRunnableWriteInTurn(messages)).toBe(true);
  });

  test("returns false when the turn has only Read/Edit", () => {
    const messages: Message[] = [
      { role: "user", content: "read the config" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "r1",
            name: "Read",
            input: { file_path: "/tmp/cfg.ts" },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "r1",
            is_error: false,
            content: "file contents...",
          } as unknown as never,
        ],
      },
    ];
    expect(hasRunnableWriteInTurn(messages)).toBe(false);
  });

  test("returns false when Write failed (is_error=true)", () => {
    const messages: Message[] = [
      { role: "user", content: "create it" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "w1",
            name: "Write",
            input: { file_path: "/tmp/x.html", content: "..." },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "w1",
            is_error: true,
            content: "BLOCKED: something",
          } as unknown as never,
        ],
      },
    ];
    expect(hasRunnableWriteInTurn(messages)).toBe(false);
  });

  test("Bug #10: skips [SYSTEM]-injected user messages when walking back", () => {
    // Reproduces the Orbital v2.10.65 case where truncation retries
    // injected [SYSTEM] Your response was cut off messages AFTER
    // the original Writes, and hasRunnableWriteInTurn then treated
    // the [SYSTEM] message as the turn boundary — hiding the Write.
    const messages: Message[] = [
      { role: "user", content: "levante la aplicación en puerto 24564" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "w1",
            name: "Write",
            input: { file_path: "/tmp/orbital.html", content: "<html></html>" },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "w1",
            is_error: false,
            content: "Created /tmp/orbital.html (987 lines)",
          } as unknown as never,
        ],
      },
      // handlePostTurn truncation retry injection
      {
        role: "user",
        content:
          '[SYSTEM] Your response was cut off. Here is how it ended: "..." Continue EXACTLY from that point.',
      },
      // Model generates more text (no tool call)
      { role: "assistant", content: "More text here" },
    ];
    expect(hasRunnableWriteInTurn(messages)).toBe(true);
  });

  test("scopes to the current turn only (ignores earlier user text)", () => {
    const messages: Message[] = [
      { role: "user", content: "earlier request" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "w0",
            name: "Write",
            input: { file_path: "/tmp/old.html", content: "..." },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "w0",
            is_error: false,
            content: "Created /tmp/old.html (100 lines)",
          } as unknown as never,
        ],
      },
      // NEW turn begins:
      { role: "user", content: "now add a paragraph" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "e1",
            name: "Edit",
            input: { file_path: "/tmp/old.html", old_string: "a", new_string: "b" },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "e1",
            is_error: false,
            content: "Edited old.html (1 replacement)",
          } as unknown as never,
        ],
      },
    ];
    // The Write in the earlier turn should NOT count for the current turn
    expect(hasRunnableWriteInTurn(messages)).toBe(false);
  });
});

describe("resetAutoLaunchState", () => {
  test("clears session state flags", () => {
    __autoLaunchSessionState.launched = true;
    __autoLaunchSessionState.launchedAt = Date.now();
    __autoLaunchSessionState.launchedCwd = "/tmp";
    resetAutoLaunchState();
    expect(__autoLaunchSessionState.launched).toBe(false);
    expect(__autoLaunchSessionState.launchedCwd).toBe("");
  });
});

describe("extractRequestedPort", () => {
  test("extracts port from Orbital prompt fragment", () => {
    const orbitalFragment =
      "Incluir al final del archivo un servidor web simple usando Node.js + Express " +
      "que levante automáticamente la aplicación en el puerto 24564";
    expect(extractRequestedPort([orbitalFragment])).toBe(24564);
  });

  test("extracts English 'port N' phrasing", () => {
    expect(extractRequestedPort(["start the server on port 3000"])).toBe(3000);
    expect(extractRequestedPort(["listen at port 8080"])).toBe(8080);
  });

  test("extracts 'puerto N' and 'puerto:N' phrasing", () => {
    expect(extractRequestedPort(["usa el puerto 5173"])).toBe(5173);
    expect(extractRequestedPort(["puerto: 9090"])).toBe(9090);
  });

  test("ignores out-of-range ports", () => {
    // Privileged / too-low ports are rejected
    expect(extractRequestedPort(["port 22"])).toBeUndefined();
    expect(extractRequestedPort(["port 80"])).toBeUndefined();
    // 1024 is the floor — this test documents the boundary
    expect(extractRequestedPort(["port 1023"])).toBeUndefined();
    expect(extractRequestedPort(["port 1024"])).toBe(1024);
  });

  test("returns undefined when no port mentioned", () => {
    expect(extractRequestedPort(["make a web app"])).toBeUndefined();
    expect(extractRequestedPort([])).toBeUndefined();
  });

  test("scans across all user texts, returns first match", () => {
    const texts = [
      "crea una aplicacion",
      "en el puerto 24564",
      "ponle un header",
    ];
    expect(extractRequestedPort(texts)).toBe(24564);
  });
});
