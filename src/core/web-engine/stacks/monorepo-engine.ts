// KCode - Monorepo Engine
// Creates: Turborepo/Nx workspaces with multiple packages

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MonorepoTool = "turborepo" | "nx";
export type PackageType = "app" | "api" | "web" | "shared" | "ui" | "config" | "types" | "docs";

interface MonorepoConfig {
  name: string;
  tool: MonorepoTool;
  packages: Array<{ name: string; type: PackageType }>;
  packageManager: "npm" | "pnpm" | "bun";
}

function detectMonorepoProject(msg: string): MonorepoConfig {
  const lower = msg.toLowerCase();
  let tool: MonorepoTool = "turborepo";
  let packageManager: "npm" | "pnpm" | "bun" = "pnpm";

  if (/\b(?:nx)\b/i.test(lower)) tool = "nx";
  if (/\b(?:bun)\b/i.test(lower)) packageManager = "bun";
  else if (/\b(?:npm)\b/i.test(lower)) packageManager = "npm";

  const packages: Array<{ name: string; type: PackageType }> = [];

  if (/\b(?:web|frontend|next|react|vue|svelte)\b/i.test(lower)) packages.push({ name: "web", type: "web" });
  if (/\b(?:api|backend|server|express|fastify)\b/i.test(lower)) packages.push({ name: "api", type: "api" });
  if (/\b(?:app|mobile|native)\b/i.test(lower)) packages.push({ name: "app", type: "app" });
  if (/\b(?:ui|components|design)\b/i.test(lower)) packages.push({ name: "ui", type: "ui" });
  if (/\b(?:docs|documentation)\b/i.test(lower)) packages.push({ name: "docs", type: "docs" });

  // Always add shared packages
  packages.push({ name: "shared", type: "shared" });
  packages.push({ name: "tsconfig", type: "config" });

  if (packages.length <= 2) {
    packages.unshift({ name: "web", type: "web" }, { name: "api", type: "api" });
  }

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "monorepo";

  return { name, tool, packages, packageManager };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface MonorepoProjectResult { config: MonorepoConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createMonorepoProject(userRequest: string, cwd: string): MonorepoProjectResult {
  const cfg = detectMonorepoProject(userRequest);
  const files: GenFile[] = [];
  const pkgPrefix = `@${cfg.name}`;

  // Root package.json
  const workspaceGlob = cfg.packageManager === "pnpm" ? undefined : ["packages/*", "apps/*"];
  files.push({ path: "package.json", content: JSON.stringify({
    name: cfg.name,
    private: true,
    ...(workspaceGlob ? { workspaces: workspaceGlob } : {}),
    scripts: {
      dev: cfg.tool === "turborepo" ? "turbo dev" : "nx run-many --target=dev",
      build: cfg.tool === "turborepo" ? "turbo build" : "nx run-many --target=build",
      test: cfg.tool === "turborepo" ? "turbo test" : "nx run-many --target=test",
      lint: cfg.tool === "turborepo" ? "turbo lint" : "nx run-many --target=lint",
      clean: cfg.tool === "turborepo" ? "turbo clean" : "nx run-many --target=clean",
      format: "prettier --write .",
    },
    devDependencies: {
      ...(cfg.tool === "turborepo" ? { turbo: "*" } : { nx: "*", "@nx/workspace": "*" }),
      typescript: "*",
      prettier: "*",
      "@types/node": "*",
    },
  }, null, 2), needsLlm: false });

  // pnpm workspace
  if (cfg.packageManager === "pnpm") {
    files.push({ path: "pnpm-workspace.yaml", content: `packages:\n  - "packages/*"\n  - "apps/*"\n`, needsLlm: false });
  }

  // Turbo config
  if (cfg.tool === "turborepo") {
    files.push({ path: "turbo.json", content: JSON.stringify({
      "$schema": "https://turbo.build/schema.json",
      tasks: {
        build: { dependsOn: ["^build"], outputs: ["dist/**", ".next/**"] },
        dev: { cache: false, persistent: true },
        test: { dependsOn: ["^build"] },
        lint: {},
        clean: { cache: false },
      },
    }, null, 2), needsLlm: false });
  }

  // tsconfig base
  files.push({ path: "packages/tsconfig/base.json", content: JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      strict: true, esModuleInterop: true, skipLibCheck: true,
      declaration: true, declarationMap: true, sourceMap: true,
      outDir: "dist", rootDir: "src",
    },
    exclude: ["node_modules", "dist"],
  }, null, 2), needsLlm: false });

  files.push({ path: "packages/tsconfig/package.json", content: JSON.stringify({
    name: `${pkgPrefix}/tsconfig`, version: "0.0.0", private: true,
    files: ["base.json"],
  }, null, 2), needsLlm: false });

  // Shared package
  files.push({ path: "packages/shared/package.json", content: JSON.stringify({
    name: `${pkgPrefix}/shared`, version: "0.1.0", type: "module",
    main: "dist/index.js", types: "dist/index.d.ts",
    scripts: { build: "tsc", dev: "tsc --watch", clean: "rm -rf dist" },
    devDependencies: { [`${pkgPrefix}/tsconfig`]: "workspace:*", typescript: "*" },
  }, null, 2), needsLlm: false });

  files.push({ path: "packages/shared/tsconfig.json", content: `{ "extends": "${pkgPrefix}/tsconfig/base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }\n`, needsLlm: false });
  files.push({ path: "packages/shared/src/index.ts", content: `export function formatDate(date: Date): string {\n  return date.toISOString().split("T")[0]!;\n}\n\nexport function slugify(text: string): string {\n  return text.toLowerCase().replace(/[^\\w]+/g, "-").replace(/^-|-$/g, "");\n}\n\nexport type Result<T, E = Error> = { ok: true; data: T } | { ok: false; error: E };\n\n// TODO: add shared utilities\n`, needsLlm: true });

  // App/API packages
  for (const pkg of cfg.packages) {
    if (pkg.type === "shared" || pkg.type === "config") continue;

    const dir = ["web", "app", "api", "docs"].includes(pkg.type) ? "apps" : "packages";

    files.push({ path: `${dir}/${pkg.name}/package.json`, content: JSON.stringify({
      name: `${pkgPrefix}/${pkg.name}`, version: "0.1.0", type: "module",
      scripts: {
        dev: pkg.type === "web" ? "next dev --port 10080" : pkg.type === "api" ? "tsx watch src/index.ts" : "tsc --watch",
        build: pkg.type === "web" ? "next build" : "tsc",
        test: "vitest run",
        lint: "eslint .",
        clean: "rm -rf dist .next",
      },
      dependencies: {
        [`${pkgPrefix}/shared`]: "workspace:*",
        ...(pkg.type === "web" ? { next: "*", react: "*", "react-dom": "*" } : {}),
        ...(pkg.type === "api" ? { express: "*" } : {}),
      },
      devDependencies: {
        [`${pkgPrefix}/tsconfig`]: "workspace:*",
        typescript: "*", vitest: "*",
        ...(pkg.type === "api" ? { "@types/express": "*", tsx: "*" } : {}),
      },
    }, null, 2), needsLlm: false });

    files.push({ path: `${dir}/${pkg.name}/tsconfig.json`, content: `{ "extends": "${pkgPrefix}/tsconfig/base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }\n`, needsLlm: false });

    if (pkg.type === "web") {
      files.push({ path: `${dir}/${pkg.name}/src/app/page.tsx`, content: `export default function Home() {\n  return <main><h1>${cfg.name}</h1><p>Web app.</p></main>;\n}\n`, needsLlm: true });
      files.push({ path: `${dir}/${pkg.name}/src/app/layout.tsx`, content: `export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n`, needsLlm: false });
    } else if (pkg.type === "api") {
      files.push({ path: `${dir}/${pkg.name}/src/index.ts`, content: `import express from "express";\n\nconst app = express();\napp.use(express.json());\n\nconst items = new Map<number, { id: number; name: string; description: string }>();\nlet nextId = 1;\n\napp.get("/health", (_, res) => res.json({ status: "ok" }));\n\napp.get("/api/items", (_, res) => res.json([...items.values()]));\n\napp.post("/api/items", (req, res) => {\n  const { name, description } = req.body;\n  if (!name?.trim()) return res.status(400).json({ error: "Name is required" });\n  const item = { id: nextId++, name: name.trim(), description: description || "" };\n  items.set(item.id, item);\n  res.status(201).json(item);\n});\n\napp.get("/api/items/:id", (req, res) => {\n  const item = items.get(Number(req.params.id));\n  if (!item) return res.status(404).json({ error: "Not found" });\n  res.json(item);\n});\n\napp.put("/api/items/:id", (req, res) => {\n  const item = items.get(Number(req.params.id));\n  if (!item) return res.status(404).json({ error: "Not found" });\n  const { name, description } = req.body;\n  if (!name?.trim()) return res.status(400).json({ error: "Name is required" });\n  item.name = name.trim();\n  item.description = description || item.description;\n  res.json(item);\n});\n\napp.delete("/api/items/:id", (req, res) => {\n  if (!items.delete(Number(req.params.id))) return res.status(404).json({ error: "Not found" });\n  res.status(204).end();\n});\n\nexport { app };\n\napp.listen(10080, () => console.log("API on :10080"));\n`, needsLlm: false });
      files.push({ path: `${dir}/${pkg.name}/src/index.test.ts`, content: `import { describe, it, expect } from "vitest";\n\ndescribe("api", () => {\n  it("health check returns ok", async () => {\n    expect(true).toBe(true); // placeholder until supertest is added\n  });\n});\n`, needsLlm: false });
    } else if (pkg.type === "ui") {
      files.push({ path: `${dir}/${pkg.name}/src/index.ts`, content: `export { Button } from "./Button.js";\n// TODO: export components\n`, needsLlm: false });
      files.push({ path: `${dir}/${pkg.name}/src/Button.ts`, content: `export interface ButtonProps { label: string; onClick?: () => void; variant?: "primary" | "secondary"; }\n\n// TODO: implement component\n`, needsLlm: true });
    } else {
      files.push({ path: `${dir}/${pkg.name}/src/index.ts`, content: `// ${pkg.name}\n// TODO: implement\n`, needsLlm: true });
    }
  }

  // Extras
  files.push({ path: ".gitignore", content: "node_modules/\ndist/\n.next/\n.turbo/\n.nx/\n*.log\n.env\n.env.local\n", needsLlm: false });
  files.push({ path: ".prettierrc", content: `{ "semi": true, "singleQuote": false, "tabWidth": 2, "trailingComma": "all" }\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nMonorepo (${cfg.tool} + ${cfg.packageManager}). Built with KCode.\n\n## Packages\n${cfg.packages.map(p => `- **${p.name}** (${p.type})`).join("\n")}\n\n\`\`\`bash\n${cfg.packageManager} install\n${cfg.packageManager === "pnpm" ? "pnpm" : cfg.packageManager === "bun" ? "bun" : "npm"} run dev\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Monorepo (${cfg.tool}). ${cfg.packages.length} packages. ${m} files machine. USER: "${userRequest}"` };
}
