import { describe, expect, test } from "bun:test";
import { inferRuntimeModeFromText, skipsServerPreflight } from "./runtime-mode";

describe("inferRuntimeModeFromText", () => {
  test("blessed-contrib imports → tui (v275 EXACT repro)", () => {
    const src = `
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { Client } from 'bitcoin-core';
`;
    expect(inferRuntimeModeFromText(src)).toBe("tui");
  });

  test("ink import → tui", () => {
    expect(inferRuntimeModeFromText(`import { render } from "ink";`)).toBe("tui");
  });

  test("python rich.live → tui", () => {
    expect(inferRuntimeModeFromText("from rich.live import Live")).toBe("tui");
  });

  test("express import → web", () => {
    expect(inferRuntimeModeFromText(`import express from "express";`)).toBe("web");
  });

  test("fastify → web", () => {
    expect(inferRuntimeModeFromText(`const fastify = require("fastify");`)).toBe(
      "web",
    );
  });

  test("Bun.serve → web", () => {
    expect(inferRuntimeModeFromText("Bun.serve({ port: 3000 })")).toBe("web");
  });

  test("flask → web", () => {
    expect(inferRuntimeModeFromText("from flask import Flask")).toBe("web");
  });

  test("fastapi + uvicorn → web", () => {
    expect(
      inferRuntimeModeFromText("from fastapi import FastAPI\nimport uvicorn"),
    ).toBe("web");
  });

  test("commander → cli", () => {
    expect(inferRuntimeModeFromText(`import { Command } from "commander";`)).toBe(
      "cli",
    );
  });

  test("yargs → cli", () => {
    expect(inferRuntimeModeFromText(`const yargs = require("yargs");`)).toBe("cli");
  });

  test("click (python) → cli", () => {
    expect(inferRuntimeModeFromText("import click")).toBe("cli");
  });

  test("tui trumps cli when both present (blessed + commander)", () => {
    expect(
      inferRuntimeModeFromText(`
import blessed from "blessed";
import { Command } from "commander";
`),
    ).toBe("tui");
  });

  test("no signal → unknown", () => {
    expect(inferRuntimeModeFromText("console.log('hello')")).toBe("unknown");
  });

  test("empty text → unknown", () => {
    expect(inferRuntimeModeFromText("")).toBe("unknown");
  });

  test("word boundary — 'expressjs' substring should NOT match (alphanumeric boundary)", () => {
    // 'expressjs' has an alphanumeric character after 'express', so \bexpress\b
    // does NOT match there. This is the practical case that matters — avoid
    // naming collisions with unrelated libraries that happen to start with a
    // signal word.
    expect(inferRuntimeModeFromText("import x from 'expressjs-helpers';")).toBe(
      "unknown",
    );
  });
});

describe("skipsServerPreflight", () => {
  test("cli and tui skip", () => {
    expect(skipsServerPreflight("cli")).toBe(true);
    expect(skipsServerPreflight("tui")).toBe(true);
  });

  test("web and unknown do NOT skip", () => {
    expect(skipsServerPreflight("web")).toBe(false);
    expect(skipsServerPreflight("unknown")).toBe(false);
  });
});
