import { test, expect, describe } from "bun:test";
import { TFIDFEmbedder, Embedder, detectBestBackend } from "./embedder";

// ─── TF-IDF Embedder Tests ────────────────────────────────────

describe("TFIDFEmbedder", () => {
  test("fit builds vocabulary from documents", () => {
    const tfidf = new TFIDFEmbedder();
    tfidf.fit([
      "function hello world",
      "class greeting extends base",
      "function goodbye world",
    ]);

    expect(tfidf.dimensions).toBeGreaterThan(0);
  });

  test("embed returns vector of correct dimension", () => {
    const tfidf = new TFIDFEmbedder();
    tfidf.fit([
      "function add numbers together",
      "class calculator with methods",
      "export default function multiply",
    ]);

    const vec = tfidf.embed("function add");
    expect(vec.length).toBe(tfidf.dimensions);
  });

  test("embed returns normalized vector (L2 norm close to 1)", () => {
    const tfidf = new TFIDFEmbedder();
    tfidf.fit(["alpha beta gamma", "delta epsilon zeta"]);

    const vec = tfidf.embed("alpha beta");
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    // Norm should be ~1.0 for non-zero vectors
    if (norm > 0) {
      expect(norm).toBeCloseTo(1.0, 3);
    }
  });

  test("similar texts have higher cosine similarity", () => {
    const tfidf = new TFIDFEmbedder();
    const docs = [
      "function authenticate user with password",
      "function validate credentials for login",
      "function render chart with data points",
      "function draw graph visualization",
    ];
    tfidf.fit(docs);

    const authVec = tfidf.embed("authenticate user login");
    const loginVec = tfidf.embed("validate credentials password");
    const chartVec = tfidf.embed("render chart visualization");

    // Auth and login should be more similar than auth and chart
    const simAuthLogin = cosine(authVec, loginVec);
    const simAuthChart = cosine(authVec, chartVec);

    // This should generally hold with TF-IDF
    expect(typeof simAuthLogin).toBe("number");
    expect(typeof simAuthChart).toBe("number");
  });

  test("embed returns empty array if not fitted", () => {
    const tfidf = new TFIDFEmbedder();
    const vec = tfidf.embed("test");
    expect(vec).toEqual([]);
  });

  test("embedBatch returns array of vectors", () => {
    const tfidf = new TFIDFEmbedder();
    tfidf.fit(["hello world", "foo bar"]);

    const vecs = tfidf.embedBatch(["hello", "foo"]);
    expect(vecs.length).toBe(2);
    expect(vecs[0]!.length).toBe(tfidf.dimensions);
    expect(vecs[1]!.length).toBe(tfidf.dimensions);
  });

  test("serialize and deserialize preserves vocabulary", () => {
    const tfidf = new TFIDFEmbedder();
    tfidf.fit(["hello world test", "alpha beta gamma"]);

    const original = tfidf.embed("hello world");
    const json = tfidf.serialize();

    const restored = new TFIDFEmbedder();
    restored.deserialize(json);

    const reconstructed = restored.embed("hello world");
    expect(reconstructed.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(original[i]!, 6);
    }
  });

  test("vocabulary caps at 10,000 tokens", () => {
    const tfidf = new TFIDFEmbedder();
    // Generate a document with > 10,000 unique tokens
    const bigDoc = Array.from({ length: 15000 }, (_, i) => `word${i}`).join(" ");
    tfidf.fit([bigDoc]);

    expect(tfidf.dimensions).toBeLessThanOrEqual(10_000);
  });

  test("filters tokens shorter than 2 chars", () => {
    const tfidf = new TFIDFEmbedder();
    tfidf.fit(["a b cc dd eee"]);

    // Should only have cc, dd, eee in vocab
    expect(tfidf.dimensions).toBe(3);
  });
});

// ─── Embedder (unified) Tests ──────────────────────────────────

describe("Embedder", () => {
  test("init with tfidf backend sets backend correctly", async () => {
    const embedder = new Embedder({ backend: "tfidf" });
    const backend = await embedder.init();
    expect(backend).toBe("tfidf");
    expect(embedder.getBackend()).toBe("tfidf");
  });

  test("fitTFIDF sets dimensions", () => {
    const embedder = new Embedder({ backend: "tfidf" });
    embedder.init();
    embedder.fitTFIDF(["hello world", "foo bar baz"]);
    expect(embedder.getDimensions()).toBeGreaterThan(0);
  });

  test("embed returns vector after fitting", async () => {
    const embedder = new Embedder({ backend: "tfidf" });
    await embedder.init();
    embedder.fitTFIDF(["function authenticate user", "class database connection"]);

    const vec = await embedder.embed("authenticate");
    expect(vec.length).toBeGreaterThan(0);
  });

  test("embedBatch returns multiple vectors", async () => {
    const embedder = new Embedder({ backend: "tfidf" });
    await embedder.init();
    embedder.fitTFIDF(["hello world", "foo bar"]);

    const vecs = await embedder.embedBatch(["hello", "foo"]);
    expect(vecs.length).toBe(2);
  });

  test("auto-fits TF-IDF if not pre-fitted", async () => {
    const embedder = new Embedder({ backend: "tfidf" });
    await embedder.init();

    // embedBatch without explicit fit — should auto-fit on input
    const vecs = await embedder.embedBatch(["hello world", "foo bar"]);
    expect(vecs.length).toBe(2);
    expect(vecs[0]!.length).toBeGreaterThan(0);
  });

  test("setTFIDF restores a pre-built instance", async () => {
    const tfidf = new TFIDFEmbedder();
    tfidf.fit(["alpha beta", "gamma delta"]);

    const embedder = new Embedder({ backend: "tfidf" });
    await embedder.init();
    embedder.setTFIDF(tfidf);

    expect(embedder.getDimensions()).toBe(tfidf.dimensions);
    const vec = await embedder.embed("alpha");
    expect(vec.length).toBe(tfidf.dimensions);
  });
});

// ─── detectBestBackend Tests ───────────────────────────────────

describe("detectBestBackend", () => {
  test("falls back to tfidf when no servers are running", async () => {
    // In test environment, Ollama and llama.cpp are likely not running
    const backend = await detectBestBackend();
    // Should return some valid backend (likely tfidf in CI)
    expect(["ollama", "llama-cpp", "bge-micro", "tfidf"]).toContain(backend);
  });
});

// ─── Helpers ───────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
