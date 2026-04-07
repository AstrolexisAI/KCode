const fs = require("fs");
const path = require("path");

const OUT = "/tmp/kcode-detail-audit";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const engines = [
  ["web", "./src/core/web-engine/web-engine.ts", "createWebProject", "SaaS dashboard called webtest"],
  ["python", "./src/core/web-engine/stacks/python-engine.ts", "createPyProject", "FastAPI server called pytest"],
  ["cpp", "./src/core/web-engine/stacks/cpp-engine.ts", "createCppProject", "HTTP server called cpptest"],
  ["rust", "./src/core/web-engine/stacks/rust-engine.ts", "createRustProject", "API with Axum called rstest"],
  ["go", "./src/core/web-engine/stacks/go-engine.ts", "createGoProject", "REST API with Chi called gotest"],
  ["swift", "./src/core/web-engine/stacks/swift-engine.ts", "createSwiftProject", "Vapor server called swtest"],
  ["java", "./src/core/web-engine/stacks/java-engine.ts", "createJavaProject", "Spring Boot API called jvtest"],
  ["node", "./src/core/web-engine/stacks/node-engine.ts", "createNodeProject", "CLI tool called ndtest"],
  ["docker", "./src/core/web-engine/stacks/docker-engine.ts", "createDockerProject", "Node API with Postgres called dktest"],
  ["csharp", "./src/core/web-engine/stacks/csharp-engine.ts", "createCSharpProject", "minimal API called cstest"],
  ["kotlin", "./src/core/web-engine/stacks/kotlin-engine.ts", "createKotlinProject", "Ktor API called kttest"],
  ["php", "./src/core/web-engine/stacks/php-engine.ts", "createPhpProject", "Slim API called phtest"],
  ["ruby", "./src/core/web-engine/stacks/ruby-engine.ts", "createRubyProject", "Sinatra API called rbtest"],
  ["zig", "./src/core/web-engine/stacks/zig-engine.ts", "createZigProject", "CLI tool called zgtest"],
  ["elixir", "./src/core/web-engine/stacks/elixir-engine.ts", "createElixirProject", "Plug API called extest"],
  ["css", "./src/core/web-engine/stacks/css-engine.ts", "createCssProject", "design system called csstest"],
  ["db", "./src/core/web-engine/stacks/db-engine.ts", "createDbProject", "Postgres with users products using Prisma called dbtest"],
  ["dart", "./src/core/web-engine/stacks/dart-engine.ts", "createDartProject", "Flutter app called dttest"],
  ["lua", "./src/core/web-engine/stacks/lua-engine.ts", "createLuaProject", "Love2D game called lutest"],
  ["haskell", "./src/core/web-engine/stacks/haskell-engine.ts", "createHaskellProject", "Scotty API called hstest"],
  ["scala", "./src/core/web-engine/stacks/scala-engine.ts", "createScalaProject", "http4s API called sctest"],
  ["terraform", "./src/core/web-engine/stacks/terraform-engine.ts", "createTerraformProject", "AWS VPC with RDS called tftest"],
  ["monorepo", "./src/core/web-engine/stacks/monorepo-engine.ts", "createMonorepoProject", "web API called mntest"],
  ["cicd", "./src/core/web-engine/stacks/cicd-engine.ts", "createCicdProject", "Rust CI with Docker called citest"],
];

const issues: any[] = [];
const nonServer = ["css", "cicd", "terraform", "db", "monorepo", "docker"];

for (const [name, mod, fn, desc] of engines) {
  try {
    const m = require(mod);
    const r = (m as any)[fn as string](desc, OUT);
    const files: Array<{path: string; content: string}> = r.files ?? [];

    // 1. Wrong port (8080 or 3000 instead of 10080)
    for (const f of files) {
      if (f.content.includes(":8080") && !f.content.includes("10080") && name !== "docker" && name !== "java") {
        issues.push({ engine: name, type: "wrong-port", detail: `${f.path} uses :8080` });
      }
    }

    // 2. Missing .gitignore
    if (!files.some(f => f.path === ".gitignore")) {
      issues.push({ engine: name, type: "no-gitignore", detail: "Missing .gitignore" });
    }

    // 3. Missing README
    if (!files.some(f => f.path === "README.md")) {
      issues.push({ engine: name, type: "no-readme", detail: "Missing README.md" });
    }

    // 4. Missing tests
    const hasTests = files.some(f => /test|spec|Test|Spec|_test/.test(f.path));
    if (!hasTests && !nonServer.includes(name as string)) {
      issues.push({ engine: name, type: "no-tests", detail: "No test files" });
    }

    // 5. Missing Dockerfile for server projects
    const serverEngines = ["rust", "go", "java", "kotlin", "scala", "csharp", "php", "ruby", "elixir", "swift", "python", "node", "cpp"];
    if (serverEngines.includes(name as string) && !files.some(f => f.path.includes("Dockerfile"))) {
      issues.push({ engine: name, type: "no-dockerfile", detail: "Server missing Dockerfile" });
    }

    // 6. Missing CI
    if (!files.some(f => f.path.includes("ci.yml")) && !nonServer.includes(name as string)) {
      issues.push({ engine: name, type: "no-ci", detail: "Missing CI config" });
    }

    // 7. Has secrets but no .env.example
    const hasSecrets = files.some(f => /API_KEY|SECRET|PASSWORD|DATABASE_URL/.test(f.content));
    if (hasSecrets && !files.some(f => f.path.includes(".env"))) {
      issues.push({ engine: name, type: "no-env", detail: "Has secrets but no .env" });
    }

    // 8. Level1 "levantalo" support check
    const { tryLevel1 } = require("./src/core/task-orchestrator/level1-handlers.ts");
    const projPath = r.projectPath ?? path.join(OUT, name);
    const l1 = tryLevel1("levantalo en el puerto 10080", projPath);
    if (l1.handled && l1.output.includes("No project detected")) {
      issues.push({ engine: name, type: "no-levantalo", detail: "Level1 cant detect project type" });
    }

  } catch (e: any) {
    issues.push({ engine: name, type: "error", detail: e.message?.slice(0, 80) });
  }
}

// Report
console.log("================================================================");
console.log("  KCODE ENGINE DETAIL AUDIT");
console.log("================================================================\n");

const byType: Record<string, typeof issues> = {};
for (const i of issues) {
  if (!byType[i.type]) byType[i.type] = [];
  byType[i.type]!.push(i);
}

for (const [type, items] of Object.entries(byType)) {
  console.log(`\n-- ${type} (${items.length}) --`);
  for (const i of items) console.log(`  [${i.engine}] ${i.detail}`);
}

console.log(`\nTotal: ${issues.length} issues\n`);

// Summary
console.log("-- Engine Health --");
const names = [...new Set(engines.map(e => e[0]))];
for (const name of names) {
  const count = issues.filter(i => i.engine === name).length;
  const icon = count === 0 ? "OK" : count <= 2 ? "WARN" : "FAIL";
  console.log(`  ${icon.padEnd(5)} ${(name as string).padEnd(12)} ${count} issues`);
}
