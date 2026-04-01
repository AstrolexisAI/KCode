// KCode - Shell Completions Generator Tests

import { describe, test, expect } from "bun:test";
import { generateCompletions, getDefaultSpec, type Shell, type CompletionSpec } from "./generator";

const spec = getDefaultSpec();

describe("getDefaultSpec", () => {
  test("has subcommands", () => {
    expect(spec.subcommands.length).toBeGreaterThan(10);
  });

  test("has global flags", () => {
    expect(spec.globalFlags.length).toBeGreaterThan(5);
  });

  test("subcommands have name and description", () => {
    for (const cmd of spec.subcommands) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  test("includes key subcommands", () => {
    const names = spec.subcommands.map((c) => c.name);
    expect(names).toContain("models");
    expect(names).toContain("doctor");
    expect(names).toContain("dashboard");
    expect(names).toContain("template");
  });
});

describe("generateCompletions — bash", () => {
  const output = generateCompletions("bash", spec);

  test("produces valid bash script", () => {
    expect(output).toContain("_kcode_completions");
    expect(output).toContain("complete -F");
    expect(output).toContain("COMPREPLY");
  });

  test("includes subcommands", () => {
    expect(output).toContain("models");
    expect(output).toContain("doctor");
    expect(output).toContain("dashboard");
  });

  test("includes flags", () => {
    expect(output).toContain("--model");
    expect(output).toContain("--permission");
  });

  test("includes permission mode values", () => {
    expect(output).toContain("ask auto plan deny acceptEdits");
  });

  test("includes effort level values", () => {
    expect(output).toContain("low medium high max");
  });
});

describe("generateCompletions — zsh", () => {
  const output = generateCompletions("zsh", spec);

  test("produces valid zsh script", () => {
    expect(output).toContain("#compdef kcode");
    expect(output).toContain("_kcode");
    expect(output).toContain("_describe");
  });

  test("includes subcommands with descriptions", () => {
    expect(output).toContain("'models:Manage AI models'");
    expect(output).toContain("'doctor:Diagnose environment issues'");
  });

  test("includes global flags", () => {
    expect(output).toContain("--model");
    expect(output).toContain("--permission");
  });

  test("includes completions subcommand values", () => {
    expect(output).toContain("bash zsh fish");
  });
});

describe("generateCompletions — fish", () => {
  const output = generateCompletions("fish", spec);

  test("produces valid fish script", () => {
    expect(output).toContain("complete -c kcode");
    expect(output).toContain("__fish_use_subcommand");
  });

  test("includes subcommands with descriptions", () => {
    expect(output).toContain('"models"');
    expect(output).toContain('"Manage AI models"');
  });

  test("includes global flags", () => {
    expect(output).toContain('"model"');
    expect(output).toContain('"permission"');
  });

  test("disables default file completions", () => {
    expect(output).toContain("complete -c kcode -f");
  });

  test("includes completions subcommand values", () => {
    expect(output).toContain("bash zsh fish");
  });
});

describe("generateCompletions with custom spec", () => {
  const custom: CompletionSpec = {
    subcommands: [{ name: "hello", description: "Say hello" }],
    globalFlags: [{ name: "--name", description: "Your name", takesValue: true }],
  };

  test("bash includes custom commands", () => {
    const output = generateCompletions("bash", custom);
    expect(output).toContain("hello");
    expect(output).toContain("--name");
  });

  test("zsh includes custom commands", () => {
    const output = generateCompletions("zsh", custom);
    expect(output).toContain("hello");
  });

  test("fish includes custom commands", () => {
    const output = generateCompletions("fish", custom);
    expect(output).toContain("hello");
  });
});
