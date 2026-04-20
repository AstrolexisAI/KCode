// KCode - model-local-discovery tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _clearLocalModelCache,
  deriveGgufLabel,
  getLocalModelLabel,
} from "./model-local-discovery";

describe("deriveGgufLabel", () => {
  test("strips the trailing .gguf extension (lowercase)", () => {
    expect(deriveGgufLabel("/abs/path/Qwen3.6-35B.gguf")).toBe("Qwen3.6-35B");
  });

  test("strips the trailing .GGUF extension (uppercase)", () => {
    expect(deriveGgufLabel("/abs/path/Model.GGUF")).toBe("Model");
  });

  test("keeps quant/variant suffixes intact", () => {
    expect(deriveGgufLabel("/a/Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M.gguf"))
      .toBe("Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M");
  });

  test("works on bare file names", () => {
    expect(deriveGgufLabel("model.gguf")).toBe("model");
  });

  test("works with Windows backslash separators", () => {
    expect(deriveGgufLabel("C:\\models\\Foo.gguf")).toBe("Foo");
  });

  test("returns the original string if there is no .gguf suffix", () => {
    expect(deriveGgufLabel("/a/b/no-extension")).toBe("no-extension");
  });
});

describe("getLocalModelLabel", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _clearLocalModelCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("derives label from /props model_path", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe("http://localhost:8090/props");
      return new Response(
        JSON.stringify({
          model_path: "/home/curly/data/Qwen3.6-35B-A3B-Heretic-Q4_K_M.gguf",
          model_alias: "mnemo:mark6-31b",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const label = await getLocalModelLabel("http://localhost:8090");
    expect(label).toBe("Qwen3.6-35B-A3B-Heretic-Q4_K_M");
  });

  test("trims trailing slashes from baseUrl before building /props URL", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ model_path: "/p/m.gguf" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await getLocalModelLabel("http://localhost:8090///");
    expect(seenUrl).toBe("http://localhost:8090/props");
  });

  test("returns null when the endpoint responds without model_path", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ other: "data" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const label = await getLocalModelLabel("http://localhost:8091");
    expect(label).toBeNull();
  });

  test("returns null on non-2xx responses", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;

    const label = await getLocalModelLabel("http://localhost:8092");
    expect(label).toBeNull();
  });

  test("returns null on fetch errors (non-fatal)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const label = await getLocalModelLabel("http://localhost:8093");
    expect(label).toBeNull();
  });

  test("caches subsequent calls within TTL", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ model_path: "/p/Cached-Model.gguf" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const a = await getLocalModelLabel("http://localhost:8094");
    const b = await getLocalModelLabel("http://localhost:8094");
    expect(a).toBe("Cached-Model");
    expect(b).toBe("Cached-Model");
    expect(calls).toBe(1);
  });
});
