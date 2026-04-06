// KCode - Implement Engine: Scaffold Generator
//
// Machine phase: detects framework, finds existing patterns, generates
// template files based on project conventions. LLM only fills business logic.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function readSafe(path: string, max = 100): string {
  try {
    return readFileSync(path, "utf-8").split("\n").slice(0, max).join("\n");
  } catch {
    return "";
  }
}

// ── Framework Detection ────────────────────────────────────────

export type Framework =
  | "express" | "fastify" | "nextjs" | "nestjs" | "hono"
  | "fastapi" | "django" | "flask"
  | "gin" | "echo" | "fiber"
  | "actix" | "axum"
  | "spring" | "quarkus"
  | "rails"
  | "laravel"
  | "unknown";

export interface ProjectInfo {
  framework: Framework;
  language: string;
  srcDir: string;
  testDir: string;
  routePattern?: string;    // how existing routes look
  modelPattern?: string;    // how existing models look
  testPattern?: string;     // how existing tests look
}

export function detectProject(cwd: string): ProjectInfo {
  const pkg = existsSync(join(cwd, "package.json"))
    ? JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"))
    : null;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };

  // Node.js frameworks
  if (deps?.next) return { framework: "nextjs", language: "typescript", srcDir: "src/app", testDir: "__tests__" };
  if (deps?.["@nestjs/core"]) return { framework: "nestjs", language: "typescript", srcDir: "src", testDir: "test" };
  if (deps?.fastify) return { framework: "fastify", language: "typescript", srcDir: "src", testDir: "test" };
  if (deps?.hono) return { framework: "hono", language: "typescript", srcDir: "src", testDir: "test" };
  if (deps?.express) return { framework: "express", language: "typescript", srcDir: "src", testDir: "test" };

  // Python
  if (existsSync(join(cwd, "pyproject.toml"))) {
    const pyproject = readSafe(join(cwd, "pyproject.toml"), 30);
    if (pyproject.includes("fastapi")) return { framework: "fastapi", language: "python", srcDir: "app", testDir: "tests" };
    if (pyproject.includes("django")) return { framework: "django", language: "python", srcDir: ".", testDir: "tests" };
    if (pyproject.includes("flask")) return { framework: "flask", language: "python", srcDir: "app", testDir: "tests" };
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    const gomod = readSafe(join(cwd, "go.mod"), 5);
    if (run("grep -rl 'gin-gonic' . --include='*.go' 2>/dev/null | head -1", cwd)) return { framework: "gin", language: "go", srcDir: ".", testDir: "." };
    if (run("grep -rl 'labstack/echo' . --include='*.go' 2>/dev/null | head -1", cwd)) return { framework: "echo", language: "go", srcDir: ".", testDir: "." };
    return { framework: "unknown", language: "go", srcDir: ".", testDir: "." };
  }

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) {
    const cargo = readSafe(join(cwd, "Cargo.toml"), 20);
    if (cargo.includes("actix")) return { framework: "actix", language: "rust", srcDir: "src", testDir: "tests" };
    if (cargo.includes("axum")) return { framework: "axum", language: "rust", srcDir: "src", testDir: "tests" };
    return { framework: "unknown", language: "rust", srcDir: "src", testDir: "tests" };
  }

  // Ruby
  if (existsSync(join(cwd, "Gemfile"))) {
    const gemfile = readSafe(join(cwd, "Gemfile"), 20);
    if (gemfile.includes("rails")) return { framework: "rails", language: "ruby", srcDir: "app", testDir: "spec" };
  }

  // Java
  if (existsSync(join(cwd, "pom.xml")) || existsSync(join(cwd, "build.gradle"))) {
    return { framework: "spring", language: "java", srcDir: "src/main/java", testDir: "src/test/java" };
  }

  // PHP
  if (existsSync(join(cwd, "composer.json"))) {
    const composer = readSafe(join(cwd, "composer.json"), 20);
    if (composer.includes("laravel")) return { framework: "laravel", language: "php", srcDir: "app", testDir: "tests" };
  }

  return { framework: "unknown", language: pkg ? "javascript" : "unknown", srcDir: "src", testDir: "test" };
}

// ── Pattern Finder ─────────────────────────────────────────────

export interface ExistingPattern {
  type: "route" | "model" | "controller" | "test" | "middleware" | "service";
  file: string;
  content: string;
}

export function findExistingPatterns(cwd: string, project: ProjectInfo): ExistingPattern[] {
  const patterns: ExistingPattern[] = [];

  // Find routes/endpoints
  const routeGrep = {
    express: "app\\.get\\|app\\.post\\|app\\.put\\|app\\.delete\\|router\\.",
    fastify: "fastify\\.get\\|fastify\\.post\\|app\\.register",
    nextjs: "export.*GET\\|export.*POST\\|export.*PUT\\|export.*DELETE",
    nestjs: "@Get\\|@Post\\|@Put\\|@Delete\\|@Controller",
    fastapi: "@app\\.get\\|@app\\.post\\|@router\\.get\\|@router\\.post",
    django: "path(\\|urlpatterns",
    flask: "@app\\.route\\|@blueprint\\.route",
    gin: "r\\.GET\\|r\\.POST\\|r\\.PUT\\|r\\.DELETE",
    rails: "get\\s\\|post\\s\\|put\\s\\|delete\\s\\|resources\\s",
    laravel: "Route::",
  }[project.framework as string] ?? "route\\|endpoint\\|handler";

  const routeFiles = run(
    `grep -rl "${routeGrep}" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" --include="*.rs" --include="*.rb" --include="*.java" --include="*.php" 2>/dev/null | head -3`,
    cwd,
  );

  for (const f of routeFiles.split("\n").filter(Boolean).slice(0, 2)) {
    const content = readSafe(join(cwd, f), 60);
    patterns.push({ type: "route", file: relative(cwd, join(cwd, f)), content });
  }

  // Find models/schemas
  const modelFiles = run(
    `find . -path "*/model*" -o -path "*/schema*" -o -path "*/entity*" | grep -v node_modules | grep -v .git | head -3`,
    cwd,
  );
  for (const f of modelFiles.split("\n").filter(Boolean).slice(0, 2)) {
    const content = readSafe(join(cwd, f), 40);
    patterns.push({ type: "model", file: relative(cwd, join(cwd, f)), content });
  }

  // Find tests
  const testFiles = run(
    `find . -name "*.test.*" -o -name "*.spec.*" -o -name "test_*" | grep -v node_modules | grep -v .git | head -3`,
    cwd,
  );
  for (const f of testFiles.split("\n").filter(Boolean).slice(0, 2)) {
    const content = readSafe(join(cwd, f), 40);
    patterns.push({ type: "test", file: relative(cwd, join(cwd, f)), content });
  }

  return patterns;
}

// ── Scaffold Templates ─────────────────────────────────────────

export interface ScaffoldResult {
  project: ProjectInfo;
  patterns: ExistingPattern[];
  prompt: string;
  estimatedFiles: string[];
}

export function buildImplementPrompt(
  userRequest: string,
  cwd: string,
): ScaffoldResult {
  const project = detectProject(cwd);
  const patterns = findExistingPatterns(cwd, project);

  // Extract what the user wants to create
  const entityMatch = userRequest.match(
    /(?:for|para|de|del)\s+(\w+)/i,
  );
  const entity = entityMatch?.[1] ?? "resource";

  // Estimate files to create
  const estimatedFiles: string[] = [];
  const ext = project.language === "typescript" ? ".ts"
    : project.language === "python" ? ".py"
    : project.language === "go" ? ".go"
    : project.language === "rust" ? ".rs"
    : project.language === "ruby" ? ".rb"
    : project.language === "java" ? ".java"
    : project.language === "php" ? ".php"
    : ".ts";

  if (project.framework === "nextjs") {
    estimatedFiles.push(`src/app/api/${entity}/route${ext}`);
  } else if (project.framework === "nestjs") {
    estimatedFiles.push(
      `src/${entity}/${entity}.controller${ext}`,
      `src/${entity}/${entity}.service${ext}`,
      `src/${entity}/${entity}.module${ext}`,
      `src/${entity}/dto/create-${entity}.dto${ext}`,
    );
  } else if (project.framework === "express" || project.framework === "fastify" || project.framework === "hono") {
    estimatedFiles.push(
      `${project.srcDir}/routes/${entity}${ext}`,
      `${project.srcDir}/models/${entity}${ext}`,
    );
  } else if (project.framework === "fastapi") {
    estimatedFiles.push(
      `${project.srcDir}/routers/${entity}.py`,
      `${project.srcDir}/models/${entity}.py`,
      `${project.srcDir}/schemas/${entity}.py`,
    );
  } else if (project.framework === "django") {
    estimatedFiles.push(
      `${entity}/views.py`,
      `${entity}/models.py`,
      `${entity}/urls.py`,
      `${entity}/serializers.py`,
    );
  } else if (project.framework === "gin" || project.framework === "echo") {
    estimatedFiles.push(
      `handlers/${entity}.go`,
      `models/${entity}.go`,
    );
  } else {
    estimatedFiles.push(
      `${project.srcDir}/${entity}${ext}`,
    );
  }
  estimatedFiles.push(`${project.testDir}/${entity}.test${ext}`);

  // Build the LLM prompt with existing patterns as examples
  const patternContext = patterns.length > 0
    ? patterns.map(p =>
        `### Existing ${p.type} (${p.file}) — FOLLOW THIS STYLE:\n\`\`\`\n${p.content}\n\`\`\``
      ).join("\n\n")
    : "No existing patterns found. Use standard conventions.";

  const prompt = `You are implementing a feature in a ${project.framework} (${project.language}) project.

USER REQUEST: "${userRequest}"

## Project Info
- Framework: ${project.framework}
- Language: ${project.language}
- Source directory: ${project.srcDir}
- Test directory: ${project.testDir}

## Existing Patterns (MATCH THIS STYLE EXACTLY)

${patternContext}

## Files to Create
${estimatedFiles.map(f => `- ${f}`).join("\n")}

## Instructions
1. Follow the EXACT same patterns/conventions as the existing code above
2. Create ALL the files listed
3. Include proper imports, types, error handling, validation
4. Include a test file with at least 3 test cases (happy path, validation, error)
5. Use the project's existing naming conventions (camelCase, snake_case, etc.)
6. Do NOT add extra files beyond what's listed
7. Do NOT add comments explaining what you're doing — just write clean code`;

  return { project, patterns, prompt, estimatedFiles };
}
