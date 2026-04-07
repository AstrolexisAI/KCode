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

  // Spanish support
  test("detects Spanish creation intent", () => {
    expect(detectCodeEngine("crear un proyecto en Rust")?.engine).toBe("rust");
    expect(detectCodeEngine("hazme una API en Python")?.engine).toBe("python");
    expect(detectCodeEngine("genera un proyecto Kotlin")?.engine).toBe("kotlin");
  });
});
