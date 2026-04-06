// KCode - API Engine: Generate REST APIs from entity descriptions
//
// "create an API for users, products, and orders"
// → Machine: routes + controllers + models + validation + tests
// → LLM: only business logic specific to the domain

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ApiFramework = "express" | "fastapi" | "hono" | "fastify";

export interface Entity {
  name: string;
  fields: Array<{ name: string; type: string; required: boolean }>;
}

export interface ApiProject {
  framework: ApiFramework;
  entities: Entity[];
  files: Array<{ path: string; content: string; needsLlm: boolean }>;
  projectPath: string;
}

// ── Entity Parser ──────────────────────────────────────────────

const DEFAULT_FIELDS: Record<string, Array<{ name: string; type: string; required: boolean }>> = {
  user: [
    { name: "id", type: "string", required: true },
    { name: "email", type: "string", required: true },
    { name: "name", type: "string", required: true },
    { name: "password_hash", type: "string", required: true },
    { name: "role", type: "string", required: false },
    { name: "created_at", type: "datetime", required: true },
  ],
  product: [
    { name: "id", type: "string", required: true },
    { name: "name", type: "string", required: true },
    { name: "description", type: "string", required: false },
    { name: "price", type: "number", required: true },
    { name: "category", type: "string", required: false },
    { name: "stock", type: "integer", required: true },
    { name: "image_url", type: "string", required: false },
    { name: "created_at", type: "datetime", required: true },
  ],
  order: [
    { name: "id", type: "string", required: true },
    { name: "user_id", type: "string", required: true },
    { name: "items", type: "json", required: true },
    { name: "total", type: "number", required: true },
    { name: "status", type: "string", required: true },
    { name: "created_at", type: "datetime", required: true },
  ],
  post: [
    { name: "id", type: "string", required: true },
    { name: "title", type: "string", required: true },
    { name: "content", type: "string", required: true },
    { name: "author_id", type: "string", required: true },
    { name: "published", type: "boolean", required: false },
    { name: "tags", type: "json", required: false },
    { name: "created_at", type: "datetime", required: true },
  ],
  comment: [
    { name: "id", type: "string", required: true },
    { name: "post_id", type: "string", required: true },
    { name: "author_id", type: "string", required: true },
    { name: "content", type: "string", required: true },
    { name: "created_at", type: "datetime", required: true },
  ],
  task: [
    { name: "id", type: "string", required: true },
    { name: "title", type: "string", required: true },
    { name: "description", type: "string", required: false },
    { name: "status", type: "string", required: true },
    { name: "priority", type: "string", required: false },
    { name: "assigned_to", type: "string", required: false },
    { name: "due_date", type: "datetime", required: false },
    { name: "created_at", type: "datetime", required: true },
  ],
  message: [
    { name: "id", type: "string", required: true },
    { name: "sender_id", type: "string", required: true },
    { name: "recipient_id", type: "string", required: true },
    { name: "content", type: "string", required: true },
    { name: "read", type: "boolean", required: false },
    { name: "created_at", type: "datetime", required: true },
  ],
};

function parseEntities(message: string): Entity[] {
  const entities: Entity[] = [];
  const words = message.toLowerCase();

  for (const [name, fields] of Object.entries(DEFAULT_FIELDS)) {
    // Match plural and singular forms
    const pattern = new RegExp(`\\b${name}s?\\b`, "i");
    if (pattern.test(words)) {
      entities.push({ name, fields });
    }
  }

  // If no known entities matched, create a generic one
  if (entities.length === 0) {
    const entityMatch = words.match(/(?:for|para|de|with)\s+(\w+)/);
    if (entityMatch) {
      entities.push({
        name: entityMatch[1]!,
        fields: [
          { name: "id", type: "string", required: true },
          { name: "name", type: "string", required: true },
          { name: "description", type: "string", required: false },
          { name: "created_at", type: "datetime", required: true },
        ],
      });
    }
  }

  return entities;
}

function detectApiFramework(message: string): ApiFramework {
  if (/fastapi|python/i.test(message)) return "fastapi";
  if (/hono/i.test(message)) return "hono";
  if (/fastify/i.test(message)) return "fastify";
  return "express"; // default
}

// ── Express API Generator ──────────────────────────────────────

function generateExpressApi(entities: Entity[], name: string): Array<{ path: string; content: string; needsLlm: boolean }> {
  const files: Array<{ path: string; content: string; needsLlm: boolean }> = [];

  // package.json
  files.push({
    path: "package.json",
    content: JSON.stringify({
      name,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "tsx watch src/index.ts",
        build: "tsc",
        start: "node dist/index.js",
        test: "vitest run",
      },
      dependencies: {
        express: "^5.1.0",
        cors: "^2.8.5",
        zod: "^3.24.0",
        "better-sqlite3": "^11.0.0",
        "uuid": "^11.0.0",
      },
      devDependencies: {
        typescript: "^5.8.0",
        tsx: "^4.19.0",
        "@types/express": "^5.0.0",
        "@types/better-sqlite3": "^7.6.0",
        "@types/cors": "^2.8.0",
        "@types/uuid": "^10.0.0",
        vitest: "^3.0.0",
      },
    }, null, 2),
    needsLlm: false,
  });

  // tsconfig
  files.push({
    path: "tsconfig.json",
    content: JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        outDir: "dist",
        rootDir: "src",
        esModuleInterop: true,
        declaration: true,
      },
      include: ["src"],
    }, null, 2),
    needsLlm: false,
  });

  // Main entry
  files.push({
    path: "src/index.ts",
    content: `import express from "express";
import cors from "cors";
${entities.map(e => `import { ${e.name}Router } from "./routes/${e.name}";`).join("\n")}
import { initDb } from "./db";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// Routes
${entities.map(e => `app.use("/api/${e.name}s", ${e.name}Router);`).join("\n")}

// Initialize database and start
initDb();
app.listen(PORT, () => console.log(\`API running on http://localhost:\${PORT}\`));

export default app;
`,
    needsLlm: false,
  });

  // Database
  files.push({
    path: "src/db.ts",
    content: `import Database from "better-sqlite3";
import { join } from "path";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(join(process.cwd(), "data.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

export function initDb(): void {
  const db = getDb();
${entities.map(e => `
  db.exec(\`
    CREATE TABLE IF NOT EXISTS ${e.name}s (
      ${e.fields.map(f => `${f.name} ${sqlType(f.type)}${f.required && f.name !== "id" ? " NOT NULL" : ""}${f.name === "id" ? " PRIMARY KEY" : ""}`).join(",\n      ")}
    )
  \`);`).join("\n")}
}

function sqlType(t: string): string {
  switch (t) {
    case "string": return "TEXT";
    case "number": return "REAL";
    case "integer": return "INTEGER";
    case "boolean": return "INTEGER";
    case "datetime": return "TEXT DEFAULT (datetime('now'))";
    case "json": return "TEXT";
    default: return "TEXT";
  }
}
`,
    needsLlm: false,
  });

  // Generate route + model for each entity
  for (const entity of entities) {
    const E = entity.name;
    const Es = E + "s";
    const fields = entity.fields.filter(f => f.name !== "id" && f.name !== "created_at");

    // Zod validation schema
    files.push({
      path: `src/schemas/${E}.ts`,
      content: `import { z } from "zod";

export const create${cap(E)}Schema = z.object({
${fields.map(f => `  ${f.name}: z.${zodType(f.type)}()${f.required ? "" : ".optional()"},`).join("\n")}
});

export const update${cap(E)}Schema = create${cap(E)}Schema.partial();

export type Create${cap(E)} = z.infer<typeof create${cap(E)}Schema>;
export type Update${cap(E)} = z.infer<typeof update${cap(E)}Schema>;
`,
      needsLlm: false,
    });

    // Route (CRUD)
    files.push({
      path: `src/routes/${E}.ts`,
      content: `import { Router } from "express";
import { v4 as uuid } from "uuid";
import { getDb } from "../db";
import { create${cap(E)}Schema, update${cap(E)}Schema } from "../schemas/${E}";

export const ${E}Router = Router();

// GET /${Es} — list all
${E}Router.get("/", (_req, res) => {
  const items = getDb().prepare("SELECT * FROM ${Es} ORDER BY created_at DESC").all();
  res.json(items);
});

// GET /${Es}/:id — get by id
${E}Router.get("/:id", (req, res) => {
  const item = getDb().prepare("SELECT * FROM ${Es} WHERE id = ?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "${cap(E)} not found" });
  res.json(item);
});

// POST /${Es} — create
${E}Router.post("/", (req, res) => {
  const parsed = create${cap(E)}Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = uuid();
  const data = parsed.data;
  getDb().prepare(
    "INSERT INTO ${Es} (id, ${fields.map(f => f.name).join(", ")}) VALUES (?, ${fields.map(() => "?").join(", ")})"
  ).run(id, ${fields.map(f => `data.${f.name}${f.type === "json" ? " ? JSON.stringify(data." + f.name + ") : null" : f.type === "boolean" ? " ? 1 : 0" : ""}`).join(", ")});

  const item = getDb().prepare("SELECT * FROM ${Es} WHERE id = ?").get(id);
  res.status(201).json(item);
});

// PUT /${Es}/:id — update
${E}Router.put("/:id", (req, res) => {
  const parsed = update${cap(E)}Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = getDb().prepare("SELECT * FROM ${Es} WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "${cap(E)} not found" });

  const data = parsed.data;
  const sets = Object.keys(data).map(k => \`\${k} = ?\`).join(", ");
  const values = Object.values(data);
  getDb().prepare(\`UPDATE ${Es} SET \${sets} WHERE id = ?\`).run(...values, req.params.id);

  const item = getDb().prepare("SELECT * FROM ${Es} WHERE id = ?").get(req.params.id);
  res.json(item);
});

// DELETE /${Es}/:id — delete
${E}Router.delete("/:id", (req, res) => {
  const result = getDb().prepare("DELETE FROM ${Es} WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "${cap(E)} not found" });
  res.status(204).send();
});
`,
      needsLlm: true, // LLM adds business logic (validation rules, relationships)
    });

    // Test
    files.push({
      path: `src/routes/${E}.test.ts`,
      content: `import { describe, test, expect, beforeAll } from "vitest";
import express from "express";
import { ${E}Router } from "./${E}";
import { initDb } from "../db";

const app = express();
app.use(express.json());
app.use("/api/${Es}", ${E}Router);

beforeAll(() => { initDb(); });

describe("${cap(E)} API", () => {
  let createdId: string;

  test("POST /api/${Es} creates a ${E}", async () => {
    const res = await fetch("http://localhost:0/api/${Es}", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ${fields.filter(f => f.required).map(f => `${f.name}: ${testValue(f.type)}`).join(",\n        ")}
      }),
    });
    // Test structure — actual HTTP tests need supertest
  });

  test("GET /api/${Es} returns list", async () => {
    // TODO: implement with supertest
  });

  test("DELETE /api/${Es}/:id removes item", async () => {
    // TODO: implement with supertest
  });
});
`,
      needsLlm: true,
    });
  }

  // .gitignore
  files.push({ path: ".gitignore", content: "node_modules/\ndist/\ndata.db\n.env\n", needsLlm: false });
  files.push({ path: ".env", content: "PORT=3001\nDATABASE_URL=data.db\n", needsLlm: false });
  files.push({ path: "README.md", content: `# ${name} API\n\nGenerated by KCode.\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n## Endpoints\n\n${entities.map(e => `- \`/api/${e.name}s\` — CRUD for ${e.name}s`).join("\n")}\n`, needsLlm: false });

  return files;
}

// Helpers
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function zodType(t: string): string {
  switch (t) { case "number": return "number"; case "integer": return "number().int"; case "boolean": return "boolean"; case "json": return "any"; default: return "string"; }
}
function sqlType(t: string): string {
  switch (t) { case "number": return "REAL"; case "integer": return "INTEGER"; case "boolean": return "INTEGER"; case "datetime": return "TEXT DEFAULT (datetime('now'))"; case "json": return "TEXT"; default: return "TEXT"; }
}
function testValue(t: string): string {
  switch (t) { case "number": return "9.99"; case "integer": return "10"; case "boolean": return "true"; case "json": return "[]"; default: return '"test"'; }
}

// ── Main API Creator ───────────────────────────────────────────

export function createApiProject(userRequest: string, cwd: string): ApiProject {
  const entities = parseEntities(userRequest);
  const framework = detectApiFramework(userRequest);
  const nameMatch = userRequest.match(/(?:called|named|nombre)\s+(\w+)/i);
  const name = nameMatch?.[1] ?? (entities[0]?.name ? entities[0].name + "-api" : "my-api");

  let files: Array<{ path: string; content: string; needsLlm: boolean }>;

  if (framework === "express") {
    files = generateExpressApi(entities, name);
  } else {
    // Default to Express for now — FastAPI, Hono, Fastify templates coming
    files = generateExpressApi(entities, name);
  }

  // Write files
  const projectPath = join(cwd, name);
  for (const file of files) {
    const fullPath = join(projectPath, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }

  return { framework, entities, files, projectPath };
}
