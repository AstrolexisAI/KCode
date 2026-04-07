// KCode - Database Project Engine
// Creates: schemas, migrations, ORM configs, seeds, Docker, backup scripts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DbProjectType = "postgres" | "mysql" | "sqlite" | "mongo" | "redis" | "supabase" | "mssql" | "custom";
export type OrmType = "prisma" | "drizzle" | "typeorm" | "knex" | "mongoose" | "raw" | "none";

interface Entity {
  name: string;
  table: string;
  fields: Array<{ name: string; type: string; nullable?: boolean; unique?: boolean; default?: string; ref?: string }>;
}

interface DbConfig {
  name: string;
  type: DbProjectType;
  orm: OrmType;
  entities: Entity[];
  port: number;
  hasSeed: boolean;
  hasDocker: boolean;
  hasBackup: boolean;
  hasMigrations: boolean;
}

// ── Entity detection ──────────────────────────────────────────

const DEFAULT_FIELDS: Record<string, Array<{ name: string; type: string; nullable?: boolean; unique?: boolean; default?: string; ref?: string }>> = {
  user: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "email", type: "varchar(255)", unique: true },
    { name: "name", type: "varchar(255)" },
    { name: "password_hash", type: "varchar(255)" },
    { name: "avatar_url", type: "text", nullable: true },
    { name: "role", type: "varchar(50)", default: "'user'" },
    { name: "email_verified", type: "boolean", default: "false" },
    { name: "created_at", type: "timestamptz", default: "now()" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ],
  post: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "title", type: "varchar(255)" },
    { name: "slug", type: "varchar(255)", unique: true },
    { name: "content", type: "text" },
    { name: "excerpt", type: "text", nullable: true },
    { name: "published", type: "boolean", default: "false" },
    { name: "author_id", type: "uuid", ref: "users(id)" },
    { name: "created_at", type: "timestamptz", default: "now()" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ],
  product: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "name", type: "varchar(255)" },
    { name: "slug", type: "varchar(255)", unique: true },
    { name: "description", type: "text", nullable: true },
    { name: "price", type: "decimal(10,2)" },
    { name: "stock", type: "integer", default: "0" },
    { name: "image_url", type: "text", nullable: true },
    { name: "category", type: "varchar(100)", nullable: true },
    { name: "active", type: "boolean", default: "true" },
    { name: "created_at", type: "timestamptz", default: "now()" },
  ],
  order: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "user_id", type: "uuid", ref: "users(id)" },
    { name: "status", type: "varchar(50)", default: "'pending'" },
    { name: "total", type: "decimal(10,2)" },
    { name: "shipping_address", type: "text", nullable: true },
    { name: "notes", type: "text", nullable: true },
    { name: "created_at", type: "timestamptz", default: "now()" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ],
  comment: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "content", type: "text" },
    { name: "author_id", type: "uuid", ref: "users(id)" },
    { name: "post_id", type: "uuid", ref: "posts(id)" },
    { name: "created_at", type: "timestamptz", default: "now()" },
  ],
  category: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "name", type: "varchar(255)", unique: true },
    { name: "slug", type: "varchar(255)", unique: true },
    { name: "description", type: "text", nullable: true },
    { name: "parent_id", type: "uuid", nullable: true, ref: "categories(id)" },
  ],
  tag: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "name", type: "varchar(100)", unique: true },
    { name: "slug", type: "varchar(100)", unique: true },
  ],
  task: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "title", type: "varchar(255)" },
    { name: "description", type: "text", nullable: true },
    { name: "status", type: "varchar(50)", default: "'todo'" },
    { name: "priority", type: "varchar(20)", default: "'medium'" },
    { name: "assignee_id", type: "uuid", nullable: true, ref: "users(id)" },
    { name: "due_date", type: "date", nullable: true },
    { name: "created_at", type: "timestamptz", default: "now()" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ],
  message: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "sender_id", type: "uuid", ref: "users(id)" },
    { name: "recipient_id", type: "uuid", ref: "users(id)" },
    { name: "content", type: "text" },
    { name: "read", type: "boolean", default: "false" },
    { name: "created_at", type: "timestamptz", default: "now()" },
  ],
  session: [
    { name: "id", type: "uuid", default: "gen_random_uuid()" },
    { name: "user_id", type: "uuid", ref: "users(id)" },
    { name: "token", type: "varchar(255)", unique: true },
    { name: "ip_address", type: "varchar(45)", nullable: true },
    { name: "user_agent", type: "text", nullable: true },
    { name: "expires_at", type: "timestamptz" },
    { name: "created_at", type: "timestamptz", default: "now()" },
  ],
};

const ENTITY_ALIASES: Record<string, string> = {
  users: "user", user: "user", usuario: "user", usuarios: "user", auth: "user", account: "user",
  posts: "post", post: "post", article: "post", blog: "post", entrada: "post",
  products: "product", product: "product", item: "product", producto: "product", productos: "product",
  orders: "order", order: "order", purchase: "order", pedido: "order", pedidos: "order",
  comments: "comment", comment: "comment", reply: "comment", comentario: "comment", comentarios: "comment",
  categories: "category", category: "category", categoria: "category", categorias: "category",
  tags: "tag", tag: "tag", label: "tag", etiqueta: "tag", etiquetas: "tag",
  tasks: "task", task: "task", todo: "task", tarea: "task", tareas: "task", ticket: "task",
  messages: "message", message: "message", chat: "message", mensaje: "message", mensajes: "message",
  sessions: "session", session: "session", sesion: "session", sesiones: "session",
};

function parseEntities(msg: string): Entity[] {
  const words = msg.toLowerCase().split(/[\s,;+&]+/);
  const seen = new Set<string>();
  const entities: Entity[] = [];

  for (const w of words) {
    const key = ENTITY_ALIASES[w];
    if (key && !seen.has(key) && DEFAULT_FIELDS[key]) {
      seen.add(key);
      entities.push({ name: key, table: key + "s", fields: DEFAULT_FIELDS[key]! });
    }
  }

  if (entities.length === 0) {
    entities.push({ name: "user", table: "users", fields: DEFAULT_FIELDS["user"]! });
  }
  return entities;
}

function detectDbProject(msg: string): DbConfig {
  const lower = msg.toLowerCase();
  let type: DbProjectType = "postgres";
  let orm: OrmType = "prisma";
  let port = 5432;

  // DB type
  if (/\b(?:mssql|sql\s*server|sqlserver|microsoft\s*sql)\b/i.test(lower)) { type = "mssql"; port = 1433; }
  else if (/\b(?:mysql|mariadb)\b/i.test(lower)) { type = "mysql"; port = 3306; }
  else if (/\b(?:sqlite|lite)\b/i.test(lower)) { type = "sqlite"; port = 0; }
  else if (/\b(?:mongo|mongodb|nosql)\b/i.test(lower)) { type = "mongo"; port = 27017; orm = "mongoose"; }
  else if (/\b(?:redis)\b/i.test(lower)) { type = "redis"; port = 6379; orm = "none"; }
  else if (/\b(?:supabase)\b/i.test(lower)) { type = "supabase"; port = 5432; orm = "raw"; }

  // ORM
  if (/\b(?:prisma)\b/i.test(lower)) orm = "prisma";
  else if (/\b(?:drizzle)\b/i.test(lower)) orm = "drizzle";
  else if (/\b(?:typeorm)\b/i.test(lower)) orm = "typeorm";
  else if (/\b(?:knex|migration)\b/i.test(lower) && type !== "mongo") orm = "knex";
  else if (/\b(?:mongoose)\b/i.test(lower)) orm = "mongoose";
  else if (/\b(?:raw|sql|plain)\b/i.test(lower)) orm = "raw";

  const entities = parseEntities(msg);
  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "mydb";

  return {
    name, type, orm, entities, port,
    hasSeed: !/\bno.?seed\b/i.test(lower),
    hasDocker: type !== "sqlite" && !/\bno.?docker\b/i.test(lower),
    hasBackup: /\b(?:backup|dump|restore)\b/i.test(lower) || true,
    hasMigrations: orm !== "none",
  };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface DbProjectResult { config: DbConfig; files: GenFile[]; projectPath: string; prompt: string; }

// ── SQL Generation ────────────────────────────────────────────

function genCreateSQL(entities: Entity[], type: DbProjectType): string {
  const lines: string[] = ["-- Auto-generated schema", `-- Database: ${type}`, `-- Generated by KCode\n`];

  if (type === "postgres") lines.push("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";\n");

  const ifNotExists = type !== "mssql" ? "IF NOT EXISTS " : "";
  const mapDefault = (d: string): string => {
    if (type === "mssql") {
      if (d === "gen_random_uuid()") return "NEWID()";
      if (d === "now()") return "GETDATE()";
      if (d === "false") return "0";
      if (d === "true") return "1";
    }
    return d;
  };

  for (const e of entities) {
    if (type === "mssql") {
      lines.push(`IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${e.table}')`);
      lines.push(`CREATE TABLE ${e.table} (`);
    } else {
      lines.push(`CREATE TABLE ${ifNotExists}${e.table} (`);
    }
    const cols: string[] = [];
    for (const f of e.fields) {
      let col = `  ${f.name} ${mapType(f.type, type)}`;
      if (f.default) col += ` DEFAULT ${mapDefault(f.default)}`;
      if (f.unique) col += " UNIQUE";
      if (!f.nullable && f.name !== "id") col += " NOT NULL";
      if (f.name === "id") col += " PRIMARY KEY";
      cols.push(col);
    }
    // Foreign keys
    for (const f of e.fields) {
      if (f.ref) cols.push(`  FOREIGN KEY (${f.name}) REFERENCES ${f.ref} ON DELETE CASCADE`);
    }
    lines.push(cols.join(",\n"));
    lines.push(");\n");

    // Indexes
    const idxPrefix = type === "mssql" ? "CREATE INDEX" : `CREATE INDEX ${ifNotExists}`;
    for (const f of e.fields) {
      if (f.ref) lines.push(`${idxPrefix} idx_${e.table}_${f.name} ON ${e.table}(${f.name});`);
      if (f.name === "slug" || f.name === "email") lines.push(`${idxPrefix} idx_${e.table}_${f.name} ON ${e.table}(${f.name});`);
    }
    if (e.fields.find(f => f.name === "created_at")) lines.push(`${idxPrefix} idx_${e.table}_created_at ON ${e.table}(created_at DESC);`);
    lines.push("");
  }

  // Updated_at trigger for Postgres
  if (type === "postgres") {
    lines.push(`-- Auto-update updated_at`);
    lines.push(`CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$`);
    lines.push(`BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;\n`);
    for (const e of entities) {
      if (e.fields.find(f => f.name === "updated_at")) {
        lines.push(`CREATE TRIGGER trg_${e.table}_updated_at BEFORE UPDATE ON ${e.table} FOR EACH ROW EXECUTE FUNCTION update_updated_at();`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

function mapType(t: string, db: DbProjectType): string {
  if (db === "mssql") {
    if (t === "uuid") return "UNIQUEIDENTIFIER";
    if (t === "timestamptz") return "DATETIME2";
    if (t === "text") return "NVARCHAR(MAX)";
    if (t.startsWith("varchar")) return "N" + t.toUpperCase();
    if (t === "boolean") return "BIT";
    if (t === "serial") return "INT IDENTITY(1,1)";
    return t.toUpperCase();
  }
  if (db === "mysql") {
    if (t === "uuid") return "CHAR(36)";
    if (t === "timestamptz") return "TIMESTAMP";
    if (t === "text") return "TEXT";
    if (t.startsWith("varchar")) return t.toUpperCase();
    if (t === "boolean") return "TINYINT(1)";
    return t.toUpperCase();
  }
  if (db === "sqlite") {
    if (t === "uuid") return "TEXT";
    if (t.startsWith("varchar")) return "TEXT";
    if (t === "timestamptz") return "TEXT";
    if (t.startsWith("decimal")) return "REAL";
    if (t === "boolean") return "INTEGER";
    return t.toUpperCase();
  }
  return t;
}

function genSeedSQL(entities: Entity[]): string {
  const lines: string[] = ["-- Seed data\n"];

  for (const e of entities) {
    if (e.name === "user") {
      lines.push(`INSERT INTO users (email, name, password_hash, role) VALUES`);
      lines.push(`  ('admin@example.com', 'Admin', '$2b$10$placeholder', 'admin'),`);
      lines.push(`  ('user@example.com', 'User', '$2b$10$placeholder', 'user');`);
    } else if (e.name === "product") {
      lines.push(`INSERT INTO products (name, slug, description, price, stock) VALUES`);
      lines.push(`  ('Product One', 'product-one', 'First product', 29.99, 100),`);
      lines.push(`  ('Product Two', 'product-two', 'Second product', 49.99, 50);`);
    } else if (e.name === "post") {
      lines.push(`INSERT INTO posts (title, slug, content, published, author_id) VALUES`);
      lines.push(`  ('Hello World', 'hello-world', 'First post content.', true, (SELECT id FROM users LIMIT 1));`);
    } else if (e.name === "category") {
      lines.push(`INSERT INTO categories (name, slug) VALUES ('General', 'general'), ('Tech', 'tech');`);
    } else if (e.name === "tag") {
      lines.push(`INSERT INTO tags (name, slug) VALUES ('javascript', 'javascript'), ('typescript', 'typescript');`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function genPrismaSchema(entities: Entity[], type: DbProjectType): string {
  const provider = type === "postgres" ? "postgresql" : type === "mysql" ? "mysql" : type === "mssql" ? "sqlserver" : "sqlite";
  const url = type === "sqlite" ? '"file:./dev.db"' : 'env("DATABASE_URL")';
  const lines: string[] = [];

  lines.push(`generator client {\n  provider = "prisma-client-js"\n}\n`);
  lines.push(`datasource db {\n  provider = "${provider}"\n  url      = ${url}\n}\n`);

  for (const e of entities) {
    const modelName = e.name.charAt(0).toUpperCase() + e.name.slice(1);
    lines.push(`model ${modelName} {`);
    for (const f of e.fields) {
      const pt = prismaType(f.type);
      let line = `  ${f.name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())} ${pt}`;
      if (f.name === "id") line += " @id @default(uuid())";
      else {
        if (f.unique) line += " @unique";
        if (f.nullable) line += "?";
        if (f.default === "now()") line += " @default(now())";
        else if (f.default === "false") line += " @default(false)";
        else if (f.default === "true") line += " @default(true)";
        else if (f.default === "0") line += " @default(0)";
        else if (f.default?.startsWith("'")) line += ` @default("${f.default.replace(/'/g, "")}")`;
      }
      if (f.name !== f.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())) {
        line += ` @map("${f.name}")`;
      }
      lines.push(line);
    }
    lines.push(`\n  @@map("${e.table}")`);
    lines.push(`}\n`);
  }

  return lines.join("\n");
}

function prismaType(t: string): string {
  if (t === "uuid") return "String";
  if (t.startsWith("varchar")) return "String";
  if (t === "text") return "String";
  if (t === "integer" || t === "int") return "Int";
  if (t.startsWith("decimal")) return "Decimal";
  if (t === "boolean") return "Boolean";
  if (t === "timestamptz" || t === "timestamp") return "DateTime";
  if (t === "date") return "DateTime";
  if (t === "jsonb" || t === "json") return "Json";
  return "String";
}

function genDrizzleSchema(entities: Entity[]): string {
  const lines: string[] = [
    `import { pgTable, uuid, varchar, text, boolean, timestamp, decimal, integer, date } from "drizzle-orm/pg-core";\n`,
  ];

  for (const e of entities) {
    lines.push(`export const ${e.table} = pgTable("${e.table}", {`);
    for (const f of e.fields) {
      let col = `  ${camel(f.name)}: `;
      if (f.type === "uuid") col += `uuid("${f.name}")`;
      else if (f.type.startsWith("varchar")) col += `varchar("${f.name}", { length: ${f.type.match(/\d+/)?.[0] ?? 255} })`;
      else if (f.type === "text") col += `text("${f.name}")`;
      else if (f.type === "boolean") col += `boolean("${f.name}")`;
      else if (f.type === "timestamptz") col += `timestamp("${f.name}", { withTimezone: true })`;
      else if (f.type === "date") col += `date("${f.name}")`;
      else if (f.type.startsWith("decimal")) col += `decimal("${f.name}", { precision: 10, scale: 2 })`;
      else if (f.type === "integer") col += `integer("${f.name}")`;
      else col += `text("${f.name}")`;

      if (f.name === "id") col += ".primaryKey().defaultRandom()";
      else {
        if (!f.nullable) col += ".notNull()";
        if (f.unique) col += ".unique()";
        if (f.default === "now()") col += ".defaultNow()";
        else if (f.default === "false") col += ".default(false)";
        else if (f.default === "true") col += ".default(true)";
        else if (f.default === "0") col += ".default(0)";
        else if (f.default?.startsWith("'")) col += `.default("${f.default.replace(/'/g, "")}")`;
      }
      col += ",";
      lines.push(col);
    }
    lines.push(`});\n`);
  }

  return lines.join("\n");
}

function genMongooseSchemas(entities: Entity[]): string {
  const lines: string[] = [`import mongoose from "mongoose";\n`];

  for (const e of entities) {
    const modelName = e.name.charAt(0).toUpperCase() + e.name.slice(1);
    lines.push(`const ${e.name}Schema = new mongoose.Schema({`);
    for (const f of e.fields) {
      if (f.name === "id") continue;
      let field = `  ${camel(f.name)}: { type: ${mongoType(f.type)}`;
      if (!f.nullable && f.name !== "created_at" && f.name !== "updated_at") field += ", required: true";
      if (f.unique) field += ", unique: true";
      if (f.default === "now()") {} // handled by timestamps
      else if (f.default === "false") field += ", default: false";
      else if (f.default === "true") field += ", default: true";
      else if (f.default === "0") field += ", default: 0";
      else if (f.default?.startsWith("'")) field += `, default: "${f.default.replace(/'/g, "")}"`;
      if (f.ref) field += `, ref: "${f.ref.split("(")[0]!.charAt(0).toUpperCase() + f.ref.split("(")[0]!.slice(1, -1)}"`;
      field += " },";
      lines.push(field);
    }
    lines.push(`}, { timestamps: true });\n`);
    lines.push(`export const ${modelName} = mongoose.model("${modelName}", ${e.name}Schema);\n`);
  }

  return lines.join("\n");
}

function mongoType(t: string): string {
  if (t === "uuid" || t.startsWith("varchar") || t === "text") return "String";
  if (t === "integer" || t === "int") return "Number";
  if (t.startsWith("decimal")) return "Number";
  if (t === "boolean") return "Boolean";
  if (t === "timestamptz" || t === "timestamp" || t === "date") return "Date";
  return "String";
}

function camel(s: string): string { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

// ── Main ──────────────────────────────────────────────────────

export function createDbProject(userRequest: string, cwd: string): DbProjectResult {
  const cfg = detectDbProject(userRequest);
  const files: GenFile[] = [];

  // ── Raw SQL ──
  files.push({ path: "sql/schema.sql", content: genCreateSQL(cfg.entities, cfg.type), needsLlm: false });
  if (cfg.hasSeed) {
    files.push({ path: "sql/seed.sql", content: genSeedSQL(cfg.entities), needsLlm: false });
  }

  // ── Migrations ──
  if (cfg.hasMigrations) {
    const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    files.push({ path: `migrations/${ts}_init.sql`, content: genCreateSQL(cfg.entities, cfg.type), needsLlm: false });
    files.push({ path: "migrations/README.md", content: `# Migrations\n\nApply: \`psql $DATABASE_URL < migrations/${ts}_init.sql\`\n`, needsLlm: false });
  }

  // ── ORM schemas ──
  if (cfg.orm === "prisma") {
    files.push({ path: "prisma/schema.prisma", content: genPrismaSchema(cfg.entities, cfg.type), needsLlm: false });
  } else if (cfg.orm === "drizzle") {
    files.push({ path: "src/db/schema.ts", content: genDrizzleSchema(cfg.entities), needsLlm: false });
    files.push({ path: "drizzle.config.ts", content: `import type { Config } from "drizzle-kit";\n\nexport default {\n  schema: "./src/db/schema.ts",\n  out: "./drizzle",\n  dialect: "${cfg.type === "mysql" ? "mysql" : cfg.type === "sqlite" ? "sqlite" : cfg.type === "mssql" ? "sqlite" : "postgresql"}",\n  dbCredentials: { url: process.env.DATABASE_URL! },\n} satisfies Config;\n`, needsLlm: false });
  } else if (cfg.orm === "mongoose") {
    files.push({ path: "src/models/index.ts", content: genMongooseSchemas(cfg.entities), needsLlm: false });
    files.push({ path: "src/db/connection.ts", content: `import mongoose from "mongoose";\n\nconst MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/${cfg.name}";\n\nexport async function connectDb() {\n  await mongoose.connect(MONGO_URI);\n  console.log("MongoDB connected");\n}\n`, needsLlm: false });
  } else if (cfg.orm === "typeorm") {
    for (const e of cfg.entities) {
      const modelName = e.name.charAt(0).toUpperCase() + e.name.slice(1);
      files.push({ path: `src/entities/${modelName}.ts`, content: `import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";\n\n@Entity("${e.table}")\nexport class ${modelName} {\n${e.fields.map(f => {
        if (f.name === "id") return `  @PrimaryGeneratedColumn("uuid")\n  id!: string;`;
        if (f.name === "created_at") return `  @CreateDateColumn()\n  createdAt!: Date;`;
        if (f.name === "updated_at") return `  @UpdateDateColumn()\n  updatedAt!: Date;`;
        const tsType = f.type.startsWith("varchar") || f.type === "text" || f.type === "uuid" ? "string" : f.type === "boolean" ? "boolean" : f.type === "integer" ? "number" : f.type.startsWith("decimal") ? "number" : "string";
        return `  @Column({ ${f.nullable ? "nullable: true, " : ""}${f.unique ? "unique: true, " : ""}${f.default ? `default: ${f.default}, ` : ""}})\n  ${camel(f.name)}${f.nullable ? "?" : "!"}: ${tsType};`;
      }).join("\n\n")}\n}\n`, needsLlm: false });
    }
  } else if (cfg.orm === "knex") {
    files.push({ path: "knexfile.ts", content: `import type { Knex } from "knex";\n\nconst config: Knex.Config = {\n  client: "${cfg.type === "postgres" ? "pg" : cfg.type === "mysql" ? "mysql2" : "better-sqlite3"}",\n  connection: process.env.DATABASE_URL || "${cfg.type === "sqlite" ? "./dev.db" : `${cfg.type}://app:changeme@localhost:${cfg.port}/${cfg.name}`}",\n  migrations: { directory: "./migrations" },\n  seeds: { directory: "./seeds" },\n};\n\nexport default config;\n`, needsLlm: false });
  }

  // ── Connection helper ──
  if (cfg.orm !== "mongoose" && cfg.orm !== "none") {
    const connUrl = cfg.type === "sqlite" ? `./dev.db` : `${cfg.type === "postgres" ? "postgresql" : cfg.type}://app:changeme@localhost:${cfg.port}/${cfg.name}`;
    files.push({ path: "src/db/index.ts", content: cfg.orm === "prisma"
      ? `import { PrismaClient } from "@prisma/client";\n\nexport const db = new PrismaClient();\n\nexport async function connectDb() {\n  await db.$connect();\n  console.log("Database connected (Prisma)");\n}\n`
      : cfg.orm === "drizzle"
      ? `import { drizzle } from "drizzle-orm/node-postgres";\nimport { Pool } from "pg";\nimport * as schema from "./schema.js";\n\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL || "${connUrl}" });\nexport const db = drizzle(pool, { schema });\n`
      : `// Database connection\nconst DATABASE_URL = process.env.DATABASE_URL || "${connUrl}";\nconsole.log("Connecting to:", DATABASE_URL.replace(/:([^@]+)@/, ":***@"));\n// TODO: initialize connection\n`,
    needsLlm: false });
  }

  // ── Docker ──
  if (cfg.hasDocker) {
    const composeServices: string[] = [];
    if (cfg.type === "postgres") {
      composeServices.push(`  postgres:\n    image: postgres:17-alpine\n    ports:\n      - "5432:5432"\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: changeme\n      POSTGRES_DB: ${cfg.name}\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n      - ./sql/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql\n${cfg.hasSeed ? `      - ./sql/seed.sql:/docker-entrypoint-initdb.d/02-seed.sql` : ""}\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U app"]\n      interval: 5s\n      timeout: 5s\n      retries: 5\n    restart: unless-stopped`);
    } else if (cfg.type === "mysql") {
      composeServices.push(`  mysql:\n    image: mysql:8.4\n    ports:\n      - "3306:3306"\n    environment:\n      MYSQL_ROOT_PASSWORD: changeme\n      MYSQL_DATABASE: ${cfg.name}\n      MYSQL_USER: app\n      MYSQL_PASSWORD: changeme\n    volumes:\n      - mysqldata:/var/lib/mysql\n      - ./sql/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql\n    healthcheck:\n      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]\n      interval: 5s\n      timeout: 5s\n      retries: 5\n    restart: unless-stopped`);
    } else if (cfg.type === "mongo") {
      composeServices.push(`  mongo:\n    image: mongo:7\n    ports:\n      - "27017:27017"\n    environment:\n      MONGO_INITDB_ROOT_USERNAME: app\n      MONGO_INITDB_ROOT_PASSWORD: changeme\n      MONGO_INITDB_DATABASE: ${cfg.name}\n    volumes:\n      - mongodata:/data/db\n    restart: unless-stopped`);
    } else if (cfg.type === "mssql") {
      composeServices.push(`  mssql:\n    image: mcr.microsoft.com/mssql/server:2022-latest\n    ports:\n      - "1433:1433"\n    environment:\n      ACCEPT_EULA: "Y"\n      MSSQL_SA_PASSWORD: "Changeme1!"\n      MSSQL_PID: Developer\n    volumes:\n      - mssqldata:/var/opt/mssql\n    healthcheck:\n      test: ["CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P Changeme1! -Q 'SELECT 1' -C -N"]\n      interval: 10s\n      timeout: 5s\n      retries: 5\n    restart: unless-stopped`);
    } else if (cfg.type === "redis") {
      composeServices.push(`  redis:\n    image: redis:7-alpine\n    ports:\n      - "6379:6379"\n    command: redis-server --appendonly yes --requirepass changeme\n    volumes:\n      - redisdata:/data\n    healthcheck:\n      test: ["CMD", "redis-cli", "-a", "changeme", "ping"]\n      interval: 5s\n      timeout: 5s\n      retries: 5\n    restart: unless-stopped`);
    }

    // Admin UI
    if (cfg.type === "postgres") {
      composeServices.push(`\n  pgadmin:\n    image: dpage/pgadmin4:latest\n    ports:\n      - "10081:80"\n    environment:\n      PGADMIN_DEFAULT_EMAIL: admin@admin.com\n      PGADMIN_DEFAULT_PASSWORD: admin\n    depends_on:\n      - postgres\n    restart: unless-stopped`);
    } else if (cfg.type === "mongo") {
      composeServices.push(`\n  mongo-express:\n    image: mongo-express:latest\n    ports:\n      - "10081:8081"\n    environment:\n      ME_CONFIG_MONGODB_ADMINUSERNAME: app\n      ME_CONFIG_MONGODB_ADMINPASSWORD: changeme\n      ME_CONFIG_MONGODB_URL: mongodb://app:changeme@mongo:27017/\n    depends_on:\n      - mongo\n    restart: unless-stopped`);
    }

    const volumes = cfg.type === "postgres" ? "pgdata" : cfg.type === "mysql" ? "mysqldata" : cfg.type === "mongo" ? "mongodata" : cfg.type === "mssql" ? "mssqldata" : "redisdata";
    files.push({ path: "docker-compose.yml", content: `services:\n${composeServices.join("\n\n")}\n\nvolumes:\n  ${volumes}:\n`, needsLlm: false });
  }

  // ── Backup script ──
  if (cfg.hasBackup && cfg.type !== "redis") {
    const backupCmd = cfg.type === "postgres"
      ? `#!/bin/bash\nset -euo pipefail\nDATE=$(date +%Y%m%d_%H%M%S)\nBACKUP_DIR="./backups"\nmkdir -p "$BACKUP_DIR"\n\necho "Backing up ${cfg.name}..."\npg_dump "\${DATABASE_URL:-postgresql://app:changeme@localhost:5432/${cfg.name}}" | gzip > "$BACKUP_DIR/${cfg.name}_$DATE.sql.gz"\n\n# Keep last 7 days\nfind "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete\n\necho "Backup complete: $BACKUP_DIR/${cfg.name}_$DATE.sql.gz"`
      : cfg.type === "mysql"
      ? `#!/bin/bash\nset -euo pipefail\nDATE=$(date +%Y%m%d_%H%M%S)\nBACKUP_DIR="./backups"\nmkdir -p "$BACKUP_DIR"\n\necho "Backing up ${cfg.name}..."\nmysqldump -h localhost -u app -pchangeme ${cfg.name} | gzip > "$BACKUP_DIR/${cfg.name}_$DATE.sql.gz"\nfind "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete\necho "Backup complete"`
      : cfg.type === "mongo"
      ? `#!/bin/bash\nset -euo pipefail\nDATE=$(date +%Y%m%d_%H%M%S)\nBACKUP_DIR="./backups"\nmkdir -p "$BACKUP_DIR"\n\necho "Backing up ${cfg.name}..."\nmongodump --uri="\${MONGO_URI:-mongodb://app:changeme@localhost:27017/${cfg.name}}" --archive="$BACKUP_DIR/${cfg.name}_$DATE.gz" --gzip\nfind "$BACKUP_DIR" -name "*.gz" -mtime +7 -delete\necho "Backup complete"`
      : cfg.type === "mssql"
      ? `#!/bin/bash\nset -euo pipefail\nDATE=$(date +%Y%m%d_%H%M%S)\nBACKUP_DIR="./backups"\nmkdir -p "$BACKUP_DIR"\n\necho "Backing up ${cfg.name}..."\n/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "\${MSSQL_SA_PASSWORD:-Changeme1!}" -Q "BACKUP DATABASE [${cfg.name}] TO DISK='/var/opt/mssql/backup/${cfg.name}_$DATE.bak'" -C -N\nfind "$BACKUP_DIR" -name "*.bak" -mtime +7 -delete\necho "Backup complete"`
      : `#!/bin/bash\ncp ./dev.db "./backups/${cfg.name}_$(date +%Y%m%d_%H%M%S).db"`;

    files.push({ path: "scripts/backup.sh", content: backupCmd + "\n", needsLlm: false });

    // Restore script
    if (cfg.type === "postgres") {
      files.push({ path: "scripts/restore.sh", content: `#!/bin/bash\nset -euo pipefail\nif [ -z "\${1:-}" ]; then echo "Usage: ./scripts/restore.sh <backup.sql.gz>"; exit 1; fi\necho "Restoring from $1..."\ngunzip -c "$1" | psql "\${DATABASE_URL:-postgresql://app:changeme@localhost:5432/${cfg.name}}"\necho "Restore complete"\n`, needsLlm: false });
    }
  }

  // ── Package.json ──
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = { typescript: "*", "@types/node": "*", tsx: "*" };

  if (cfg.orm === "prisma") { deps["@prisma/client"] = "*"; devDeps["prisma"] = "*"; }
  if (cfg.orm === "drizzle") { deps["drizzle-orm"] = "*"; devDeps["drizzle-kit"] = "*"; deps["pg"] = "*"; devDeps["@types/pg"] = "*"; }
  if (cfg.orm === "typeorm") { deps["typeorm"] = "*"; deps["reflect-metadata"] = "*"; if (cfg.type === "postgres") deps["pg"] = "*"; }
  if (cfg.orm === "knex") { deps["knex"] = "*"; if (cfg.type === "postgres") deps["pg"] = "*"; if (cfg.type === "mysql") deps["mysql2"] = "*"; if (cfg.type === "sqlite") deps["better-sqlite3"] = "*"; }
  if (cfg.orm === "mongoose") { deps["mongoose"] = "*"; }
  if (cfg.type === "mssql") { deps["mssql"] = "*"; deps["tedious"] = "*"; }
  if (cfg.type === "redis") { deps["ioredis"] = "*"; }

  files.push({ path: "package.json", content: JSON.stringify({
    name: cfg.name, version: "0.1.0", type: "module",
    scripts: {
      ...(cfg.orm === "prisma" ? { "db:generate": "prisma generate", "db:push": "prisma db push", "db:migrate": "prisma migrate dev", "db:studio": "prisma studio", "db:seed": "tsx src/seed.ts" } : {}),
      ...(cfg.orm === "drizzle" ? { "db:generate": "drizzle-kit generate", "db:push": "drizzle-kit push", "db:migrate": "drizzle-kit migrate", "db:studio": "drizzle-kit studio" } : {}),
      ...(cfg.hasDocker ? { "docker:up": "docker compose up -d", "docker:down": "docker compose down", "docker:logs": "docker compose logs -f" } : {}),
      ...(cfg.hasBackup ? { "db:backup": "bash scripts/backup.sh" } : {}),
      "db:init": cfg.type === "sqlite" ? "sqlite3 dev.db < sql/schema.sql" : `psql $DATABASE_URL < sql/schema.sql`,
      "db:seed": cfg.hasSeed ? (cfg.type === "sqlite" ? "sqlite3 dev.db < sql/seed.sql" : `psql $DATABASE_URL < sql/seed.sql`) : "echo 'no seed'",
    },
    dependencies: deps,
    devDependencies: devDeps,
  }, null, 2), needsLlm: false });

  // ── .env ──
  const envLines: string[] = [];
  if (cfg.type === "postgres") envLines.push(`DATABASE_URL=postgresql://app:changeme@localhost:5432/${cfg.name}`);
  else if (cfg.type === "mysql") envLines.push(`DATABASE_URL=mysql://app:changeme@localhost:3306/${cfg.name}`);
  else if (cfg.type === "sqlite") envLines.push(`DATABASE_URL=file:./dev.db`);
  else if (cfg.type === "mssql") envLines.push(`DATABASE_URL=mssql://sa:Changeme1!@localhost:1433/${cfg.name}`);
  else if (cfg.type === "mongo") envLines.push(`MONGO_URI=mongodb://app:changeme@localhost:27017/${cfg.name}`);
  else if (cfg.type === "redis") envLines.push(`REDIS_URL=redis://:changeme@localhost:6379`);

  files.push({ path: ".env", content: envLines.join("\n") + "\n", needsLlm: false });
  files.push({ path: ".env.example", content: envLines.map(l => l.replace("changeme", "YOUR_PASSWORD")).join("\n") + "\n", needsLlm: false });

  // ── Extras ──
  files.push({ path: ".gitignore", content: "node_modules/\n.env\ndev.db\nbackups/\ndist/\n", needsLlm: false });
  files.push({ path: "Makefile", content: `up:\n\tdocker compose up -d\n\ndown:\n\tdocker compose down\n\ninit:\n\tnpm run db:init\n\nseed:\n\tnpm run db:seed\n\nbackup:\n\tbash scripts/backup.sh\n\nreset:\n\tdocker compose down -v && docker compose up -d\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\n${cfg.type.charAt(0).toUpperCase() + cfg.type.slice(1)} database with ${cfg.orm} ORM. Built with KCode.\n\n## Entities\n${cfg.entities.map(e => `- **${e.name}** (${e.fields.length} fields)`).join("\n")}\n\n## Quick Start\n\`\`\`bash\n${cfg.hasDocker ? "docker compose up -d  # Start DB\n" : ""}npm install\nnpm run db:init        # Create tables\nnpm run db:seed        # Insert sample data\n${cfg.orm === "prisma" ? "npx prisma studio     # Browse data\n" : ""}\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `${cfg.type} database with ${cfg.orm}. Entities: ${cfg.entities.map(e => e.name).join(", ")}. ${m} files machine. USER: "${userRequest}"` };
}
