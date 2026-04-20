// Project-stack generators: /web, /api, /fullstack and 20+ language/stack
// commands. Split out of file-actions.ts.

import type { ActionContext } from "./action-helpers.js";

export async function handleStackAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;

  switch (action) {
    case "web": {
      const desc = (args ?? "").trim();
      if (!desc) {
        return [
          "  Usage: /web <description>",
          "",
          "  Examples:",
          "    /web landing page for my AI startup",
          "    /web SaaS dashboard with auth and payments",
          "    /web e-commerce store for handmade jewelry",
          "    /web personal portfolio",
          "    /web blog with markdown support",
        ].join("\n");
      }

      const { createWebProject } = await import("../../core/web-engine/web-engine.js");
      const result = createWebProject(desc, appConfig.workingDirectory);

      const lines = [
        "  KCode Web Engine",
        `    Project:   ${result.intent.name}/`,
        `    Type:      ${result.intent.siteType}`,
        `    Stack:     ${result.intent.stack}`,
        `    Features:  ${result.intent.features.join(", ")}`,
        "",
        `    📁 Machine-generated: ${result.machineFiles} files (0 tokens)`,
        `    ✏️  Needs customization: ${result.llmFiles} files`,
        "",
        `    Project created at: ${result.projectPath}`,
        "",
        "  Next steps:",
        `    1. Model will customize ${result.llmFiles} content files`,
        `    2. cd ${result.intent.name} && npm install && npm run dev`,
        "",
        "  Sending to model for content customization...",
      ];

      return lines.join("\n");
    }

    case "api": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /api users, products, orders\n  Example: /api task management with users and tasks";

      const { createApiProject } = await import("../../core/web-engine/api-engine.js");
      const result = createApiProject(desc, appConfig.workingDirectory);

      return [
        "  KCode API Engine",
        `    Project:    ${result.projectPath}`,
        `    Framework:  ${result.framework}`,
        `    Entities:   ${result.entities.map(e => e.name).join(", ")}`,
        `    Files:      ${result.files.length}`,
        "",
        "  Endpoints created:",
        ...result.entities.map(e =>
          `    /api/${e.name}s  — GET, POST, GET/:id, PUT/:id, DELETE/:id`
        ),
        "",
        `  Next: cd ${result.projectPath.split("/").pop()} && npm install && npm run dev`,
      ].join("\n");
    }

    case "fullstack": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /fullstack task management app with users\n  Creates: frontend + API + database";

      const { createFullstackProject } = await import("../../core/web-engine/fullstack-engine.js");
      const result = createFullstackProject(desc, appConfig.workingDirectory);

      return [
        "  KCode Fullstack Engine",
        `    Project:    ${result.name}/`,
        "",
        `    Frontend:   ${result.frontend.files} files (${result.frontend.machineFiles} machine, ${result.frontend.llmFiles} LLM)`,
        `    Backend:    ${result.backend.files} files`,
        `    Entities:   ${result.backend.entities.join(", ")}`,
        `    Total:      ${result.totalFiles} files`,
        "",
        `  Next: cd ${result.name} && npm install && npm run dev`,
        "  Frontend: http://localhost:3000",
        "  API:      http://localhost:3001",
      ].join("\n");
    }

    case "python": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /python FastAPI for task management\n  /python web scraper for news\n  /python ML pipeline for sentiment analysis\n  /py CLI tool for file processing\n  /py Discord bot";

      const { createPyProject } = await import("../../core/web-engine/stacks/python-engine.js");
      const result = createPyProject(desc, appConfig.workingDirectory);
      const machine = result.files.filter(f => !f.needsLlm).length;
      const llm = result.files.filter(f => f.needsLlm).length;

      return [
        "  KCode Python Engine",
        `    Project:      ${result.config.name}/`,
        `    Type:         ${result.config.type}`,
        `    Python:       ${result.config.pythonVersion}`,
        result.config.framework ? `    Framework:    ${result.config.framework}` : "",
        `    Dependencies: ${result.config.dependencies.slice(0, 5).join(", ")}${result.config.dependencies.length > 5 ? " +" + (result.config.dependencies.length - 5) + " more" : ""}`,
        `    Files:        ${result.files.length} (${machine} machine, ${llm} LLM)`,
        "",
        `  Setup: cd ${result.config.name} && python -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"`,
        `  Run:   make run`,
        `  Test:  make test`,
      ].filter(Boolean).join("\n");
    }

    case "cpp": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /cpp HTTP server with SQLite\n  /cpp embedded firmware for ESP32\n  /cpp game engine with OpenGL\n  /c library for data compression";

      const { createCppProject } = await import("../../core/web-engine/stacks/cpp-engine.js");
      const result = createCppProject(desc, appConfig.workingDirectory);
      const machine = result.files.filter(f => !f.needsLlm).length;
      const llm = result.files.filter(f => f.needsLlm).length;

      return [
        "  KCode C/C++ Engine",
        `    Project:      ${result.config.name}/`,
        `    Type:         ${result.config.type}`,
        `    Standard:     ${result.config.standard}`,
        `    Dependencies: ${result.config.dependencies.join(", ") || "none"}`,
        `    Files:        ${result.files.length} (${machine} machine, ${llm} LLM)`,
        "",
        "  Structure:",
        `    📁 CMakeLists.txt`,
        `    📁 include/${result.config.name}.*`,
        `    📁 src/main.* + ${result.config.name}.*`,
        `    📁 tests/`,
        result.config.hasDocker ? `    📁 Dockerfile` : "",
        result.config.hasCI ? `    📁 .github/workflows/ci.yml` : "",
        "",
        `  Build: cmake -B build && cmake --build build`,
        `  Test:  cd build && ctest`,
      ].filter(Boolean).join("\n");
    }

    case "rust": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /rust API server with Axum\n  /rust CLI tool for file processing\n  /rust game with Bevy";
      const { createRustProject } = await import("../../core/web-engine/stacks/rust-engine.js");
      const r = createRustProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Rust Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  cargo run / cargo test`].join("\n");
    }

    case "go": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /go API with Chi\n  /go CLI tool\n  /go gRPC service";
      const { createGoProject } = await import("../../core/web-engine/stacks/go-engine.js");
      const r = createGoProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Go Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  make run / make test`].join("\n");
    }

    case "swift": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /swift iOS app with SwiftUI\n  /swift macOS app\n  /swift CLI tool\n  /swift Vapor server";
      const { createSwiftProject } = await import("../../core/web-engine/stacks/swift-engine.js");
      const r = createSwiftProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Swift Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  swift build / swift run / swift test`].join("\n");
    }

    case "java": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /java REST API with Spring\n  /java microservice with Kafka\n  /java CLI tool";
      const { createJavaProject } = await import("../../core/web-engine/stacks/java-engine.js");
      const r = createJavaProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Java Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  ./gradlew bootRun / ./gradlew test`].join("\n");
    }

    case "node": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /node CLI tool called mytool\n  /node Discord bot\n  /node library for data processing\n  /node worker with Redis queue";
      const { createNodeProject } = await import("../../core/web-engine/stacks/node-engine.js");
      const r = createNodeProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Node.js Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  npm run dev / npm test`].join("\n");
    }

    case "docker": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /docker Node.js API with Redis and Postgres\n  /docker Python ML pipeline with GPU\n  /docker microservices with Nginx reverse proxy";
      const { createDockerProject } = await import("../../core/web-engine/stacks/docker-engine.js");
      const r = createDockerProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Docker Engine`, `    ${r.config.name}/ | ${r.services.length} services | ${r.files.length} files (${m} machine)`, "", `  docker compose up / docker compose down`].join("\n");
    }

    case "csharp":
    case "dotnet":
    case "cs": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /csharp REST API with Entity Framework\n  /csharp Blazor app\n  /csharp CLI tool\n  /dotnet worker service";
      const { createCSharpProject } = await import("../../core/web-engine/stacks/csharp-engine.js");
      const r = createCSharpProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode C#/.NET Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  dotnet run / dotnet test`].join("\n");
    }

    case "kotlin":
    case "kt": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /kotlin API with Ktor\n  /kotlin Android app with Compose\n  /kotlin CLI tool\n  /kt library";
      const { createKotlinProject } = await import("../../core/web-engine/stacks/kotlin-engine.js");
      const r = createKotlinProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Kotlin Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  ./gradlew run / ./gradlew test`].join("\n");
    }

    case "php":
    case "laravel":
    case "symfony": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /php REST API with Slim\n  /php Laravel web app\n  /php CLI tool\n  /php WordPress plugin";
      const { createPhpProject } = await import("../../core/web-engine/stacks/php-engine.js");
      const r = createPhpProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode PHP Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  composer serve / composer test`].join("\n");
    }

    case "ruby":
    case "rb":
    case "rails":
    case "sinatra": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /ruby Sinatra API\n  /ruby CLI tool with Thor\n  /ruby gem library\n  /ruby Sidekiq worker";
      const { createRubyProject } = await import("../../core/web-engine/stacks/ruby-engine.js");
      const r = createRubyProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Ruby Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  bundle exec ruby app.rb / bundle exec rspec`].join("\n");
    }

    case "zig": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /zig CLI tool\n  /zig HTTP server\n  /zig library\n  /zig embedded firmware\n  /zig WASM module";
      const { createZigProject } = await import("../../core/web-engine/stacks/zig-engine.js");
      const r = createZigProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Zig Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  zig build run / zig build test`].join("\n");
    }

    case "elixir":
    case "ex":
    case "phoenix": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /elixir Phoenix API\n  /elixir LiveView app\n  /elixir CLI escript\n  /elixir GenServer worker";
      const { createElixirProject } = await import("../../core/web-engine/stacks/elixir-engine.js");
      const r = createElixirProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Elixir Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  mix run --no-halt / mix test`].join("\n");
    }

    case "dart":
    case "flutter": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /dart Flutter mobile app\n  /dart CLI tool\n  /dart server with shelf\n  /flutter iOS + Android app with Riverpod";
      const { createDartProject } = await import("../../core/web-engine/stacks/dart-engine.js");
      const r = createDartProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Dart/Flutter Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  ${r.config.type === "mobile" || r.config.type === "web" ? "flutter run" : "dart run"} / dart test`].join("\n");
    }

    case "lua":
    case "love2d": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /lua Love2D game\n  /lua Neovim plugin\n  /lua CLI script\n  /lua server with Lapis";
      const { createLuaProject } = await import("../../core/web-engine/stacks/lua-engine.js");
      const r = createLuaProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Lua Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  lua main.lua / busted`].join("\n");
    }

    case "haskell":
    case "hs": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /haskell API with Scotty\n  /haskell CLI tool\n  /hs library";
      const { createHaskellProject } = await import("../../core/web-engine/stacks/haskell-engine.js");
      const r = createHaskellProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Haskell Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  stack build / stack run / stack test`].join("\n");
    }

    case "scala": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /scala API with http4s\n  /scala Spark data pipeline\n  /scala CLI tool";
      const { createScalaProject } = await import("../../core/web-engine/stacks/scala-engine.js");
      const r = createScalaProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Scala Engine`, `    ${r.config.name}/ | ${r.config.type}${r.config.framework ? " (" + r.config.framework + ")" : ""} | ${r.files.length} files (${m} machine)`, "", `  sbt run / sbt test`].join("\n");
    }

    case "terraform":
    case "tf":
    case "iac":
    case "infra": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /terraform AWS VPC with RDS and S3\n  /tf Kubernetes deployment\n  /iac GCP Cloud Run service";
      const { createTerraformProject } = await import("../../core/web-engine/stacks/terraform-engine.js");
      const r = createTerraformProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Terraform Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, "", `  terraform init / terraform plan / terraform apply`].join("\n");
    }

    case "monorepo":
    case "turborepo":
    case "nx": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /monorepo web + API with shared lib\n  /turborepo Next.js frontend with Express API\n  /nx React + Node monorepo";
      const { createMonorepoProject } = await import("../../core/web-engine/stacks/monorepo-engine.js");
      const r = createMonorepoProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Monorepo Engine`, `    ${r.config.name}/ | ${r.config.tool} + ${r.config.packageManager} | ${r.config.packages.length} packages | ${r.files.length} files (${m} machine)`, "", `  ${r.config.packageManager} run dev / ${r.config.packageManager} run build`].join("\n");
    }

    case "cicd":
    case "ci":
    case "pipeline": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /cicd Node.js with deploy to Vercel\n  /ci Python with Docker\n  /pipeline Go with GitHub Actions";
      const { createCicdProject } = await import("../../core/web-engine/stacks/cicd-engine.js");
      const r = createCicdProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode CI/CD Engine`, `    ${r.config.name}/ | ${r.config.platform} | ${r.config.projectType} | ${r.files.length} files (${m} machine)`, `    Test: ${r.config.hasTest} | Lint: ${r.config.hasLint} | Deploy: ${r.config.hasDeploy}${r.config.deployTarget ? " → " + r.config.deployTarget : ""}`, "", `  git push (triggers pipeline)`].join("\n");
    }

    case "db":
    case "database":
    case "schema": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /db Postgres with users, products, orders\n  /db MongoDB with posts and comments\n  /db SQLite with tasks using Drizzle\n  /db MySQL with users and sessions using TypeORM";
      const { createDbProject } = await import("../../core/web-engine/stacks/db-engine.js");
      const r = createDbProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode Database Engine`, `    ${r.config.name}/ | ${r.config.type} + ${r.config.orm} | ${r.config.entities.length} entities | ${r.files.length} files (${m} machine)`, `    Entities: ${r.config.entities.map(e => e.name).join(", ")}`, `    Docker: ${r.config.hasDocker ? "yes" : "no"} | Backup: ${r.config.hasBackup ? "yes" : "no"}`, "", `  make up / npm run db:init / npm run db:seed`].join("\n");
    }

    case "css":
    case "design-system": {
      const desc = (args ?? "").trim();
      if (!desc) return "  Usage: /css design system with dark mode\n  /css component library called myui\n  /css Tailwind plugin for animations\n  /css animation library\n  /css Sass framework";
      const { createCssProject } = await import("../../core/web-engine/stacks/css-engine.js");
      const r = createCssProject(desc, appConfig.workingDirectory);
      const m = r.files.filter(f => !f.needsLlm).length;
      return [`  KCode CSS Engine`, `    ${r.config.name}/ | ${r.config.type} | ${r.files.length} files (${m} machine)`, `    Preprocessor: ${r.config.preprocessor} | Dark mode: ${r.config.darkMode ? "yes" : "no"}`, "", `  npm run dev / npm run build`].join("\n");
    }

    default:
      return null;
  }
}
