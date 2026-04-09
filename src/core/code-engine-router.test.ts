import { describe, test, expect } from "bun:test";
import { detectCodeEngine } from "./code-engine-router";

describe("code-engine-router", () => {
  // Should detect creation intent + language
  test("detects Go API from natural language", () => {
    expect(detectCodeEngine("create a Go API with Chi")?.engine).toBe("go");
    expect(detectCodeEngine("crea un proyecto en golang")?.engine).toBe("go");
    expect(detectCodeEngine("make a Go CLI tool")?.engine).toBe("go");
  });

  test("detects Rust project", () => {
    expect(detectCodeEngine("create a Rust CLI with clap")?.engine).toBe("rust");
    expect(detectCodeEngine("build an Axum API server")?.engine).toBe("rust");
  });

  test("detects Python project", () => {
    expect(detectCodeEngine("create a FastAPI server")?.engine).toBe("python");
    expect(detectCodeEngine("genera un proyecto Python con Django")?.engine).toBe("python");
  });

  test("detects Java project", () => {
    expect(detectCodeEngine("create a Spring Boot API")?.engine).toBe("java");
    expect(detectCodeEngine("make a Java project with Gradle")?.engine).toBe("java");
  });

  test("detects C# project", () => {
    expect(detectCodeEngine("create a .NET minimal API")?.engine).toBe("csharp");
    expect(detectCodeEngine("build an ASP.NET app")?.engine).toBe("csharp");
    expect(detectCodeEngine("create a Blazor app")?.engine).toBe("csharp");
  });

  test("detects Kotlin project", () => {
    expect(detectCodeEngine("create a Ktor API")?.engine).toBe("kotlin");
    expect(detectCodeEngine("make an Android app with Kotlin")?.engine).toBe("kotlin");
  });

  test("detects Swift project", () => {
    expect(detectCodeEngine("create an iOS app with SwiftUI")?.engine).toBe("swift");
    expect(detectCodeEngine("build a Vapor server")?.engine).toBe("swift");
  });

  test("detects PHP project", () => {
    expect(detectCodeEngine("create a Laravel web app")?.engine).toBe("php");
    expect(detectCodeEngine("make a Slim API")?.engine).toBe("php");
  });

  test("detects Ruby project", () => {
    expect(detectCodeEngine("create a Sinatra API")?.engine).toBe("ruby");
    expect(detectCodeEngine("build a Rails app")?.engine).toBe("ruby");
  });

  test("detects Elixir project", () => {
    expect(detectCodeEngine("create a Phoenix API")?.engine).toBe("elixir");
    expect(detectCodeEngine("make an Elixir OTP app")?.engine).toBe("elixir");
  });

  test("detects C++ project", () => {
    expect(detectCodeEngine("create a C++ server")?.engine).toBe("cpp");
    expect(detectCodeEngine("build a CMake project")?.engine).toBe("cpp");
  });

  test("detects Dart/Flutter project", () => {
    expect(detectCodeEngine("create a Flutter mobile app")?.engine).toBe("dart");
    expect(detectCodeEngine("make a Dart CLI")?.engine).toBe("dart");
  });

  test("detects Scala project", () => {
    expect(detectCodeEngine("create a Scala http4s API")?.engine).toBe("scala");
    expect(detectCodeEngine("build a Spark job in Scala")?.engine).toBe("scala");
  });

  test("detects Haskell project", () => {
    expect(detectCodeEngine("create a Haskell API with Scotty")?.engine).toBe("haskell");
  });

  test("detects Zig project", () => {
    expect(detectCodeEngine("create a Zig CLI tool")?.engine).toBe("zig");
  });

  test("detects Lua project", () => {
    expect(detectCodeEngine("create a Love2D game")?.engine).toBe("lua");
    expect(detectCodeEngine("make a Neovim plugin")?.engine).toBe("lua");
  });

  test("detects Docker project", () => {
    expect(detectCodeEngine("create a Docker Compose stack")?.engine).toBe("docker");
    expect(detectCodeEngine("create a Dockerfile for my app")?.engine).toBe("docker");
  });

  test("detects DB project", () => {
    expect(detectCodeEngine("create a Postgres database schema")?.engine).toBe("db");
    expect(detectCodeEngine("setup MongoDB with Mongoose")?.engine).toBe("db");
  });

  test("detects Terraform project", () => {
    expect(detectCodeEngine("create AWS infrastructure with Terraform")?.engine).toBe("terraform");
    expect(detectCodeEngine("setup a VPC with RDS")?.engine).toBe("terraform");
  });

  test("detects Monorepo project", () => {
    expect(detectCodeEngine("create a Turborepo monorepo")?.engine).toBe("monorepo");
  });

  test("detects CI/CD project", () => {
    expect(detectCodeEngine("create a GitHub Actions CI pipeline")?.engine).toBe("cicd");
    expect(detectCodeEngine("setup CI/CD for my project")?.engine).toBe("cicd");
  });

  test("detects CSS project", () => {
    expect(detectCodeEngine("create a design system")?.engine).toBe("css");
    expect(detectCodeEngine("build a Tailwind plugin")?.engine).toBe("css");
  });

  // Should NOT detect without creation intent
  test("ignores non-creation requests", () => {
    expect(detectCodeEngine("fix my Go code")).toBeNull();
    expect(detectCodeEngine("explain this Python function")).toBeNull();
    expect(detectCodeEngine("how does Rust ownership work")).toBeNull();
    expect(detectCodeEngine("debug the Java test")).toBeNull();
  });

  // ── Auto-selector tests ──
  test("auto-selects Go for API without explicit language", () => {
    expect(detectCodeEngine("create an API for user management")?.engine).toBe("go");
    expect(detectCodeEngine("build a backend microservice")?.engine).toBe("go");
  });

  test("auto-selects Flutter for mobile app", () => {
    expect(detectCodeEngine("create a mobile app for banking")?.engine).toBe("dart");
    expect(detectCodeEngine("make a mobile app for banking")?.engine).toBe("dart");
  });

  test("auto-selects Go for CLI tools", () => {
    expect(detectCodeEngine("create a CLI tool for file management")?.engine).toBe("go");
    expect(detectCodeEngine("build a terminal automation tool")?.engine).toBe("go");
  });

  test("auto-selects Python for data/analytics", () => {
    expect(detectCodeEngine("create a data pipeline with charts")?.engine).toBe("python");
    expect(detectCodeEngine("build a scraper for real data")?.engine).toBe("python");
    // "wallstreet dashboard" with visual UI → web engine (null), not data
    expect(detectCodeEngine("create a wallstreet dashboard cinematographic, real data")).toBeNull();
  });

  test("auto-selects Lua for games", () => {
    expect(detectCodeEngine("create a 2D game with physics")?.engine).toBe("lua");
    expect(detectCodeEngine("build a game with sprites and player")?.engine).toBe("lua");
  });

  test("auto-selects Elixir for realtime", () => {
    // "chat" with "create" goes to web engine (chat template), not elixir
    expect(detectCodeEngine("create a realtime chat application")).toBeNull();
    // But explicit "Elixir" overrides
    expect(detectCodeEngine("create a realtime service with Elixir")?.engine).toBe("elixir");
    expect(detectCodeEngine("build a websocket notification service")?.engine).toBe("elixir");
  });

  test("auto-selects C++ for embedded", () => {
    expect(detectCodeEngine("create firmware for Arduino sensor")?.engine).toBe("cpp");
    expect(detectCodeEngine("build an IoT device controller")?.engine).toBe("cpp");
  });

  test("auto-selects Python for ML/AI", () => {
    expect(detectCodeEngine("create a machine learning model")?.engine).toBe("python");
    expect(detectCodeEngine("build an AI training pipeline")?.engine).toBe("python");
  });

  test("auto-selects C# for desktop", () => {
    expect(detectCodeEngine("create a desktop GUI application")?.engine).toBe("csharp");
    expect(detectCodeEngine("build a native app with tray icon")?.engine).toBe("csharp");
  });

  test("explicit language overrides auto-select", () => {
    // "API" would auto-select Go, but "Rust" is explicit
    expect(detectCodeEngine("create a Rust API server")?.engine).toBe("rust");
    // "mobile app" would auto-select Flutter, but "Swift" is explicit
    expect(detectCodeEngine("create a SwiftUI mobile app")?.engine).toBe("swift");
    // "data pipeline" would auto-select Python, but "Scala Spark" is explicit
    expect(detectCodeEngine("create a Scala Spark data pipeline")?.engine).toBe("scala");
  });

  test("web type returns null (handled by web engine separately)", () => {
    expect(detectCodeEngine("create a landing page")).toBeNull();
    expect(detectCodeEngine("build a dashboard website")).toBeNull();
    expect(detectCodeEngine("create a blog with portfolio")).toBeNull();
  });

  // Spanish support
  test("detects Spanish creation intent", () => {
    expect(detectCodeEngine("crear un proyecto en Rust")?.engine).toBe("rust");
    expect(detectCodeEngine("hazme una API en Python")?.engine).toBe("python");
    expect(detectCodeEngine("genera un proyecto Kotlin")?.engine).toBe("kotlin");
  });
});
