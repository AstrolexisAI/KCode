// KCode - Natural language → Code engine router
// Detects which engine to use from user's natural language request

export type EngineId =
  | "python"
  | "cpp"
  | "rust"
  | "go"
  | "swift"
  | "java"
  | "node"
  | "csharp"
  | "kotlin"
  | "php"
  | "ruby"
  | "zig"
  | "elixir"
  | "dart"
  | "lua"
  | "haskell"
  | "scala"
  | "docker"
  | "db"
  | "css"
  | "terraform"
  | "monorepo"
  | "cicd"
  | "api"
  | "fullstack";

interface EngineMatch {
  engine: EngineId;
  confidence: number;
}

// Order: high-confidence infra FIRST, then languages, then generic stacks
const ENGINE_PATTERNS: Array<{ engine: EngineId; pattern: RegExp }> = [
  // ── High-confidence infra (when the PRIMARY intent is infra, not language) ──
  {
    engine: "terraform",
    pattern: /\b(?:terraform|infra(?:structure)?(?:\s+as\s+code)?|iac|vpc|hcl)\b/i,
  },
  { engine: "docker", pattern: /\b(?:docker(?:\s*file)?|docker.?compose|containerize)\b/i },
  { engine: "monorepo", pattern: /\b(?:monorepo|turborepo|nx\s+workspace|mono.?repo)\b/i },
  {
    engine: "cicd",
    pattern: /\b(?:ci\/?cd|github\s*actions?|gitlab\s*ci|jenkins(?:file)?|ci\s+pipeline)\b/i,
  },
  {
    engine: "db",
    pattern:
      /\b(?:database|schema|migration|postgres(?:ql)?|mysql|sqlite|mongo(?:db)?|redis|sql\s*server|mssql|prisma|drizzle|typeorm|knex|mongoose)\b/i,
  },
  {
    engine: "css",
    pattern:
      /\b(?:design\s*system|css\s+(?:framework|library|component)|tailwind\s+plugin|sass\s+framework|animation\s+library|ui\s*kit)\b/i,
  },

  // ── Languages (explicit mention wins over generic stacks) ──
  { engine: "dart", pattern: /\b(?:flutter|dart)\b/i },
  { engine: "rust", pattern: /\b(?:rust|cargo|axum|tokio|actix)\b/i },
  {
    engine: "go",
    pattern: /\b(?:golang|go\s+(?:api|server|cli|project|app|rest)|chi\s+|gin\s+|go\s+lang)\b/i,
  },
  { engine: "swift", pattern: /\b(?:swift(?:ui)?|vapor|ios\s+app|macos\s+app|xcode)\b/i },
  { engine: "kotlin", pattern: /\b(?:kotlin|ktor|android\s+(?:app|project)|jetpack\s*compose)\b/i },
  { engine: "scala", pattern: /\b(?:scala|http4s|akka|spark\s+(?:job|pipeline|app)|sbt)\b/i },
  { engine: "haskell", pattern: /\b(?:haskell|scotty|servant|cabal|stack\s+project)\b/i },
  { engine: "elixir", pattern: /\b(?:elixir|phoenix|liveview|plug|mix\s+project|otp)\b/i },
  { engine: "zig", pattern: /\b(?:zig)\b/i },
  { engine: "lua", pattern: /\b(?:lua|love2d|neovim\s+plugin|roblox)\b/i },
  { engine: "csharp", pattern: /(?:c#|csharp|\b(?:\.?net|dotnet|asp\.?net|blazor|maui)\b)/i },
  {
    engine: "java",
    pattern:
      /\b(?:java\s+(?:api|app|project|server)|spring\s*boot|spring|gradle\s+project|maven)\b/i,
  },
  {
    engine: "php",
    pattern:
      /\b(?:php|laravel|symfony|slim\s+(?:api|app)|wordpress\s+plugin|composer\s+project)\b/i,
  },
  {
    engine: "ruby",
    pattern: /\b(?:ruby|rails|sinatra|gem\s+(?:library|package)|bundler|sidekiq)\b/i,
  },
  { engine: "python", pattern: /\b(?:python|fastapi|django|flask|pip|poetry|pytorch|pandas)\b/i },
  {
    engine: "cpp",
    pattern: /(?:\bc\+\+|cpp|cmake|\bc\s+(?:library|server|project|program)\b)|C\+\+/i,
  },
  {
    engine: "node",
    pattern: /\b(?:node\.?js|npm\s+package|typescript\s+(?:cli|project|library)|bun\s+project)\b/i,
  },

  // ── Generic stacks (checked last) ──
  {
    engine: "fullstack",
    pattern: /\b(?:fullstack|full.?stack|frontend.{0,5}backend|front.{0,5}back)\b/i,
  },
  {
    engine: "api",
    pattern: /\b(?:rest\s*api|express\s*api|api\s+(?:with|con|para)\s+(?:users|products|auth))\b/i,
  },
];

// Must also match "create" intent — don't hijack "fix my Go code" or "explain this Python"
const CREATE_INTENT =
  /\b(?:crea(?:r|te|ting)?|make|build|genera(?:te|r)?|scaffold|setup|new|init|starter|bootstrap|hazme|construir|proyecto\s+(?:de|en|con)|project\s+(?:in|with|for|using))\b/i;

// ── Auto-selector: infer best engine from project description ──

interface ProjectSignal {
  type:
    | "web"
    | "api"
    | "mobile"
    | "cli"
    | "data"
    | "game"
    | "realtime"
    | "embedded"
    | "ml"
    | "desktop";
}

function detectProjectType(msg: string): ProjectSignal | null {
  const lower = msg.toLowerCase();
  // Web app signals — these are always web, regardless of other keywords
  // "create a chat" / "chat app" / "chat messaging app" / "messaging app" → web
  const isWebApp =
    /\b(?:crm|kanban|chat\s+(?:app|messag)|chat\b(?=.*\b(?:levant|run|start|app|and))|messag(?:ing)?\s+app|social\s+(?:media\s+)?feed|lms|course\s+platform|e-?commerce|store|shop|admin\s+panel|project\s+manag|task\s+(?:board|manag)|iot\s+(?:monitor|dashboard)|device\s+monitor)\b/i.test(
      lower,
    ) || /\b(?:crea|create|build|make)\s+(?:an?\s+)?chat\b/i.test(lower);
  if (isWebApp) return { type: "web" };
  // Visual UI signals — if user wants a dashboard/page WITH visual elements, it's web
  const hasVisualUI =
    /\b(?:dashboard|page|ui|frontend|dark\s*(?:theme|ui|mode)|chart|heatmap|candlestick|ticker|interface|panel|widget|responsive)\b/i.test(
      lower,
    );
  const hasDataSignal =
    /\b(?:pipeline|etl|csv|report|scraper|crawler|batch|transform|ingest|bot|trading\s*bot|stock\s*(?:bot|script|tool))\b/i.test(
      lower,
    );
  // "wallstreet dashboard with charts" = web (visual), "data pipeline with ETL" = data (processing)
  if (hasDataSignal && !hasVisualUI) return { type: "data" };
  if (
    /\b(?:dashboard|landing|page|website|sitio|portal|blog|portfolio|store|tienda|saas|admin\s*panel|cms)\b/i.test(
      lower,
    )
  )
    return { type: "web" };
  if (/\b(?:api|backend|server|microservice|endpoint|servicio|servidor)\b/i.test(lower))
    return { type: "api" };
  if (/\b(?:desktop|gui|window|native\s*app|tray|menubar)\b/i.test(lower))
    return { type: "desktop" };
  if (/\b(?:mobile|app|ios|android|tablet|telefono|celular)\b/i.test(lower))
    return { type: "mobile" };
  if (/\b(?:cli|command|terminal|tool|herramienta|script|automation|cron)\b/i.test(lower))
    return { type: "cli" };
  if (/\b(?:game|juego|2d|3d|engine|sprite|physics|player)\b/i.test(lower)) return { type: "game" };
  if (/\b(?:realtime|real.?time|websocket|chat|streaming|live|notification)\b/i.test(lower))
    return { type: "realtime" };
  if (/\b(?:embedded|firmware|iot|sensor|arduino|raspberry|microcontroller)\b/i.test(lower))
    return { type: "embedded" };
  if (
    /\b(?:ml|machine\s*learn|ai|model|train|neural|deep\s*learn|torch|tensorflow|llm)\b/i.test(
      lower,
    )
  )
    return { type: "ml" };
  return null;
}

// Best engine per project type (based on ecosystem strength)
const AUTO_SELECT: Record<string, EngineId> = {
  web: "node", // Next.js via web engine (handled by isWebRequest in conversation.ts)
  api: "go", // Go Chi — fast, simple, production-proven
  mobile: "dart", // Flutter — cross-platform
  cli: "go", // Go — single binary, fast compilation
  data: "python", // Python — pandas, charts, scrapers
  game: "lua", // Love2D — simple 2D games
  realtime: "elixir", // Elixir — built for concurrency
  embedded: "cpp", // C/C++ — hardware level
  ml: "python", // Python — PyTorch, TensorFlow
  desktop: "csharp", // .NET MAUI — cross-platform desktop
};

export function detectCodeEngine(message: string): EngineMatch | null {
  // Must have creation intent
  if (!CREATE_INTENT.test(message)) return null;

  // 1. Explicit language/stack match (highest priority)
  for (const { engine, pattern } of ENGINE_PATTERNS) {
    if (pattern.test(message)) {
      return { engine, confidence: 0.95 };
    }
  }

  // 2. Auto-select: infer engine from project type description
  const projectType = detectProjectType(message);
  if (projectType) {
    // "web" type is handled by isWebRequest in conversation.ts, so skip it here
    if (projectType.type === "web") return null;
    const engine = AUTO_SELECT[projectType.type];
    if (engine) return { engine, confidence: 0.75 };
  }

  return null;
}

export async function runCodeEngine(
  engine: EngineId,
  userRequest: string,
  cwd: string,
): Promise<string | null> {
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
  const files =
    result.files?.length ??
    result.totalFiles ??
    (result.machineFiles ?? 0) + (result.llmFiles ?? 0);
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
