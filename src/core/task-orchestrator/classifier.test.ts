import { describe, expect, test } from "bun:test";
import { classifyTask } from "./classifier";

describe("classifier", () => {
  // Audit
  test("classifies 'auditalo' as audit", () => {
    expect(classifyTask("auditalo")).toMatchObject({ type: "audit" });
  });
  test("classifies 'find security bugs' as audit", () => {
    expect(classifyTask("find security bugs in this repo")).toMatchObject({ type: "audit" });
  });
  test("classifies 'busca vulnerabilidades' as audit", () => {
    expect(classifyTask("busca vulnerabilidades en el código")).toMatchObject({ type: "audit" });
  });

  // Debug
  test("classifies 'why does it crash' as debug", () => {
    expect(classifyTask("why does the login crash when I enter email?")).toMatchObject({ type: "debug" });
  });
  test("classifies 'por qué falla' as debug", () => {
    expect(classifyTask("por qué falla el login?")).toMatchObject({ type: "debug" });
  });
  test("classifies 'fix the bug in auth.ts' as debug", () => {
    const r = classifyTask("fix the bug in auth.ts");
    expect(r.type).toBe("debug");
    expect(r.entities.files).toContain("auth.ts");
  });
  test("classifies 'arregla el error' as debug", () => {
    expect(classifyTask("arregla el error del formulario")).toMatchObject({ type: "debug" });
  });

  // Implement
  test("classifies 'add a REST endpoint' as implement", () => {
    expect(classifyTask("add a REST endpoint for users")).toMatchObject({ type: "implement" });
  });
  test("classifies 'crea una función' as implement", () => {
    expect(classifyTask("crea una función para validar emails")).toMatchObject({ type: "implement" });
  });
  test("classifies 'create a new component' as implement", () => {
    expect(classifyTask("create a new React component for the dashboard")).toMatchObject({ type: "implement" });
  });

  // Review
  test("classifies 'review this code' as review", () => {
    expect(classifyTask("review this code")).toMatchObject({ type: "review" });
  });
  test("classifies 'revisa el PR' as review", () => {
    expect(classifyTask("revisa el código del PR")).toMatchObject({ type: "review" });
  });

  // Refactor
  test("classifies 'refactor this function' as refactor", () => {
    expect(classifyTask("refactor this function it's too complex")).toMatchObject({ type: "refactor" });
  });
  test("classifies 'simplifica el código' as refactor", () => {
    expect(classifyTask("simplifica el código de auth.py")).toMatchObject({ type: "refactor" });
  });

  // Test
  test("classifies 'write tests for' as test", () => {
    expect(classifyTask("write tests for the user service")).toMatchObject({ type: "test" });
  });
  test("classifies 'agrega pruebas unitarias' as test", () => {
    expect(classifyTask("agrega pruebas unitarias para el módulo")).toMatchObject({ type: "test" });
  });

  // Deploy
  test("classifies 'deploy to production' as deploy", () => {
    expect(classifyTask("deploy this to production")).toMatchObject({ type: "deploy" });
  });

  // Explain
  test("classifies 'explain this code' as explain", () => {
    expect(classifyTask("explain how this function works")).toMatchObject({ type: "explain" });
  });
  test("classifies 'qué hace esto' as explain", () => {
    expect(classifyTask("qué hace esta función?")).toMatchObject({ type: "explain" });
  });

  // General (no match)
  test("classifies 'hello' as general", () => {
    expect(classifyTask("hello")).toMatchObject({ type: "general" });
  });

  // Entity extraction
  test("extracts file paths from message", () => {
    const r = classifyTask("fix the bug in src/auth/login.ts and utils.py");
    expect(r.entities.files).toContain("src/auth/login.ts");
    expect(r.entities.files).toContain("utils.py");
  });

  // Bilingual
  test("works in English and Spanish", () => {
    expect(classifyTask("audit this project")).toMatchObject({ type: "audit" });
    expect(classifyTask("auditalo, el proyecto")).toMatchObject({ type: "audit" });
    expect(classifyTask("fix the crash")).toMatchObject({ type: "debug" });
    expect(classifyTask("soluciona el crash")).toMatchObject({ type: "debug" });
  });
});
