// KCode - Rust Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RustProjectType = "cli" | "api" | "library" | "wasm" | "embedded" | "game" | "system" | "custom";

interface RustConfig {
  name: string;
  type: RustProjectType;
  edition: string;
  dependencies: Array<{ name: string; version: string; features?: string[] }>;
  features: string[];
}

function detectRustProject(msg: string): RustConfig {
  const lower = msg.toLowerCase();
  let type: RustProjectType = "cli";
  const deps: Array<{ name: string; version: string; features?: string[] }> = [];

  if (/\b(?:api|server|http|web|rest|actix|axum|rocket)\b/i.test(lower)) {
    type = "api";
    if (/\bactix\b/i.test(lower)) { deps.push({ name: "actix-web", version: "4" }, { name: "actix-rt", version: "2" }); }
    else { deps.push({ name: "axum", version: "0.8" }, { name: "tokio", version: "1", features: ["full"] }); }
    deps.push({ name: "serde", version: "1", features: ["derive"] }, { name: "serde_json", version: "1" }, { name: "tower-http", version: "0.6", features: ["cors"] }, { name: "tracing", version: "0.1" }, { name: "tracing-subscriber", version: "0.3", features: ["env-filter"] }, { name: "dotenvy", version: "0.15" });
  }
  else if (/\b(?:lib|library|crate)\b/i.test(lower)) { type = "library"; }
  else if (/\b(?:wasm|web\s*assembly|browser)\b/i.test(lower)) { type = "wasm"; deps.push({ name: "wasm-bindgen", version: "0.2" }); }
  else if (/\b(?:embedded|no_std|microcontroller|stm32|esp)\b/i.test(lower)) { type = "embedded"; }
  else if (/\b(?:game|bevy|ggez)\b/i.test(lower)) { type = "game"; deps.push({ name: "bevy", version: "0.15" }); }
  else if (/\b(?:system|daemon|service)\b/i.test(lower)) { type = "system"; deps.push({ name: "tokio", version: "1", features: ["full"] }); }
  else { deps.push({ name: "clap", version: "4", features: ["derive"] }, { name: "anyhow", version: "1" }); }

  if (/\b(?:async|tokio)\b/i.test(lower) && !deps.some(d => d.name === "tokio")) deps.push({ name: "tokio", version: "1", features: ["full"] });
  if (/\b(?:serde|json|serialize)\b/i.test(lower) && !deps.some(d => d.name === "serde")) deps.push({ name: "serde", version: "1", features: ["derive"] }, { name: "serde_json", version: "1" });
  if (/\b(?:sql|sqlite|postgres|database|db)\b/i.test(lower)) deps.push({ name: "sqlx", version: "0.8", features: ["runtime-tokio", "sqlite"] });
  if (/\b(?:log|tracing)\b/i.test(lower)) deps.push({ name: "tracing", version: "0.1" }, { name: "tracing-subscriber", version: "0.3" });
  if (/\b(?:reqwest|http\s*client|fetch)\b/i.test(lower)) deps.push({ name: "reqwest", version: "0.12", features: ["json"] });

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, edition: "2024", dependencies: deps, features: [] };
}

function depsToToml(deps: Array<{ name: string; version: string; features?: string[] }>): string {
  return deps.map(d => {
    if (d.features?.length) return `${d.name} = { version = "${d.version}", features = [${d.features.map(f => `"${f}"`).join(", ")}] }`;
    return `${d.name} = "${d.version}"`;
  }).join("\n");
}

interface GenFile { path: string; content: string; needsLlm: boolean; }

function cap(s: string): string { return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(""); }

export interface RustProjectResult {
  config: RustConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createRustProject(userRequest: string, cwd: string): RustProjectResult {
  const cfg = detectRustProject(userRequest);
  const files: GenFile[] = [];
  const isLib = cfg.type === "library";

  files.push({ path: "Cargo.toml", content: `[package]
name = "${cfg.name}"
version = "0.1.0"
edition = "${cfg.edition}"

[dependencies]
${depsToToml(cfg.dependencies)}

[dev-dependencies]
${cfg.type === "api" ? 'tower = { version = "0.5", features = ["util"] }' : ""}

[[${isLib ? "lib" : "bin"}]]
name = "${cfg.name}"
${isLib ? `path = "src/lib.rs"` : `path = "src/main.rs"`}
`, needsLlm: false });

  // Main/Lib
  const mainTemplates: Record<string, string> = {
    cli: `use clap::Parser;
use anyhow::Result;

#[derive(Parser, Debug)]
#[command(name = "${cfg.name}", version, about)]
struct Args {
    /// Input file path
    input: String,

    /// Output file path
    #[arg(short, long, default_value = "output.txt")]
    output: String,

    /// Verbose output
    #[arg(short, long)]
    verbose: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    if args.verbose {
        println!("Processing: {}", args.input);
    }

    // TODO: implement main logic

    println!("Done!");
    Ok(())
}
`,
    api: `use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put, delete},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tracing_subscriber;

// --- Models ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Item {
    id: String,
    name: String,
    description: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct CreateItemRequest {
    name: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateItemRequest {
    name: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Serialize)]
struct Health {
    status: String,
    service: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

// --- Error handling ---

enum AppError {
    NotFound(String),
    BadRequest(String),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, Json(ErrorBody { error: msg })).into_response()
    }
}

// --- Shared state ---

type AppState = Arc<Mutex<Vec<Item>>>;

fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:016x}", nanos)
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple UTC timestamp
    format!("{}Z", secs)
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

// --- Handlers ---

async fn health_check() -> Json<Health> {
    Json(Health {
        status: "ok".into(),
        service: "${cfg.name}".into(),
    })
}

async fn list_items(State(state): State<AppState>) -> Json<Vec<Item>> {
    let items = state.lock().await;
    Json(items.clone())
}

async fn get_item(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Item>, AppError> {
    let items = state.lock().await;
    items
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .map(Json)
        .ok_or_else(|| AppError::NotFound("item not found".into()))
}

async fn create_item(
    State(state): State<AppState>,
    Json(req): Json<CreateItemRequest>,
) -> Result<(StatusCode, Json<Item>), AppError> {
    let name = req
        .name
        .map(|n| n.trim().to_string())
        .unwrap_or_default();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let description = req
        .description
        .map(|d| d.trim().to_string())
        .unwrap_or_default();
    let item = Item {
        id: generate_id(),
        name,
        description,
        created_at: now_rfc3339(),
    };
    tracing::info!(id = %item.id, name = %item.name, "item created");
    let mut items = state.lock().await;
    items.push(item.clone());
    Ok((StatusCode::CREATED, Json(item)))
}

async fn update_item(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateItemRequest>,
) -> Result<Json<Item>, AppError> {
    let mut items = state.lock().await;
    let item = items
        .iter_mut()
        .find(|i| i.id == id)
        .ok_or_else(|| AppError::NotFound("item not found".into()))?;

    if let Some(name) = req.name {
        let trimmed = name.trim().to_string();
        if !trimmed.is_empty() {
            item.name = trimmed;
        }
    }
    if let Some(desc) = req.description {
        item.description = desc.trim().to_string();
    }
    tracing::info!(id = %item.id, "item updated");
    Ok(Json(item.clone()))
}

async fn delete_item(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let mut items = state.lock().await;
    let len_before = items.len();
    items.retain(|i| i.id != id);
    if items.len() == len_before {
        return Err(AppError::NotFound("item not found".into()));
    }
    tracing::info!(id = %id, "item deleted");
    Ok(StatusCode::NO_CONTENT)
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/items", get(list_items).post(create_item))
        .route("/items/{id}", get(get_item).put(update_item).delete(delete_item))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[tokio::main]
async fn main() {
    // Load .env file if present (via dotenvy)
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(env_or("RUST_LOG", "info"))
        .init();

    let port: u16 = env_or("PORT", "10080").parse().unwrap_or(10080);
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("${cfg.name} starting on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();

    tracing::info!("server stopped");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.unwrap();
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .unwrap()
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
`,
    library: `//! ${cfg.name} — A Rust library
//!
//! # Examples
//!
//! ${"```"}rust
//! use ${cfg.name.replace(/-/g, "_")}::${cap(cfg.name)};
//!
//! let instance = ${cap(cfg.name)}::new();
//! instance.run().unwrap();
//! ${"```"}

use std::fmt;

/// Main struct for ${cfg.name}
#[derive(Debug, Default)]
pub struct ${cap(cfg.name)} {
    initialized: bool,
}

impl ${cap(cfg.name)} {
    /// Create a new instance
    pub fn new() -> Self {
        Self::default()
    }

    /// Initialize
    pub fn init(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        // TODO: setup logic
        self.initialized = true;
        Ok(())
    }

    /// Run the main logic
    pub fn run(&self) -> Result<(), Box<dyn std::error::Error>> {
        if !self.initialized {
            return Err("Not initialized".into());
        }
        // TODO: main logic
        Ok(())
    }
}

impl fmt::Display for ${cap(cfg.name)} {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "${cfg.name} (initialized: {})", self.initialized)
    }
}
`,
    game: `use bevy::prelude::*;

fn main() {
    App::new()
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "${cfg.name}".into(),
                resolution: (1280., 720.).into(),
                ..default()
            }),
            ..default()
        }))
        .add_systems(Startup, setup)
        .add_systems(Update, update)
        .run();
}

fn setup(mut commands: Commands) {
    commands.spawn(Camera2d::default());
    // TODO: spawn entities
}

fn update() {
    // TODO: game logic
}
`,
    system: `use tokio::signal;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[tokio::main]
async fn main() {
    println!("${cfg.name} daemon started");

    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();

    tokio::spawn(async move {
        signal::ctrl_c().await.unwrap();
        r.store(false, Ordering::SeqCst);
        println!("\\nShutdown signal received");
    });

    while running.load(Ordering::SeqCst) {
        // TODO: daemon work
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }

    println!("Daemon stopped");
}
`,
  };

  const isApi = cfg.type === "api";
  files.push({
    path: isLib ? "src/lib.rs" : "src/main.rs",
    content: mainTemplates[cfg.type] ?? mainTemplates["cli"]!,
    needsLlm: !isApi,
  });

  // Tests
  files.push({
    path: isLib ? "tests/integration.rs" : "tests/test_main.rs",
    content: isLib ? `use ${cfg.name.replace(/-/g, "_")}::${cap(cfg.name)};

#[test]
fn test_create() {
    let instance = ${cap(cfg.name)}::new();
    assert!(!format!("{instance}").is_empty());
}

#[test]
fn test_init_and_run() {
    let mut instance = ${cap(cfg.name)}::new();
    assert!(instance.init().is_ok());
    assert!(instance.run().is_ok());
}

#[test]
fn test_run_without_init_fails() {
    let instance = ${cap(cfg.name)}::new();
    assert!(instance.run().is_err());
}
` : isApi ? `use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;

// Import the binary crate's public items
// Note: for this to work, main.rs exposes create_router and AppState as pub
use ${cfg.name.replace(/-/g, "_")}::*;

fn test_state() -> Arc<Mutex<Vec<()>>> {
    Arc::new(Mutex::new(Vec::new()))
}

#[tokio::test]
async fn test_health_endpoint() {
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
    assert_eq!(json["service"], "${cfg.name}");
}

#[tokio::test]
async fn test_list_items_empty() {
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/items")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert!(json.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_create_item() {
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/items")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&json!({"name": "Test", "description": "A test item"})).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["name"], "Test");
    assert_eq!(json["description"], "A test item");
    assert!(json["id"].as_str().is_some());
    assert!(json["created_at"].as_str().is_some());
}

#[tokio::test]
async fn test_create_item_empty_name_rejected() {
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/items")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&json!({"name": "  ", "description": "bad"})).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"], "name is required");
}

#[tokio::test]
async fn test_create_item_missing_name_rejected() {
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/items")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&json!({"description": "no name"})).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_get_item_not_found() {
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/items/nonexistent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_delete_item_not_found() {
    let state: AppState = Arc::new(Mutex::new(Vec::new()));
    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/items/nonexistent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
` : `// Integration tests for ${cfg.name}

#[test]
fn test_basic() {
    // TODO: add integration tests
    assert!(true);
}
`,
    needsLlm: !isApi,
  });

  // Extras
  files.push({ path: ".gitignore", content: "/target\nCargo.lock\n*.swp\n.env\n", needsLlm: false });
  files.push({ path: "rust-toolchain.toml", content: `[toolchain]\nchannel = "stable"\n`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: "clippy, rustfmt" }
      - run: cargo fmt --check
      - run: cargo clippy -- -D warnings
      - run: cargo test
`, needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM rust:1.82 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/${cfg.name} /usr/local/bin/
ENTRYPOINT ["${cfg.name}"]
`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nBuilt with KCode.\n\n\`\`\`bash\ncargo run\ncargo test\ncargo clippy\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  const l = files.filter(f => f.needsLlm).length;

  return { config: cfg, files, projectPath, prompt: `Implement a Rust ${cfg.type}. ${m} files created by machine, implement TODO in ${l} files. USER: "${userRequest}"` };
}
