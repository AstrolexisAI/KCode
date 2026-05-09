// CLI subcommand: kcode rag
//
// Semantic-search CLI surface around the RagEngine. Picks the best
// embedder available via embedder-factory (ANE on macOS-arm64+Pro
// addon, LocalEmbedder otherwise). Stores the SQLite vector index
// at ~/.kcode/rag.db so subsequent searches don't re-embed.

import type { Command } from "commander";

export function registerRagCommand(program: Command): void {
  const ragCmd = program
    .command("rag")
    .description("Semantic search over code (ANE-accelerated when ane-embedder addon licensed)");

  // ─── status ───────────────────────────────────────────────
  ragCmd
    .command("status")
    .description("Show RAG backend + index stats")
    .action(async () => {
      const { selectEmbedder } = await import("../../core/rag/embedder-factory");
      const { Database } = await import("bun:sqlite");
      const { kcodePath } = await import("../../core/paths");

      const sel = await selectEmbedder();
      console.log("KCode — RAG status");
      console.log();
      console.log(`  Backend:  ${sel.backend}`);
      console.log(`  Note:     ${sel.note}`);
      console.log(`  Dim:      ${sel.embedder.dimensions}`);

      const dbPath = kcodePath("rag.db");
      const { existsSync } = await import("node:fs");
      if (!existsSync(dbPath)) {
        console.log("  Index:    (none — run `kcode rag index <path>` to build one)");
        return;
      }
      try {
        const db = new Database(dbPath);
        const { RagVectorStore } = await import("../../core/rag/vector-store");
        const store = new RagVectorStore(db);
        console.log(`  Index:    ${dbPath}`);
        console.log(`  Chunks:   ${store.count}`);
        db.close();
      } catch (err) {
        console.log(`  Index:    error reading: ${err instanceof Error ? err.message : err}`);
      }
    });

  // ─── index ────────────────────────────────────────────────
  ragCmd
    .command("index <path>")
    .description("Index a file or directory into the RAG vector store")
    .option(
      "--extensions <list>",
      "Comma-separated file extensions to include (default: code-like)",
    )
    .action(async (path: string, opts: { extensions?: string }) => {
      const { selectEmbedder } = await import("../../core/rag/embedder-factory");
      const { Database } = await import("bun:sqlite");
      const { kcodePath } = await import("../../core/paths");
      const { RagEngine } = await import("../../core/rag/rag-engine");
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const { statSync } = await import("node:fs");

      const sel = await selectEmbedder();
      console.log(`Backend: ${sel.backend} (${sel.note})`);

      const dbPath = kcodePath("rag.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      const engine = new RagEngine(sel.embedder, db);

      const extList = opts.extensions
        ?.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const start = performance.now();
      let indexed = 0;
      try {
        const stat = statSync(path);
        if (stat.isFile()) {
          indexed = await engine.indexFile(path);
          console.log(`Indexed ${indexed} chunks from ${path}`);
        } else if (stat.isDirectory()) {
          const stats = await engine.indexDirectory(
            path,
            extList ? { extensions: extList } : undefined,
          );
          console.log(
            `Indexed ${stats.chunksCreated} chunks across ${stats.filesProcessed} files in ${(stats.duration / 1000).toFixed(1)}s`,
          );
          if (stats.errors.length > 0) {
            console.log(`  Errors: ${stats.errors.length} (first: ${stats.errors[0]})`);
          }
        } else {
          console.error(`Not a file or directory: ${path}`);
          process.exit(1);
        }
        const ms = performance.now() - start;
        console.log(`Done in ${(ms / 1000).toFixed(1)}s`);
      } finally {
        db.close();
        // ANE embedder owns a long-lived helper process — release it.
        const { disposeANEEmbedder } = await import("../../core/rag/ane-embedder");
        disposeANEEmbedder();
      }
    });

  // ─── search ───────────────────────────────────────────────
  ragCmd
    .command("search <query>")
    .description("Semantic search across the indexed corpus")
    .option("-k, --top-k <n>", "Number of results (default 5)", (v: string) => parseInt(v, 10), 5)
    .action(async (query: string, opts: { topK: number }) => {
      const { selectEmbedder } = await import("../../core/rag/embedder-factory");
      const { Database } = await import("bun:sqlite");
      const { existsSync } = await import("node:fs");
      const { kcodePath } = await import("../../core/paths");
      const { RagEngine } = await import("../../core/rag/rag-engine");

      const dbPath = kcodePath("rag.db");
      if (!existsSync(dbPath)) {
        console.error("No index found. Run `kcode rag index <path>` first.");
        process.exit(1);
      }

      const sel = await selectEmbedder();
      console.log(`Backend: ${sel.backend}`);
      console.log();

      const db = new Database(dbPath);
      const engine = new RagEngine(sel.embedder, db);
      try {
        const start = performance.now();
        const results = await engine.search(query, opts.topK);
        const ms = performance.now() - start;
        console.log(`Top ${results.length} results for "${query}" (${ms.toFixed(0)}ms):`);
        console.log();
        for (const [i, r] of results.entries()) {
          console.log(
            `  ${i + 1}. ${r.filepath}:${r.lineStart}-${r.lineEnd} (${r.score.toFixed(3)}) ${r.chunkType}`,
          );
          if (r.name) console.log(`     ${r.name}`);
        }
      } finally {
        db.close();
        const { disposeANEEmbedder } = await import("../../core/rag/ane-embedder");
        disposeANEEmbedder();
      }
    });
}
