// KCode - Go Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GoProjectType =
  | "cli"
  | "api"
  | "library"
  | "grpc"
  | "worker"
  | "microservice"
  | "custom";

interface GoConfig {
  name: string;
  type: GoProjectType;
  module: string;
  dependencies: string[];
  framework?: string;
}

function detectGoProject(msg: string): GoConfig {
  const lower = msg.toLowerCase();
  let type: GoProjectType = "cli";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:api|server|http|rest|gin|echo|fiber|chi)\b/i.test(lower)) {
    type = "api";
    if (/\bgin\b/i.test(lower)) {
      framework = "gin";
      deps.push("github.com/gin-gonic/gin");
    } else if (/\becho\b/i.test(lower)) {
      framework = "echo";
      deps.push("github.com/labstack/echo/v4");
    } else if (/\bfiber\b/i.test(lower)) {
      framework = "fiber";
      deps.push("github.com/gofiber/fiber/v2");
    } else {
      framework = "chi";
      deps.push("github.com/go-chi/chi/v5", "github.com/go-chi/cors");
    }
  } else if (/\b(?:grpc|protobuf|proto)\b/i.test(lower)) {
    type = "grpc";
    deps.push("google.golang.org/grpc", "google.golang.org/protobuf");
  } else if (/\b(?:worker|queue|job|consumer)\b/i.test(lower)) {
    type = "worker";
  } else if (/\b(?:microservice|micro)\b/i.test(lower)) {
    type = "microservice";
    deps.push("github.com/go-chi/chi/v5");
  } else if (/\b(?:lib|library|package|pkg)\b/i.test(lower)) {
    type = "library";
  } else {
    deps.push("github.com/spf13/cobra");
  }

  if (/\b(?:sql|postgres|mysql|sqlite|database|db)\b/i.test(lower))
    deps.push("github.com/jmoiron/sqlx", "github.com/mattn/go-sqlite3");
  if (/\b(?:redis)\b/i.test(lower)) deps.push("github.com/redis/go-redis/v9");
  if (/\b(?:mongo)\b/i.test(lower)) deps.push("go.mongodb.org/mongo-driver/v2");
  if (/\b(?:jwt|auth|token)\b/i.test(lower)) deps.push("github.com/golang-jwt/jwt/v5");
  if (/\b(?:log|zap|slog)\b/i.test(lower)) deps.push("go.uber.org/zap");
  if (/\b(?:docker|container)\b/i.test(lower)) deps.push("github.com/docker/docker");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return {
    name,
    type,
    module: `github.com/user/${name}`,
    dependencies: [...new Set(deps)],
    framework,
  };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}

export interface GoProjectResult {
  config: GoConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createGoProject(userRequest: string, cwd: string): GoProjectResult {
  const cfg = detectGoProject(userRequest);
  const files: GenFile[] = [];

  // go.mod
  files.push({
    path: "go.mod",
    content: `module ${cfg.module}

go 1.23

require (
${cfg.dependencies.map((d) => `\t${d} v0.0.0`).join("\n")}
)
`,
    needsLlm: false,
  });

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
    api:
      cfg.framework === "gin"
        ? `package main

import (
\t"context"
\t"crypto/rand"
\t"encoding/hex"
\t"log/slog"
\t"net/http"
\t"os"
\t"os/signal"
\t"strings"
\t"sync"
\t"syscall"
\t"time"

\t"github.com/gin-gonic/gin"
)

// Item represents a resource in the API.
type Item struct {
\tID          string ${"`"}json:"id"${"`"}
\tName        string ${"`"}json:"name"${"`"}
\tDescription string ${"`"}json:"description"${"`"}
\tCreatedAt   string ${"`"}json:"created_at"${"`"}
}

type createItemRequest struct {
\tName        string ${"`"}json:"name"${"`"}
\tDescription string ${"`"}json:"description"${"`"}
}

type updateItemRequest struct {
\tName        string ${"`"}json:"name"${"`"}
\tDescription string ${"`"}json:"description"${"`"}
}

// ItemStore is a thread-safe in-memory store.
type ItemStore struct {
\tmu    sync.RWMutex
\titems []Item
}

func NewItemStore() *ItemStore {
\treturn &ItemStore{items: []Item{}}
}

func (s *ItemStore) List() []Item {
\ts.mu.RLock()
\tdefer s.mu.RUnlock()
\tout := make([]Item, len(s.items))
\tcopy(out, s.items)
\treturn out
}

func (s *ItemStore) GetByID(id string) (Item, bool) {
\ts.mu.RLock()
\tdefer s.mu.RUnlock()
\tfor _, item := range s.items {
\t\tif item.ID == id {
\t\t\treturn item, true
\t\t}
\t}
\treturn Item{}, false
}

func (s *ItemStore) Create(name, description string) Item {
\ts.mu.Lock()
\tdefer s.mu.Unlock()
\titem := Item{
\t\tID:          generateID(),
\t\tName:        name,
\t\tDescription: description,
\t\tCreatedAt:   time.Now().UTC().Format(time.RFC3339),
\t}
\ts.items = append(s.items, item)
\treturn item
}

func (s *ItemStore) Update(id, name, description string) (Item, bool) {
\ts.mu.Lock()
\tdefer s.mu.Unlock()
\tfor i, item := range s.items {
\t\tif item.ID == id {
\t\t\ts.items[i].Name = name
\t\t\ts.items[i].Description = description
\t\t\treturn s.items[i], true
\t\t}
\t}
\treturn Item{}, false
}

func (s *ItemStore) Delete(id string) bool {
\ts.mu.Lock()
\tdefer s.mu.Unlock()
\tfor i, item := range s.items {
\t\tif item.ID == id {
\t\t\ts.items = append(s.items[:i], s.items[i+1:]...)
\t\t\treturn true
\t\t}
\t}
\treturn false
}

func generateID() string {
\tb := make([]byte, 8)
\trand.Read(b)
\treturn hex.EncodeToString(b)
}

func envOrDefault(key, fallback string) string {
\tif v := os.Getenv(key); v != "" {
\t\treturn v
\t}
\treturn fallback
}

func errorResponse(c *gin.Context, status int, msg string) {
\tc.JSON(status, gin.H{"error": msg})
}

func requestIDMiddleware() gin.HandlerFunc {
\treturn func(c *gin.Context) {
\t\tid := c.GetHeader("X-Request-ID")
\t\tif id == "" {
\t\t\tid = generateID()
\t\t}
\t\tc.Set("request_id", id)
\t\tc.Header("X-Request-ID", id)
\t\tc.Next()
\t}
}

func corsMiddleware() gin.HandlerFunc {
\treturn func(c *gin.Context) {
\t\tc.Header("Access-Control-Allow-Origin", "*")
\t\tc.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
\t\tc.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID")
\t\tif c.Request.Method == "OPTIONS" {
\t\t\tc.AbortWithStatus(http.StatusNoContent)
\t\t\treturn
\t\t}
\t\tc.Next()
\t}
}

func main() {
\tlogLevel := slog.LevelInfo
\tif envOrDefault("LOG_LEVEL", "info") == "debug" {
\t\tlogLevel = slog.LevelDebug
\t}
\tlogger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
\tslog.SetDefault(logger)

\tport := envOrDefault("PORT", "10080")
\tstore := NewItemStore()

\tgin.SetMode(gin.ReleaseMode)
\tr := gin.New()
\tr.Use(gin.Recovery())
\tr.Use(requestIDMiddleware())
\tr.Use(corsMiddleware())

\tr.GET("/health", func(c *gin.Context) {
\t\tc.JSON(http.StatusOK, gin.H{"status": "ok", "service": "${cfg.name}"})
\t})

\tr.GET("/items", func(c *gin.Context) {
\t\tc.JSON(http.StatusOK, store.List())
\t})

\tr.GET("/items/:id", func(c *gin.Context) {
\t\titem, ok := store.GetByID(c.Param("id"))
\t\tif !ok {
\t\t\terrorResponse(c, http.StatusNotFound, "item not found")
\t\t\treturn
\t\t}
\t\tc.JSON(http.StatusOK, item)
\t})

\tr.POST("/items", func(c *gin.Context) {
\t\tvar req createItemRequest
\t\tif err := c.ShouldBindJSON(&req); err != nil {
\t\t\terrorResponse(c, http.StatusBadRequest, "invalid JSON body")
\t\t\treturn
\t\t}
\t\tif strings.TrimSpace(req.Name) == "" {
\t\t\terrorResponse(c, http.StatusBadRequest, "name is required")
\t\t\treturn
\t\t}
\t\titem := store.Create(strings.TrimSpace(req.Name), strings.TrimSpace(req.Description))
\t\tslog.Info("item created", "id", item.ID, "name", item.Name)
\t\tc.JSON(http.StatusCreated, item)
\t})

\tr.PUT("/items/:id", func(c *gin.Context) {
\t\tvar req updateItemRequest
\t\tif err := c.ShouldBindJSON(&req); err != nil {
\t\t\terrorResponse(c, http.StatusBadRequest, "invalid JSON body")
\t\t\treturn
\t\t}
\t\tif strings.TrimSpace(req.Name) == "" {
\t\t\terrorResponse(c, http.StatusUnprocessableEntity, "name is required for PUT")
\t\t\treturn
\t\t}
\t\titem, ok := store.Update(c.Param("id"), strings.TrimSpace(req.Name), strings.TrimSpace(req.Description))
\t\tif !ok {
\t\t\terrorResponse(c, http.StatusNotFound, "item not found")
\t\t\treturn
\t\t}
\t\tslog.Info("item updated", "id", item.ID)
\t\tc.JSON(http.StatusOK, item)
\t})

\tr.DELETE("/items/:id", func(c *gin.Context) {
\t\tif !store.Delete(c.Param("id")) {
\t\t\terrorResponse(c, http.StatusNotFound, "item not found")
\t\t\treturn
\t\t}
\t\tslog.Info("item deleted", "id", c.Param("id"))
\t\tc.Status(http.StatusNoContent)
\t})

\tsrv := &http.Server{Addr: ":" + port, Handler: r}

\tgo func() {
\t\tslog.Info("${cfg.name} starting", "port", port)
\t\tif err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
\t\t\tslog.Error("server error", "err", err)
\t\t\tos.Exit(1)
\t\t}
\t}()

\tquit := make(chan os.Signal, 1)
\tsignal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
\t<-quit

\tslog.Info("shutting down gracefully...")
\tctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
\tdefer cancel()
\tif err := srv.Shutdown(ctx); err != nil {
\t\tslog.Error("forced shutdown", "err", err)
\t}
\tslog.Info("server stopped")
}
`
        : `package main

import (
\t"context"
\t"crypto/rand"
\t"encoding/hex"
\t"encoding/json"
\t"log/slog"
\t"net/http"
\t"os"
\t"os/signal"
\t"strings"
\t"sync"
\t"syscall"
\t"time"

\t"github.com/go-chi/chi/v5"
\t"github.com/go-chi/chi/v5/middleware"
\t"github.com/go-chi/cors"
)

// Item represents a resource in the API.
type Item struct {
\tID          string ${"`"}json:"id"${"`"}
\tName        string ${"`"}json:"name"${"`"}
\tDescription string ${"`"}json:"description"${"`"}
\tCreatedAt   string ${"`"}json:"created_at"${"`"}
}

type createItemRequest struct {
\tName        string ${"`"}json:"name"${"`"}
\tDescription string ${"`"}json:"description"${"`"}
}

type updateItemRequest struct {
\tName        string ${"`"}json:"name"${"`"}
\tDescription string ${"`"}json:"description"${"`"}
}

// ItemStore is a thread-safe in-memory store.
type ItemStore struct {
\tmu    sync.RWMutex
\titems []Item
}

func NewItemStore() *ItemStore {
\treturn &ItemStore{items: []Item{}}
}

func (s *ItemStore) List() []Item {
\ts.mu.RLock()
\tdefer s.mu.RUnlock()
\tout := make([]Item, len(s.items))
\tcopy(out, s.items)
\treturn out
}

func (s *ItemStore) GetByID(id string) (Item, bool) {
\ts.mu.RLock()
\tdefer s.mu.RUnlock()
\tfor _, item := range s.items {
\t\tif item.ID == id {
\t\t\treturn item, true
\t\t}
\t}
\treturn Item{}, false
}

func (s *ItemStore) Create(name, description string) Item {
\ts.mu.Lock()
\tdefer s.mu.Unlock()
\titem := Item{
\t\tID:          generateID(),
\t\tName:        name,
\t\tDescription: description,
\t\tCreatedAt:   time.Now().UTC().Format(time.RFC3339),
\t}
\ts.items = append(s.items, item)
\treturn item
}

func (s *ItemStore) Update(id, name, description string) (Item, bool) {
\ts.mu.Lock()
\tdefer s.mu.Unlock()
\tfor i, item := range s.items {
\t\tif item.ID == id {
\t\t\ts.items[i].Name = name
\t\t\ts.items[i].Description = description
\t\t\treturn s.items[i], true
\t\t}
\t}
\treturn Item{}, false
}

func (s *ItemStore) Delete(id string) bool {
\ts.mu.Lock()
\tdefer s.mu.Unlock()
\tfor i, item := range s.items {
\t\tif item.ID == id {
\t\t\ts.items = append(s.items[:i], s.items[i+1:]...)
\t\t\treturn true
\t\t}
\t}
\treturn false
}

func generateID() string {
\tb := make([]byte, 8)
\trand.Read(b)
\treturn hex.EncodeToString(b)
}

func envOrDefault(key, fallback string) string {
\tif v := os.Getenv(key); v != "" {
\t\treturn v
\t}
\treturn fallback
}

func writeJSON(w http.ResponseWriter, status int, v any) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\tjson.NewEncoder(w).Encode(v)
}

func errorResponse(w http.ResponseWriter, status int, msg string) {
\twriteJSON(w, status, map[string]string{"error": msg})
}

type contextKey struct{}

func requestIDMiddleware(next http.Handler) http.Handler {
\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tid := r.Header.Get("X-Request-ID")
\t\tif id == "" {
\t\t\tid = generateID()
\t\t}
\t\tw.Header().Set("X-Request-ID", id)
\t\tctx := context.WithValue(r.Context(), contextKey{}, id)
\t\tnext.ServeHTTP(w, r.WithContext(ctx))
\t})
}

func main() {
\tlogLevel := slog.LevelInfo
\tif envOrDefault("LOG_LEVEL", "info") == "debug" {
\t\tlogLevel = slog.LevelDebug
\t}
\tlogger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
\tslog.SetDefault(logger)

\tport := envOrDefault("PORT", "10080")
\tstore := NewItemStore()

\tr := chi.NewRouter()
\tr.Use(requestIDMiddleware)
\tr.Use(middleware.Logger)
\tr.Use(middleware.Recoverer)
\tr.Use(cors.Handler(cors.Options{
\t\tAllowedOrigins:   []string{"*"},
\t\tAllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
\t\tAllowedHeaders:   []string{"Content-Type", "Authorization", "X-Request-ID"},
\t\tMaxAge:           300,
\t}))

\tr.Get("/health", func(w http.ResponseWriter, r *http.Request) {
\t\twriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "${cfg.name}"})
\t})

\tr.Route("/items", func(r chi.Router) {
\t\tr.Get("/", func(w http.ResponseWriter, r *http.Request) {
\t\t\twriteJSON(w, http.StatusOK, store.List())
\t\t})

\t\tr.Post("/", func(w http.ResponseWriter, r *http.Request) {
\t\t\tvar req createItemRequest
\t\t\tif err := json.NewDecoder(r.Body).Decode(&req); err != nil {
\t\t\t\terrorResponse(w, http.StatusBadRequest, "invalid JSON body")
\t\t\t\treturn
\t\t\t}
\t\t\tif strings.TrimSpace(req.Name) == "" {
\t\t\t\terrorResponse(w, http.StatusBadRequest, "name is required")
\t\t\t\treturn
\t\t\t}
\t\t\titem := store.Create(strings.TrimSpace(req.Name), strings.TrimSpace(req.Description))
\t\t\tslog.Info("item created", "id", item.ID, "name", item.Name)
\t\t\twriteJSON(w, http.StatusCreated, item)
\t\t})

\t\tr.Get("/{id}", func(w http.ResponseWriter, r *http.Request) {
\t\t\tid := chi.URLParam(r, "id")
\t\t\titem, ok := store.GetByID(id)
\t\t\tif !ok {
\t\t\t\terrorResponse(w, http.StatusNotFound, "item not found")
\t\t\t\treturn
\t\t\t}
\t\t\twriteJSON(w, http.StatusOK, item)
\t\t})

\t\tr.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
\t\t\tid := chi.URLParam(r, "id")
\t\t\tvar req updateItemRequest
\t\t\tif err := json.NewDecoder(r.Body).Decode(&req); err != nil {
\t\t\t\terrorResponse(w, http.StatusBadRequest, "invalid JSON body")
\t\t\t\treturn
\t\t\t}
\t\t\tif strings.TrimSpace(req.Name) == "" {
\t\t\t\terrorResponse(w, http.StatusUnprocessableEntity, "name is required for PUT")
\t\t\t\treturn
\t\t\t}
\t\t\titem, ok := store.Update(id, strings.TrimSpace(req.Name), strings.TrimSpace(req.Description))
\t\t\tif !ok {
\t\t\t\terrorResponse(w, http.StatusNotFound, "item not found")
\t\t\t\treturn
\t\t\t}
\t\t\tslog.Info("item updated", "id", item.ID)
\t\t\twriteJSON(w, http.StatusOK, item)
\t\t})

\t\tr.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
\t\t\tid := chi.URLParam(r, "id")
\t\t\tif !store.Delete(id) {
\t\t\t\terrorResponse(w, http.StatusNotFound, "item not found")
\t\t\t\treturn
\t\t\t}
\t\t\tslog.Info("item deleted", "id", id)
\t\t\tw.WriteHeader(http.StatusNoContent)
\t\t})
\t})

\tsrv := &http.Server{Addr: ":" + port, Handler: r}

\tgo func() {
\t\tslog.Info("${cfg.name} starting", "port", port)
\t\tif err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
\t\t\tslog.Error("server error", "err", err)
\t\t\tos.Exit(1)
\t\t}
\t}()

\tquit := make(chan os.Signal, 1)
\tsignal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
\t<-quit

\tslog.Info("shutting down gracefully...")
\tctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
\tdefer cancel()
\tif err := srv.Shutdown(ctx); err != nil {
\t\tslog.Error("forced shutdown", "err", err)
\t}
\tslog.Info("server stopped")
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
  const isApi = cfg.type === "api";
  files.push({
    path: isLib ? `${cfg.name.replace(/-/g, "")}.go` : "main.go",
    content: mains[cfg.type] ?? mains["cli"]!,
    needsLlm: !isApi,
  });

  // Test
  files.push({
    path: isLib ? `${cfg.name.replace(/-/g, "")}_test.go` : "main_test.go",
    content: isLib
      ? `package ${cfg.name.replace(/-/g, "")}

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
`
      : isApi
        ? `package main

import (
\t"bytes"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"strings"
\t"testing"

\t"github.com/go-chi/chi/v5"
\t"github.com/go-chi/chi/v5/middleware"
)

func setupRouter() (*ItemStore, *chi.Mux) {
\tstore := NewItemStore()
\tr := chi.NewRouter()
\tr.Use(middleware.Logger)
\tr.Use(middleware.Recoverer)

\tr.Get("/health", func(w http.ResponseWriter, r *http.Request) {
\t\twriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "test"})
\t})

\tr.Route("/items", func(r chi.Router) {
\t\tr.Get("/", func(w http.ResponseWriter, r *http.Request) {
\t\t\twriteJSON(w, http.StatusOK, store.List())
\t\t})

\t\tr.Post("/", func(w http.ResponseWriter, r *http.Request) {
\t\t\tvar req createItemRequest
\t\t\tif err := json.NewDecoder(r.Body).Decode(&req); err != nil {
\t\t\t\terrorResponse(w, http.StatusBadRequest, "invalid JSON body")
\t\t\t\treturn
\t\t\t}
\t\t\tif strings.TrimSpace(req.Name) == "" {
\t\t\t\terrorResponse(w, http.StatusBadRequest, "name is required")
\t\t\t\treturn
\t\t\t}
\t\t\titem := store.Create(strings.TrimSpace(req.Name), strings.TrimSpace(req.Description))
\t\t\twriteJSON(w, http.StatusCreated, item)
\t\t})

\t\tr.Get("/{id}", func(w http.ResponseWriter, r *http.Request) {
\t\t\tid := chi.URLParam(r, "id")
\t\t\titem, ok := store.GetByID(id)
\t\t\tif !ok {
\t\t\t\terrorResponse(w, http.StatusNotFound, "item not found")
\t\t\t\treturn
\t\t\t}
\t\t\twriteJSON(w, http.StatusOK, item)
\t\t})

\t\tr.Put("/{id}", func(w http.ResponseWriter, r *http.Request) {
\t\t\tid := chi.URLParam(r, "id")
\t\t\tvar req updateItemRequest
\t\t\tif err := json.NewDecoder(r.Body).Decode(&req); err != nil {
\t\t\t\terrorResponse(w, http.StatusBadRequest, "invalid JSON body")
\t\t\t\treturn
\t\t\t}
\t\t\tif strings.TrimSpace(req.Name) == "" {
\t\t\t\terrorResponse(w, http.StatusUnprocessableEntity, "name is required for PUT")
\t\t\t\treturn
\t\t\t}
\t\t\titem, ok := store.Update(id, strings.TrimSpace(req.Name), strings.TrimSpace(req.Description))
\t\t\tif !ok {
\t\t\t\terrorResponse(w, http.StatusNotFound, "item not found")
\t\t\t\treturn
\t\t\t}
\t\t\twriteJSON(w, http.StatusOK, item)
\t\t})

\t\tr.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
\t\t\tid := chi.URLParam(r, "id")
\t\t\tif !store.Delete(id) {
\t\t\t\terrorResponse(w, http.StatusNotFound, "item not found")
\t\t\t\treturn
\t\t\t}
\t\t\tw.WriteHeader(http.StatusNoContent)
\t\t})
\t})

\treturn store, r
}

func TestHealthEndpoint(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\tresp, err := http.Get(ts.URL + "/health")
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", resp.StatusCode)
\t}

\tvar body map[string]string
\tjson.NewDecoder(resp.Body).Decode(&body)
\tif body["status"] != "ok" {
\t\tt.Fatalf("expected status ok, got %s", body["status"])
\t}
}

func TestPostItem(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\tpayload := bytes.NewBufferString(${'`{"name":"Test Item","description":"A test"}`'})
\tresp, err := http.Post(ts.URL+"/items", "application/json", payload)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusCreated {
\t\tt.Fatalf("expected 201, got %d", resp.StatusCode)
\t}

\tvar item Item
\tjson.NewDecoder(resp.Body).Decode(&item)
\tif item.Name != "Test Item" {
\t\tt.Fatalf("expected name 'Test Item', got %q", item.Name)
\t}
\tif item.ID == "" {
\t\tt.Fatal("expected non-empty ID")
\t}
}

func TestPostItemEmptyNameRejected(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\tpayload := bytes.NewBufferString(${'`{"name":"  ","description":"bad"}`'})
\tresp, err := http.Post(ts.URL+"/items", "application/json", payload)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusBadRequest {
\t\tt.Fatalf("expected 400, got %d", resp.StatusCode)
\t}
}

func TestGetItems(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\t// Empty list
\tresp, err := http.Get(ts.URL + "/items")
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", resp.StatusCode)
\t}

\tvar items []Item
\tjson.NewDecoder(resp.Body).Decode(&items)
\tif len(items) != 0 {
\t\tt.Fatalf("expected 0 items, got %d", len(items))
\t}
}

func TestGetItemByID(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\t// Create
\tpayload := bytes.NewBufferString(${'`{"name":"Lookup Test","description":"find me"}`'})
\tcreateResp, _ := http.Post(ts.URL+"/items", "application/json", payload)
\tvar created Item
\tjson.NewDecoder(createResp.Body).Decode(&created)
\tcreateResp.Body.Close()

\t// Get by ID
\tresp, err := http.Get(ts.URL + "/items/" + created.ID)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", resp.StatusCode)
\t}

\tvar found Item
\tjson.NewDecoder(resp.Body).Decode(&found)
\tif found.Name != "Lookup Test" {
\t\tt.Fatalf("expected 'Lookup Test', got %q", found.Name)
\t}
}

func TestGetItemNotFound(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\tresp, err := http.Get(ts.URL + "/items/nonexistent")
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusNotFound {
\t\tt.Fatalf("expected 404, got %d", resp.StatusCode)
\t}
}

func TestPutItem(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\t// Create
\tpayload := bytes.NewBufferString(${'`{"name":"Original","description":"original desc"}`'})
\tcreateResp, _ := http.Post(ts.URL+"/items", "application/json", payload)
\tvar created Item
\tjson.NewDecoder(createResp.Body).Decode(&created)
\tcreateResp.Body.Close()

\t// PUT update
\tupdatePayload := bytes.NewBufferString(${'`{"name":"Updated","description":"new desc"}`'})
\treq, _ := http.NewRequest(http.MethodPut, ts.URL+"/items/"+created.ID, updatePayload)
\treq.Header.Set("Content-Type", "application/json")
\tresp, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", resp.StatusCode)
\t}

\tvar updated Item
\tjson.NewDecoder(resp.Body).Decode(&updated)
\tif updated.Name != "Updated" {
\t\tt.Fatalf("expected name 'Updated', got %q", updated.Name)
\t}
\tif updated.Description != "new desc" {
\t\tt.Fatalf("expected description 'new desc', got %q", updated.Description)
\t}
}

func TestPutItemEmptyNameRejected(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\t// Create
\tpayload := bytes.NewBufferString(${'`{"name":"Original","description":"desc"}`'})
\tcreateResp, _ := http.Post(ts.URL+"/items", "application/json", payload)
\tvar created Item
\tjson.NewDecoder(createResp.Body).Decode(&created)
\tcreateResp.Body.Close()

\t// PUT with empty name
\tupdatePayload := bytes.NewBufferString(${'`{"name":"","description":"new desc"}`'})
\treq, _ := http.NewRequest(http.MethodPut, ts.URL+"/items/"+created.ID, updatePayload)
\treq.Header.Set("Content-Type", "application/json")
\tresp, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusUnprocessableEntity {
\t\tt.Fatalf("expected 422, got %d", resp.StatusCode)
\t}
}

func TestDeleteItem(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\t// Create
\tpayload := bytes.NewBufferString(${'`{"name":"To Delete","description":"delete me"}`'})
\tcreateResp, _ := http.Post(ts.URL+"/items", "application/json", payload)
\tvar created Item
\tjson.NewDecoder(createResp.Body).Decode(&created)
\tcreateResp.Body.Close()

\t// DELETE
\treq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/items/"+created.ID, nil)
\tresp, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusNoContent {
\t\tt.Fatalf("expected 204, got %d", resp.StatusCode)
\t}

\t// Verify deleted
\tgetResp, _ := http.Get(ts.URL + "/items/" + created.ID)
\tdefer getResp.Body.Close()
\tif getResp.StatusCode != http.StatusNotFound {
\t\tt.Fatalf("expected 404 after delete, got %d", getResp.StatusCode)
\t}
}

func TestDeleteItemNotFound(t *testing.T) {
\t_, router := setupRouter()
\tts := httptest.NewServer(router)
\tdefer ts.Close()

\treq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/items/nonexistent", nil)
\tresp, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()

\tif resp.StatusCode != http.StatusNotFound {
\t\tt.Fatalf("expected 404, got %d", resp.StatusCode)
\t}
}

func TestItemStore_CRUD(t *testing.T) {
\tstore := NewItemStore()

\t// List empty
\titems := store.List()
\tif len(items) != 0 {
\t\tt.Fatalf("expected 0 items, got %d", len(items))
\t}

\t// Create
\titem := store.Create("Test Item", "A test description")
\tif item.Name != "Test Item" {
\t\tt.Fatalf("expected name 'Test Item', got %q", item.Name)
\t}
\tif item.ID == "" {
\t\tt.Fatal("expected non-empty ID")
\t}

\t// Get by ID
\tfound, ok := store.GetByID(item.ID)
\tif !ok {
\t\tt.Fatal("expected to find item by ID")
\t}
\tif found.Name != "Test Item" {
\t\tt.Fatalf("expected name 'Test Item', got %q", found.Name)
\t}

\t// Get missing
\t_, ok = store.GetByID("nonexistent")
\tif ok {
\t\tt.Fatal("expected not to find nonexistent item")
\t}

\t// Update
\tupdated, ok := store.Update(item.ID, "Updated", "New desc")
\tif !ok {
\t\tt.Fatal("expected update to succeed")
\t}
\tif updated.Name != "Updated" {
\t\tt.Fatalf("expected name 'Updated', got %q", updated.Name)
\t}

\t// Delete
\tif !store.Delete(item.ID) {
\t\tt.Fatal("expected delete to succeed")
\t}
\tif store.Delete(item.ID) {
\t\tt.Fatal("expected second delete to fail")
\t}
}

func TestGenerateID(t *testing.T) {
\tid1 := generateID()
\tid2 := generateID()
\tif id1 == "" || id2 == "" {
\t\tt.Fatal("generated ID should not be empty")
\t}
\tif id1 == id2 {
\t\tt.Fatal("generated IDs should be unique")
\t}
\tif len(id1) != 16 {
\t\tt.Fatalf("expected 16-char hex ID, got %d chars", len(id1))
\t}
}

func TestEnvOrDefault(t *testing.T) {
\tval := envOrDefault("KCODE_TEST_NONEXISTENT_VAR", "fallback")
\tif val != "fallback" {
\t\tt.Fatalf("expected 'fallback', got %q", val)
\t}
}
`
        : `package main

import "testing"

func TestBasic(t *testing.T) {
\t// TODO: add tests
}
`,
    needsLlm: isApi ? false : true,
  });

  // Extras
  files.push({ path: ".gitignore", content: `bin/\n*.exe\n.env\ntmp/\n`, needsLlm: false });
  files.push({
    path: "Makefile",
    content: `build:\n\tgo build -o bin/${cfg.name} ${isLib ? "." : "."}\n\ntest:\n\tgo test -v -race ./...\n\nlint:\n\tgo vet ./...\n\tgolangci-lint run\n\nrun:\n\tgo run ${isLib ? "." : "."}\n`,
    needsLlm: false,
  });
  files.push({
    path: "Dockerfile",
    content: `FROM golang:1.23-alpine AS builder\nWORKDIR /app\nCOPY go.* ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /bin/${cfg.name}\n\nFROM alpine:3.20\nCOPY --from=builder /bin/${cfg.name} /usr/local/bin/\nENTRYPOINT ["${cfg.name}"]\n`,
    needsLlm: false,
  });
  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-go@v5\n        with: { go-version: "1.23" }\n      - run: go test -v -race ./...\n      - run: go vet ./...\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nBuilt with KCode.\n\n${"```"}bash\nmake build\nmake test\nmake run\n${"```"}\n\n*Astrolexis.space — Kulvex Code*\n`,
    needsLlm: false,
  });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) {
    const p = join(projectPath, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }

  const m = files.filter((f) => !f.needsLlm).length;
  const l = files.filter((f) => f.needsLlm).length;
  return {
    config: cfg,
    files,
    projectPath,
    prompt: `Implement a Go ${cfg.type}. ${m} files machine, ${l} for LLM. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
