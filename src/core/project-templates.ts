// KCode - Project Templates
// Generate project scaffolds with best practices via `kcode new <template>`
// Templates are loaded from ~/.kcode/templates/ and built-in defaults.

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { kcodePath } from "./paths";

export interface ProjectTemplate {
  name: string;
  description: string;
  files: Record<string, string>; // relative path → content
  postCreate?: string; // shell command to run after creating
  source: "builtin" | "user";
}

// ─── Built-in Templates ─────────────────────────────────────────

const BUILTIN_TEMPLATES: ProjectTemplate[] = [
  {
    name: "bun-ts",
    description: "TypeScript project with Bun runtime",
    source: "builtin",
    postCreate: "bun install",
    files: {
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "0.1.0",
        type: "module",
        scripts: { dev: "bun run --watch src/index.ts", test: "bun test", build: "bun build src/index.ts --outdir dist" },
        devDependencies: { "@types/bun": "latest" },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext", module: "ESNext", moduleResolution: "bundler",
          strict: true, esModuleInterop: true, skipLibCheck: true,
          outDir: "dist", declaration: true,
        },
        include: ["src"],
      }, null, 2),
      "src/index.ts": '// {{name}}\nconsole.log("Hello from {{name}}!");\n',
      ".gitignore": "node_modules/\ndist/\n.env\n",
      "KCODE.md": "# {{name}}\n\n## Build & Run\n```bash\nbun run dev    # Watch mode\nbun test       # Run tests\nbun run build  # Build\n```\n",
    },
  },
  {
    name: "react-app",
    description: "React + TypeScript + Vite application",
    source: "builtin",
    postCreate: "bun install",
    files: {
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "0.1.0",
        type: "module",
        scripts: { dev: "bunx vite", build: "bunx vite build", preview: "bunx vite preview" },
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "@vitejs/plugin-react": "^4.0.0", vite: "^6.0.0", typescript: "^5.7.0" },
      }, null, 2),
      "index.html": '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>{{name}}</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>',
      "src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
      "src/App.tsx": 'export function App() {\n  return <div><h1>{{name}}</h1><p>Edit src/App.tsx to get started.</p></div>;\n}\n',
      "vite.config.ts": 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n',
      ".gitignore": "node_modules/\ndist/\n.env\n",
    },
  },
  {
    name: "api",
    description: "REST API with Bun.serve + TypeScript",
    source: "builtin",
    postCreate: "bun install",
    files: {
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "0.1.0",
        type: "module",
        scripts: { dev: "bun run --watch src/server.ts", test: "bun test" },
        devDependencies: { "@types/bun": "latest" },
      }, null, 2),
      "src/server.ts": `const PORT = parseInt(process.env.PORT ?? "10080");\n\nBun.serve({\n  port: PORT,\n  fetch(req) {\n    const url = new URL(req.url);\n\n    if (url.pathname === "/health") {\n      return Response.json({ status: "ok", timestamp: new Date().toISOString() });\n    }\n\n    if (url.pathname === "/api/hello") {\n      return Response.json({ message: "Hello from {{name}}!" });\n    }\n\n    return Response.json({ error: "Not found" }, { status: 404 });\n  },\n});\n\nconsole.log(\`{{name}} listening on http://localhost:\${PORT}\`);\n`,
      ".gitignore": "node_modules/\n.env\n",
      "KCODE.md": "# {{name}}\n\nREST API on port 10080.\n\n```bash\nbun run dev  # Start with watch\n```\n",
    },
  },
  {
    name: "cli",
    description: "CLI tool with Commander.js + TypeScript",
    source: "builtin",
    postCreate: "bun install",
    files: {
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "0.1.0",
        type: "module",
        bin: { "{{name}}": "dist/cli.js" },
        scripts: { dev: "bun run src/cli.ts", build: "bun build src/cli.ts --compile --outfile dist/{{name}}", test: "bun test" },
        dependencies: { commander: "^14.0.0" },
        devDependencies: { "@types/bun": "latest" },
      }, null, 2),
      "src/cli.ts": `#!/usr/bin/env bun\nimport { Command } from "commander";\n\nconst program = new Command()\n  .name("{{name}}")\n  .version("0.1.0")\n  .description("{{name}} CLI tool");\n\nprogram\n  .command("hello")\n  .description("Say hello")\n  .argument("[name]", "Name to greet", "world")\n  .action((name) => {\n    console.log(\`Hello, \${name}!\`);\n  });\n\nprogram.parse();\n`,
      ".gitignore": "node_modules/\ndist/\n.env\n",
    },
  },
  {
    name: "python-api",
    description: "Python FastAPI + SQLite REST API",
    source: "builtin",
    postCreate: "python -m venv venv && source venv/bin/activate && pip install fastapi uvicorn",
    files: {
      "main.py": `from fastapi import FastAPI\n\napp = FastAPI(title="{{name}}")\n\n@app.get("/health")\ndef health():\n    return {"status": "ok"}\n\n@app.get("/api/hello")\ndef hello(name: str = "world"):\n    return {"message": f"Hello, {name}!"}\n\nif __name__ == "__main__":\n    import uvicorn\n    uvicorn.run(app, host="0.0.0.0", port=10080)\n`,
      "requirements.txt": "fastapi>=0.115.0\nuvicorn>=0.34.0\n",
      ".gitignore": "venv/\n__pycache__/\n*.pyc\n.env\n",
    },
  },
];

// ─── User Templates ─────────────────────────────────────────────

function loadUserTemplates(): ProjectTemplate[] {
  const dir = kcodePath("templates");
  if (!existsSync(dir)) return [];

  const templates: ProjectTemplate[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const filePath = join(dir, entry.name);
        const stat = require("node:fs").statSync(filePath);
        if (stat.size > 512 * 1024) continue; // Skip files > 512KB
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        if (raw.name && raw.files && typeof raw.files === "object") {
          templates.push({
            name: raw.name,
            description: raw.description ?? `User template: ${raw.name}`,
            files: raw.files,
            postCreate: raw.postCreate,
            source: "user",
          });
        }
      } catch { /* skip invalid */ }
    }
  } catch { /* dir not readable */ }

  return templates;
}

// ─── Public API ─────────────────────────────────────────────────

export function listTemplates(): ProjectTemplate[] {
  return [...BUILTIN_TEMPLATES, ...loadUserTemplates()];
}

export function findTemplate(name: string): ProjectTemplate | null {
  return listTemplates().find(t => t.name === name) ?? null;
}

export function createFromTemplate(
  template: ProjectTemplate,
  projectName: string,
  targetDir: string,
): { filesCreated: string[]; postCreate?: string } {
  const filesCreated: string[] = [];

  mkdirSync(targetDir, { recursive: true });

  for (const [relPath, content] of Object.entries(template.files)) {
    // Prevent path traversal: ensure resolved path stays within targetDir
    const fullPath = join(targetDir, relPath);
    const { resolve: resolvePath } = require("node:path");
    const resolvedFull = resolvePath(fullPath);
    const resolvedTarget = resolvePath(targetDir);
    if (!resolvedFull.startsWith(resolvedTarget + "/") && resolvedFull !== resolvedTarget) {
      continue; // Skip paths that escape the target directory
    }

    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir) mkdirSync(dir, { recursive: true });

    // Replace {{name}} placeholder
    const resolved = content.replace(/\{\{name\}\}/g, projectName);
    writeFileSync(fullPath, resolved, "utf-8");
    filesCreated.push(relPath);
  }

  return {
    filesCreated,
    postCreate: template.postCreate?.replace(/\{\{name\}\}/g, projectName),
  };
}
