// KCode - Code analysis skills

import type { SkillDefinition } from "../builtin-skills";

export const codeSkills: SkillDefinition[] = [
  {
    name: "explain",
    description: "Explain code or concept",
    aliases: ["what"],
    args: ["code or file to explain"],
    template: `Explain the following in clear, concise terms: {{args}}`,
  },
  {
    name: "find-bug",
    description: "Find bugs in code",
    aliases: ["bug", "debug"],
    args: ["file or description"],
    template: `Analyze the following for potential bugs, edge cases, and issues: {{args}}. Look for: null/undefined errors, off-by-one errors, race conditions, resource leaks, missing error handling, security issues.`,
  },
  {
    name: "audit",
    description: "Forensic code audit — read files deeply, find real bugs with line numbers",
    aliases: ["review", "security-audit"],
    args: ["project path or specific files (optional)"],
    template: `You are now in FORENSIC AUDIT MODE. Your reputation depends on finding REAL bugs, not generating pretty reports.

**Target**: {{#if args}}{{args}}{{/if}}{{^if args}}the current working directory{{/if}}

**HARD RULES:**
- DO NOT call EnterPlanMode. Just read files and write the report.
- Create exactly ONE file: \`AUDIT_REPORT.md\`. Not five. Not an index, not a README, not a remediation companion. ONE.
- Every line number you cite MUST come from a file you actually Read in this session. Fabricated line numbers are worse than no audit.

**Mandatory methodology:**

1. **Map the project** (LS, find): entry points, main modules, external interfaces
2. **Read key files in full** — minimum 10 files covering:
   - Network I/O (sockets, HTTP, parsing)
   - Input parsing (HID, protocol decoders, deserializers)
   - Resource lifecycle (open/close, alloc/free)
   - Error handling paths
   - Authentication/authorization boundaries
3. **For EACH file read, check systematically:**
   - **Pointer arithmetic**: \`(&ptr)[n]\` vs \`ptr[n]\` vs \`ptr+n\` — verify intent
   - **Buffer indexing**: every \`buf[N]\` must have validated \`buf.size() >= N+1\`
   - **Integer signedness**: \`int\` returned where \`size_t\` used → potential exploit
   - **Unreachable code**: statements after \`return\` / \`throw\` / \`continue\`
   - **Resource leaks**: open() / socket() / malloc() without matching cleanup on ALL exit paths (error + happy path)
   - **TOCTOU**: check-then-use patterns with file paths, symlinks, FDs
   - **Integer overflow**: size calculations, loop bounds, allocations
   - **Signed comparison pitfalls**: \`size_t - size_t < 0\` always false
4. **Trace data flow**: external input → parse → consumption. Where are boundaries checked?
5. **Inspect compiler flags**: are warnings suppressed? which?

**Output format (mandatory)**:

For every finding:
\`\`\`
## 🔴/🟠/🟡 [SEVERITY] Short title — file:line
[Code snippet 3-8 lines]
**Why**: semantic explanation of the bug
**Fix**: minimal correct version
**Exploitability**: LOCAL/REMOTE/NONE, conditions required
\`\`\`

Group by severity: CRITICAL → HIGH → MEDIUM → LOW.

**Banned phrases** (these destroy audit credibility):
- "production-ready ★★★★★" without proving each star
- "no bugs found" after only running grep
- "strong security practices" without specific file:line evidence
- "RAII-compliant" without checking every open/close pair

**Minimum deliverables before concluding:**
- [ ] Read at least 10 source files in their entirety
- [ ] Examined every I/O parsing function in the project
- [ ] Checked every manual resource open/close pair
- [ ] Verified every claim of "safe" with specific file:line citation

If you couldn't find bugs after deep reading, say exactly which files you read and what you checked. Silence is better than a false clean bill of health.

**Your audit will be read by security-conscious engineers. Earn their trust with precision.**`,
  },
  {
    name: "scan",
    description:
      "Run the deterministic audit engine (pattern library + model verification). Produces AUDIT_REPORT.md.",
    aliases: ["audit-scan", "static-audit"],
    args: ["project path (default: cwd) [--skip-verify]"],
    template: `__builtin_scan__`,
  },
  {
    name: "fix",
    description: "Auto-fix findings from /scan (deterministic patches, no LLM needed)",
    aliases: ["autofix", "patch"],
    args: ["project path (default: cwd)"],
    template: `__builtin_fix__`,
  },
  {
    name: "pr",
    description: "Create a PR from /scan + /fix findings (branch, commit, detailed description via LLM)",
    aliases: ["pull-request", "submit"],
    args: ["project path (default: cwd) [--repo owner/repo]"],
    template: `__builtin_pr__`,
  },
  {
    name: "github",
    description: "GitHub authentication and status (login, status, whoami)",
    aliases: ["gh"],
    args: ["login | status | whoami"],
    template: `__builtin_github__`,
  },
  {
    name: "debug",
    description: "Machine-first debugging: gathers evidence (file, errors, git blame, tests) then LLM diagnoses",
    aliases: ["dbg", "fix-bug"],
    args: ["file path or error description"],
    template: `__builtin_debug__`,
  },
  {
    name: "web",
    description: "Create a complete website/web app (landing, SaaS, dashboard, blog, e-commerce)",
    aliases: ["create-site", "website", "webapp"],
    args: ["description of the site to create"],
    template: `__builtin_web__`,
  },
  {
    name: "api",
    description: "Create a REST API with CRUD routes, validation, and database",
    aliases: ["create-api", "backend", "rest-api"],
    args: ["entities (e.g., 'users, products, orders')"],
    template: `__builtin_api__`,
  },
  {
    name: "fullstack",
    description: "Create a full-stack app (frontend + API + database) in one command",
    aliases: ["create-app", "full-stack", "stack"],
    args: ["description of the app to create"],
    template: `__builtin_fullstack__`,
  },
  {
    name: "python",
    description: "Create a Python project (API, CLI, scraper, ML, data pipeline, bot, automation)",
    aliases: ["py", "create-python"],
    args: ["description of the project"],
    template: `__builtin_python__`,
  },
  {
    name: "cpp",
    description: "Create a C/C++ project (library, server, CLI, game, embedded, system) with CMake, tests, CI",
    aliases: ["c", "create-cpp", "create-c"],
    args: ["description of the project"],
    template: `__builtin_cpp__`,
  },
  {
    name: "rust",
    description: "Create a Rust project (CLI, API, library, WASM, game, system)",
    aliases: ["rs", "create-rust"],
    args: ["description"],
    template: `__builtin_rust__`,
  },
  {
    name: "go",
    description: "Create a Go project (CLI, API, gRPC, worker, microservice)",
    aliases: ["golang", "create-go"],
    args: ["description"],
    template: `__builtin_go__`,
  },
  {
    name: "swift",
    description: "Create a Swift project (iOS, macOS, CLI, server, package)",
    aliases: ["ios", "create-swift"],
    args: ["description"],
    template: `__builtin_swift__`,
  },
  {
    name: "java",
    description: "Create a Java project (API, CLI, microservice, library) with Spring Boot, Gradle, tests, CI",
    aliases: ["jvm", "create-java", "spring"],
    args: ["description of the project"],
    template: `__builtin_java__`,
  },
  {
    name: "node",
    description: "Create a Node.js/JavaScript project (CLI, library, worker, bot, script, lambda)",
    aliases: ["js", "create-node", "javascript"],
    args: ["description of the project"],
    template: `__builtin_node__`,
  },
  {
    name: "docker",
    description: "Create a Docker project (Compose stack, multi-service, with networking and volumes)",
    aliases: ["compose", "create-docker", "container"],
    args: ["description of the services/stack"],
    template: `__builtin_docker__`,
  },
  {
    name: "csharp",
    description: "Create a C#/.NET project (API, Blazor, CLI, library, worker, gRPC, MAUI)",
    aliases: ["dotnet", "create-csharp", "cs"],
    args: ["description of the project"],
    template: `__builtin_csharp__`,
  },
  {
    name: "kotlin",
    description: "Create a Kotlin project (API/Ktor, Android/Compose, CLI, library, multiplatform)",
    aliases: ["kt", "create-kotlin", "android"],
    args: ["description of the project"],
    template: `__builtin_kotlin__`,
  },
  {
    name: "php",
    description: "Create a PHP project (Slim/Laravel/Symfony API, CLI, library, WordPress plugin)",
    aliases: ["create-php", "laravel", "symfony"],
    args: ["description of the project"],
    template: `__builtin_php__`,
  },
  {
    name: "ruby",
    description: "Create a Ruby project (Sinatra/Rails API, CLI, gem, Sidekiq worker)",
    aliases: ["rb", "create-ruby", "rails", "sinatra"],
    args: ["description of the project"],
    template: `__builtin_ruby__`,
  },
  {
    name: "zig",
    description: "Create a Zig project (CLI, library, HTTP server, embedded, WASM, game)",
    aliases: ["create-zig"],
    args: ["description of the project"],
    template: `__builtin_zig__`,
  },
  {
    name: "elixir",
    description: "Create an Elixir project (Phoenix API, LiveView, CLI/escript, library, GenServer worker)",
    aliases: ["ex", "create-elixir", "phoenix"],
    args: ["description of the project"],
    template: `__builtin_elixir__`,
  },
  {
    name: "doc",
    description: "Generate documentation",
    aliases: ["document"],
    args: ["file or function"],
    template: `Generate or update documentation for: {{args}}. Follow the project's existing documentation style. Include usage examples where appropriate.`,
  },
  {
    name: "type",
    description: "Add or fix types",
    aliases: ["types"],
    args: ["file or function"],
    template: `Review and improve TypeScript types for: {{args}}. Add missing type annotations, fix any type errors, and ensure type safety. Use strict types, avoid 'any'.`,
  },
  {
    name: "depgraph",
    description: "Show import/export dependency tree for a file",
    aliases: ["deps-tree", "imports"],
    args: ["file path"],
    template: `__builtin_depgraph__`,
  },
  {
    name: "outline",
    description: "Show file structure (functions, classes, exports)",
    aliases: ["symbols", "structure"],
    args: ["file path"],
    template: `__builtin_outline__`,
  },
  {
    name: "security",
    description: "Security audit",
    aliases: ["sec-audit"],
    args: ["file or scope"],
    template: `Perform a security audit. {{#if args}}Focus on: {{args}}{{/if}}{{^if args}}Scan the project for common security vulnerabilities.{{/if}} Check for: injection vulnerabilities, hardcoded secrets, insecure dependencies, missing input validation, authentication issues.`,
  },
  {
    name: "security-review",
    description: "Scan code for security vulnerabilities",
    aliases: ["sec", "vuln"],
    args: ["file or directory path"],
    template: `Perform a thorough security review of the specified code.

Target: {{args}}

1. Read the target file(s) — if a directory, scan all source files.
2. Check for OWASP Top 10 vulnerabilities:
   - Injection (SQL, command, LDAP, XSS)
   - Broken authentication / session management
   - Sensitive data exposure (hardcoded secrets, API keys, passwords)
   - XXE (XML External Entities)
   - Broken access control
   - Security misconfiguration
   - Insecure deserialization
   - Using components with known vulnerabilities
   - Insufficient logging & monitoring
3. Check for language-specific issues:
   - TypeScript/JS: eval(), innerHTML, dangerouslySetInnerHTML, prototype pollution
   - Python: pickle, exec, shell=True, format string injection
   - Go: sql.Query with string concat, unsafe pointer use
4. Report findings with severity (CRITICAL/HIGH/MEDIUM/LOW), file:line, and fix recommendation.
5. If no issues found, confirm the code is clean.

Be thorough but avoid false positives. Only report real risks.`,
  },
];
