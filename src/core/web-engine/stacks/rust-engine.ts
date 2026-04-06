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
    deps.push({ name: "serde", version: "1", features: ["derive"] }, { name: "serde_json", version: "1" }, { name: "tower-http", version: "0.6", features: ["cors"] });
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
    api: `use axum::{routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;

#[derive(Serialize)]
struct Health {
    status: String,
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok".into() })
}

// TODO: add your routes and handlers

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        // TODO: add routes
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    println!("${cfg.name} listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`,
    library: `//! ${cfg.name} — A Rust library
//!
//! # Examples
//!
//! \`\`\`rust
//! use ${cfg.name.replace(/-/g, "_")}::${cap(cfg.name)};
//!
//! let instance = ${cap(cfg.name)}::new();
//! instance.run().unwrap();
//! \`\`\`

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

  files.push({
    path: isLib ? "src/lib.rs" : "src/main.rs",
    content: mainTemplates[cfg.type] ?? mainTemplates["cli"]!,
    needsLlm: true,
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
` : `// Integration tests for ${cfg.name}

#[test]
fn test_basic() {
    // TODO: add integration tests
    assert!(true);
}
`,
    needsLlm: true,
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
