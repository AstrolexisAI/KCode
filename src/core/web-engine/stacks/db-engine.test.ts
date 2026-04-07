import { describe, test, expect } from "bun:test";
import { createDbProject } from "./db-engine";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("db-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-db-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Postgres project with Prisma by default", () => {
    withTmp((dir) => {
      const r = createDbProject("database with users and products called mydb", dir);
      expect(r.config.type).toBe("postgres");
      expect(r.config.orm).toBe("prisma");
      expect(r.config.name).toBe("mydb");
      expect(r.config.entities.length).toBe(2);
      expect(existsSync(join(dir, "mydb", "sql/schema.sql"))).toBe(true);
      expect(existsSync(join(dir, "mydb", "prisma/schema.prisma"))).toBe(true);
      expect(existsSync(join(dir, "mydb", "docker-compose.yml"))).toBe(true);
    });
  });

  test("SQL schema has proper tables and indexes", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users, posts, comments", dir);
      const sql = readFileSync(join(r.projectPath, "sql/schema.sql"), "utf-8");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS users");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS posts");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS comments");
      expect(sql).toContain("FOREIGN KEY");
      expect(sql).toContain("CREATE INDEX");
      expect(sql).toContain("update_updated_at");
    });
  });

  test("creates seed data", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users and products", dir);
      expect(existsSync(join(r.projectPath, "sql/seed.sql"))).toBe(true);
      const seed = readFileSync(join(r.projectPath, "sql/seed.sql"), "utf-8");
      expect(seed).toContain("INSERT INTO users");
      expect(seed).toContain("INSERT INTO products");
    });
  });

  test("creates MySQL project", () => {
    withTmp((dir) => {
      const r = createDbProject("MySQL database with users", dir);
      expect(r.config.type).toBe("mysql");
      expect(r.config.port).toBe(3306);
      const sql = readFileSync(join(r.projectPath, "sql/schema.sql"), "utf-8");
      expect(sql).toContain("CHAR(36)"); // UUID mapped to CHAR for MySQL
    });
  });

  test("creates SQLite project", () => {
    withTmp((dir) => {
      const r = createDbProject("SQLite with tasks", dir);
      expect(r.config.type).toBe("sqlite");
      expect(r.config.hasDocker).toBe(false);
    });
  });

  test("creates MongoDB with Mongoose", () => {
    withTmp((dir) => {
      const r = createDbProject("MongoDB with users and posts", dir);
      expect(r.config.type).toBe("mongo");
      expect(r.config.orm).toBe("mongoose");
      expect(existsSync(join(r.projectPath, "src/models/index.ts"))).toBe(true);
      const models = readFileSync(join(r.projectPath, "src/models/index.ts"), "utf-8");
      expect(models).toContain("mongoose.Schema");
    });
  });

  test("creates Drizzle ORM schemas", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users using Drizzle", dir);
      expect(r.config.orm).toBe("drizzle");
      expect(existsSync(join(r.projectPath, "src/db/schema.ts"))).toBe(true);
      expect(existsSync(join(r.projectPath, "drizzle.config.ts"))).toBe(true);
      const schema = readFileSync(join(r.projectPath, "src/db/schema.ts"), "utf-8");
      expect(schema).toContain("pgTable");
    });
  });

  test("creates TypeORM entities", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users and orders using TypeORM", dir);
      expect(r.config.orm).toBe("typeorm");
      expect(existsSync(join(r.projectPath, "src/entities/User.ts"))).toBe(true);
      expect(existsSync(join(r.projectPath, "src/entities/Order.ts"))).toBe(true);
    });
  });

  test("creates Knex config", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users using Knex migrations", dir);
      expect(r.config.orm).toBe("knex");
      expect(existsSync(join(r.projectPath, "knexfile.ts"))).toBe(true);
    });
  });

  test("Docker compose has admin UI (pgAdmin)", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users", dir);
      const compose = readFileSync(join(r.projectPath, "docker-compose.yml"), "utf-8");
      expect(compose).toContain("pgadmin");
      expect(compose).toContain("healthcheck");
    });
  });

  test("Docker compose for MongoDB has mongo-express", () => {
    withTmp((dir) => {
      const r = createDbProject("MongoDB with users", dir);
      const compose = readFileSync(join(r.projectPath, "docker-compose.yml"), "utf-8");
      expect(compose).toContain("mongo-express");
    });
  });

  test("has backup and restore scripts", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users", dir);
      expect(existsSync(join(r.projectPath, "scripts/backup.sh"))).toBe(true);
      expect(existsSync(join(r.projectPath, "scripts/restore.sh"))).toBe(true);
      const backup = readFileSync(join(r.projectPath, "scripts/backup.sh"), "utf-8");
      expect(backup).toContain("pg_dump");
      expect(backup).toContain("mtime +7 -delete"); // retention
    });
  });

  test("has migrations directory", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users", dir);
      expect(r.files.some(f => f.path.startsWith("migrations/"))).toBe(true);
    });
  });

  test("detects 10 entity types", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users, posts, products, orders, comments, categories, tags, tasks, messages, sessions", dir);
      expect(r.config.entities.length).toBe(10);
    });
  });

  test("bilingual entity detection (Spanish)", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres con usuarios y productos", dir);
      expect(r.config.entities.some(e => e.name === "user")).toBe(true);
      expect(r.config.entities.some(e => e.name === "product")).toBe(true);
    });
  });

  test("has .env and .env.example", () => {
    withTmp((dir) => {
      const r = createDbProject("Postgres with users", dir);
      expect(existsSync(join(r.projectPath, ".env"))).toBe(true);
      expect(existsSync(join(r.projectPath, ".env.example"))).toBe(true);
      const env = readFileSync(join(r.projectPath, ".env"), "utf-8");
      expect(env).toContain("DATABASE_URL");
    });
  });

  test("creates SQL Server project", () => {
    withTmp((dir) => {
      const r = createDbProject("SQL Server database with users and orders", dir);
      expect(r.config.type).toBe("mssql");
      expect(r.config.port).toBe(1433);
      const sql = readFileSync(join(r.projectPath, "sql/schema.sql"), "utf-8");
      expect(sql).toContain("UNIQUEIDENTIFIER"); // UUID mapped to UNIQUEIDENTIFIER
      expect(sql).toContain("NVARCHAR");
      const compose = readFileSync(join(r.projectPath, "docker-compose.yml"), "utf-8");
      expect(compose).toContain("mssql/server");
      expect(compose).toContain("ACCEPT_EULA");
    });
  });

  test("Redis project has no ORM", () => {
    withTmp((dir) => {
      const r = createDbProject("Redis cache", dir);
      expect(r.config.type).toBe("redis");
      expect(r.config.orm).toBe("none");
    });
  });
});
