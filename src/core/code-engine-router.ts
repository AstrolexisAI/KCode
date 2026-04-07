// KCode - Natural language → Code engine router
// Detects which engine to use from user's natural language request

export type EngineId =
  | "python" | "cpp" | "rust" | "go" | "swift" | "java" | "node"
  | "csharp" | "kotlin" | "php" | "ruby" | "zig" | "elixir"
  | "dart" | "lua" | "haskell" | "scala"
  | "docker" | "db" | "css" | "terraform" | "monorepo" | "cicd"
  | "api" | "fullstack";

interface EngineMatch {
  engine: EngineId;
  confidence: number;
}

// Order matters — more specific patterns first
const ENGINE_PATTERNS: Array<{ engine: EngineId; pattern: RegExp }> = [
  // Specific stacks/infra (check before languages)
  { engine: "terraform", pattern: /\b(?:terraform|infra(?:structure)?(?:\s+as\s+code)?|iac|vpc|ec2|s3|cloud\s*formation|hcl)\b/i },
  { engine: "docker", pattern: /\b(?:docker(?:\s*file)?|docker.?compose|containerize)\b/i },
  { engine: "monorepo", pattern: /\b(?:monorepo|turborepo|nx\s+workspace|mono.?repo)\b/i },
  { engine: "cicd", pattern: /\b(?:ci\/?cd|github\s*action|gitlab\s*ci|jenkins(?:file)?|ci\s+pipeline)\b/i },
  { engine: "db", pattern: /\b(?:database|schema|migration|postgres(?:ql)?|mysql|sqlite|mongo(?:db)?|redis|sql\s*server|mssql|prisma|drizzle|typeorm|knex|mongoose)\b/i },
  { engine: "css", pattern: /\b(?:design\s*system|css\s+(?:framework|library|component)|tailwind\s+plugin|sass\s+framework|animation\s+library|ui\s*kit)\b/i },
  { engine: "fullstack", pattern: /\b(?:fullstack|full.?stack|frontend.{0,5}backend|front.{0,5}back)\b/i },
  { engine: "api", pattern: /\b(?:rest\s*api|express\s*api|api\s+(?:with|con|para)\s+(?:users|products|auth))\b/i },

  // Languages — specific frameworks first
  { engine: "dart", pattern: /\b(?:flutter|dart)\b/i },
  { engine: "rust", pattern: /\b(?:rust|cargo|axum|tokio|actix)\b/i },
  { engine: "go", pattern: /\b(?:golang|go\s+(?:api|server|cli|project|app)|chi\s+|gin\s+|go\s+lang)\b/i },
  { engine: "swift", pattern: /\b(?:swift(?:ui)?|vapor|ios\s+app|macos\s+app|xcode)\b/i },
  { engine: "kotlin", pattern: /\b(?:kotlin|ktor|android\s+(?:app|project)|jetpack\s*compose)\b/i },
  { engine: "scala", pattern: /\b(?:scala|http4s|akka|spark\s+(?:job|pipeline|app)|sbt)\b/i },
  { engine: "haskell", pattern: /\b(?:haskell|scotty|servant|cabal|stack\s+project)\b/i },
  { engine: "elixir", pattern: /\b(?:elixir|phoenix|liveview|plug|mix\s+project|otp)\b/i },
  { engine: "zig", pattern: /\b(?:zig)\b/i },
  { engine: "lua", pattern: /\b(?:lua|love2d|neovim\s+plugin|roblox)\b/i },
  { engine: "csharp", pattern: /\b(?:c#|csharp|\.?net\b|dotnet|asp\.?net|blazor|maui)\b/i },
  { engine: "java", pattern: /\b(?:java\s+(?:api|app|project|server)|spring\s*boot|spring|gradle\s+project|maven)\b/i },
  { engine: "php", pattern: /\b(?:php|laravel|symfony|slim\s+(?:api|app)|wordpress\s+plugin|composer\s+project)\b/i },
  { engine: "ruby", pattern: /\b(?:ruby|rails|sinatra|gem\s+(?:library|package)|bundler|sidekiq)\b/i },
  { engine: "python", pattern: /\b(?:python|fastapi|django|flask|pip|poetry|pytorch|pandas)\b/i },
  { engine: "cpp", pattern: /\b(?:c\+\+|cpp|cmake|c\s+(?:library|server|project|program))\b|\bC\+\+/i },
  { engine: "node", pattern: /\b(?:node\.?js|npm\s+package|typescript\s+(?:cli|project|library)|bun\s+project)\b/i },
];

// Must also match "create" intent — don't hijack "fix my Go code" or "explain this Python"
const CREATE_INTENT = /\b(?:crea(?:r|te|ting)?|make|build|genera(?:te|r)?|scaffold|setup|new|init|starter|bootstrap|hazme|construir|proyecto\s+(?:de|en|con)|project\s+(?:in|with|for|using))\b/i;

export function detectCodeEngine(message: string): EngineMatch | null {
  // Must have creation intent
  if (!CREATE_INTENT.test(message)) return null;

  for (const { engine, pattern } of ENGINE_PATTERNS) {
    if (pattern.test(message)) {
      return { engine, confidence: 0.9 };
    }
  }
  return null;
}

export async function runCodeEngine(engine: EngineId, userRequest: string, cwd: string): Promise<string | null> {
  const engineMap: Record<string, { mod: string; fn: string; promptKey?: string }> = {
    python: { mod: "./web-engine/stacks/python-engine.js", fn: "createPyProject" },
    cpp: { mod: "./web-engine/stacks/cpp-engine.js", fn: "createCppProject" },
    rust: { mod: "./web-engine/stacks/rust-engine.js", fn: "createRustProject" },
    go: { mod: "./web-engine/stacks/go-engine.js", fn: "createGoProject" },
    swift: { mod: "./web-engine/stacks/swift-engine.js", fn: "createSwiftProject" },
    java: { mod: "./web-engine/stacks/java-engine.js", fn: "createJavaProject" },
    node: { mod: "./web-engine/stacks/node-engine.js", fn: "createNodeProject" },
    docker: { mod: "./web-engine/stacks/docker-engine.js", fn: "createDockerProject" },
    csharp: { mod: "./web-engine/stacks/csharp-engine.js", fn: "createCSharpProject" },
    kotlin: { mod: "./web-engine/stacks/kotlin-engine.js", fn: "createKotlinProject" },
    php: { mod: "./web-engine/stacks/php-engine.js", fn: "createPhpProject" },
    ruby: { mod: "./web-engine/stacks/ruby-engine.js", fn: "createRubyProject" },
    zig: { mod: "./web-engine/stacks/zig-engine.js", fn: "createZigProject" },
    elixir: { mod: "./web-engine/stacks/elixir-engine.js", fn: "createElixirProject" },
    dart: { mod: "./web-engine/stacks/dart-engine.js", fn: "createDartProject" },
    lua: { mod: "./web-engine/stacks/lua-engine.js", fn: "createLuaProject" },
    haskell: { mod: "./web-engine/stacks/haskell-engine.js", fn: "createHaskellProject" },
    scala: { mod: "./web-engine/stacks/scala-engine.js", fn: "createScalaProject" },
    css: { mod: "./web-engine/stacks/css-engine.js", fn: "createCssProject" },
    db: { mod: "./web-engine/stacks/db-engine.js", fn: "createDbProject" },
    terraform: { mod: "./web-engine/stacks/terraform-engine.js", fn: "createTerraformProject" },
    monorepo: { mod: "./web-engine/stacks/monorepo-engine.js", fn: "createMonorepoProject" },
    cicd: { mod: "./web-engine/stacks/cicd-engine.js", fn: "createCicdProject" },
    api: { mod: "./web-engine/api-engine.js", fn: "createApiProject" },
    fullstack: { mod: "./web-engine/fullstack-engine.js", fn: "createFullstackProject" },
  };

  const entry = engineMap[engine];
  if (!entry) return null;

  const mod = await import(entry.mod);
  const result = mod[entry.fn](userRequest, cwd);

  // Build enriched prompt from engine result
  const files = result.files?.length ?? result.totalFiles ?? (result.machineFiles + result.llmFiles) ?? 0;
  const machine = result.files?.filter((f: any) => !f.needsLlm)?.length ?? result.machineFiles ?? 0;
  const llmFiles = result.files?.filter((f: any) => f.needsLlm) ?? [];
  const projectPath = result.projectPath ?? result.name ?? "";

  let prompt = `[KCode ${engine} engine created ${files} files (${machine} machine, ${files - machine} LLM) at ${projectPath}]\n\n`;

  if (result.prompt) {
    prompt += result.prompt + "\n\n";
  }

  if (llmFiles.length > 0) {
    prompt += `The following files need LLM customization based on the user's request:\n`;
    for (const f of llmFiles) {
      prompt += `- ${f.path}\n`;
    }
    prompt += `\nRead each file, understand the TODO markers, and implement the business logic the user described.\n`;
  } else {
    prompt += `All files are complete. Report the project structure and how to run it.\n`;
  }

  prompt += `\nUSER REQUEST: "${userRequest}"`;
  return prompt;
}
