// KCode - Go Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GoProjectType = "cli" | "api" | "library" | "grpc" | "worker" | "microservice" | "custom";

interface GoConfig { name: string; type: GoProjectType; module: string; dependencies: string[]; framework?: string; }

function detectGoProject(msg: string): GoConfig {
  const lower = msg.toLowerCase();
  let type: GoProjectType = "cli";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:api|server|http|rest|gin|echo|fiber|chi)\b/i.test(lower)) {
    type = "api";
    if (/\bgin\b/i.test(lower)) { framework = "gin"; deps.push("github.com/gin-gonic/gin"); }
    else if (/\becho\b/i.test(lower)) { framework = "echo"; deps.push("github.com/labstack/echo/v4"); }
    else if (/\bfiber\b/i.test(lower)) { framework = "fiber"; deps.push("github.com/gofiber/fiber/v2"); }
    else { framework = "chi"; deps.push("github.com/go-chi/chi/v5", "github.com/go-chi/cors"); }
  }
  else if (/\b(?:grpc|protobuf|proto)\b/i.test(lower)) { type = "grpc"; deps.push("google.golang.org/grpc", "google.golang.org/protobuf"); }
  else if (/\b(?:worker|queue|job|consumer)\b/i.test(lower)) { type = "worker"; }
  else if (/\b(?:microservice|micro)\b/i.test(lower)) { type = "microservice"; deps.push("github.com/go-chi/chi/v5"); }
  else if (/\b(?:lib|library|package|pkg)\b/i.test(lower)) { type = "library"; }
  else { deps.push("github.com/spf13/cobra"); }

  if (/\b(?:sql|postgres|mysql|sqlite|database|db)\b/i.test(lower)) deps.push("github.com/jmoiron/sqlx", "github.com/mattn/go-sqlite3");
  if (/\b(?:redis)\b/i.test(lower)) deps.push("github.com/redis/go-redis/v9");
  if (/\b(?:mongo)\b/i.test(lower)) deps.push("go.mongodb.org/mongo-driver/v2");
  if (/\b(?:jwt|auth|token)\b/i.test(lower)) deps.push("github.com/golang-jwt/jwt/v5");
  if (/\b(?:log|zap|slog)\b/i.test(lower)) deps.push("go.uber.org/zap");
  if (/\b(?:docker|container)\b/i.test(lower)) deps.push("github.com/docker/docker");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, module: `github.com/user/${name}`, dependencies: [...new Set(deps)], framework };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }

export interface GoProjectResult { config: GoConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createGoProject(userRequest: string, cwd: string): GoProjectResult {
  const cfg = detectGoProject(userRequest);
  const files: GenFile[] = [];

  // go.mod
  files.push({ path: "go.mod", content: `module ${cfg.module}

go 1.23

require (
${cfg.dependencies.map(d => `\t${d} v0.0.0`).join("\n")}
)
`, needsLlm: false });

  // Main
  const mains: Record<string, string> = {
    cli: `package main

import (
\t"fmt"
\t"os"
)

func main() {
\tif len(os.Args) < 2 {
\t\tfmt.Fprintf(os.Stderr, "Usage: %s <command>\\n", os.Args[0])
\t\tos.Exit(1)
\t}

\t// TODO: implement CLI logic
\tfmt.Printf("${cfg.name} v0.1.0\\n")
}
`,
    api: cfg.framework === "gin" ? `package main

import (
\t"net/http"
\t"github.com/gin-gonic/gin"
)

func main() {
\tr := gin.Default()

\tr.GET("/health", func(c *gin.Context) {
\t\tc.JSON(http.StatusOK, gin.H{"status": "ok"})
\t})

\t// TODO: add routes

\tr.Run(":8080")
}
` : `package main

import (
\t"encoding/json"
\t"log"
\t"net/http"
\t"github.com/go-chi/chi/v5"
\t"github.com/go-chi/chi/v5/middleware"
\t"github.com/go-chi/cors"
)

func main() {
\tr := chi.NewRouter()
\tr.Use(middleware.Logger)
\tr.Use(middleware.Recoverer)
\tr.Use(cors.Handler(cors.Options{AllowedOrigins: []string{"*"}}))

\tr.Get("/health", func(w http.ResponseWriter, r *http.Request) {
\t\tjson.NewEncoder(w).Encode(map[string]string{"status": "ok"})
\t})

\t// TODO: add routes

\tlog.Printf("${cfg.name} listening on :8080")
\tlog.Fatal(http.ListenAndServe(":8080", r))
}
`,
    worker: `package main

import (
\t"context"
\t"fmt"
\t"os"
\t"os/signal"
\t"syscall"
\t"time"
)

func main() {
\tctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
\tdefer cancel()

\tfmt.Println("${cfg.name} worker started")

\tfor {
\t\tselect {
\t\tcase <-ctx.Done():
\t\t\tfmt.Println("\\nShutdown")
\t\t\treturn
\t\tdefault:
\t\t\t// TODO: process jobs
\t\t\ttime.Sleep(time.Second)
\t\t}
\t}
}
`,
    library: `// Package ${cfg.name} provides ...
package ${cfg.name.replace(/-/g, "")}

import "fmt"

// ${cap(cfg.name)} is the main type.
type ${cap(cfg.name)} struct {
\tinitialized bool
}

// New creates a new instance.
func New() *${cap(cfg.name)} {
\treturn &${cap(cfg.name)}{}
}

// Init initializes the instance.
func (m *${cap(cfg.name)}) Init() error {
\t// TODO: setup
\tm.initialized = true
\treturn nil
}

// Run executes the main logic.
func (m *${cap(cfg.name)}) Run() error {
\tif !m.initialized {
\t\treturn fmt.Errorf("not initialized")
\t}
\t// TODO: main logic
\treturn nil
}
`,
  };

  const isLib = cfg.type === "library";
  files.push({ path: isLib ? `${cfg.name.replace(/-/g, "")}.go` : "main.go", content: mains[cfg.type] ?? mains["cli"]!, needsLlm: true });

  // Test
  files.push({ path: isLib ? `${cfg.name.replace(/-/g, "")}_test.go` : "main_test.go", content: isLib ? `package ${cfg.name.replace(/-/g, "")}

import "testing"

func TestNew(t *testing.T) {
\tm := New()
\tif m == nil {
\t\tt.Fatal("New() returned nil")
\t}
}

func TestInitAndRun(t *testing.T) {
\tm := New()
\tif err := m.Init(); err != nil {
\t\tt.Fatalf("Init() error: %v", err)
\t}
\tif err := m.Run(); err != nil {
\t\tt.Fatalf("Run() error: %v", err)
\t}
}

func TestRunWithoutInit(t *testing.T) {
\tm := New()
\tif err := m.Run(); err == nil {
\t\tt.Fatal("Run() should fail without Init()")
\t}
}
` : `package main

import "testing"

func TestBasic(t *testing.T) {
\t// TODO: add tests
}
`, needsLlm: true });

  // Extras
  files.push({ path: ".gitignore", content: `bin/\n*.exe\n.env\ntmp/\n`, needsLlm: false });
  files.push({ path: "Makefile", content: `build:\n\tgo build -o bin/${cfg.name} ${isLib ? "." : "."}\n\ntest:\n\tgo test -v -race ./...\n\nlint:\n\tgo vet ./...\n\tgolangci-lint run\n\nrun:\n\tgo run ${isLib ? "." : "."}\n`, needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM golang:1.23-alpine AS builder\nWORKDIR /app\nCOPY go.* ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /bin/${cfg.name}\n\nFROM alpine:3.20\nCOPY --from=builder /bin/${cfg.name} /usr/local/bin/\nENTRYPOINT ["${cfg.name}"]\n`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-go@v5\n        with: { go-version: "1.23" }\n      - run: go test -v -race ./...\n      - run: go vet ./...\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nBuilt with KCode.\n\n\`\`\`bash\nmake build\nmake test\nmake run\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  const l = files.filter(f => f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement a Go ${cfg.type}. ${m} files machine, ${l} for LLM. USER: "${userRequest}"` };
}

function cap(s: string): string { return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(""); }
