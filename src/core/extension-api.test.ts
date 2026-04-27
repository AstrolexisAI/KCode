import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetExtensions,
  type ExtensionManifest,
  getExtension,
  getExtensionCommands,
  getExtensions,
  getExtensionTools,
  registerExtension,
  unregisterExtension,
} from "./extension-api";

const makeManifest = (name = "test-ext"): ExtensionManifest => ({
  name,
  version: "1.0.0",
  description: "Test extension",
  main: "index.ts",
});

describe("extension-api", () => {
  beforeEach(() => _resetExtensions());

  test("registerExtension adds extension", () => {
    registerExtension(makeManifest(), {});
    expect(getExtensions()).toHaveLength(1);
  });

  test("getExtension returns registered extension", () => {
    registerExtension(makeManifest("my-ext"), {});
    const ext = getExtension("my-ext");
    expect(ext).not.toBeNull();
    expect(ext!.manifest.name).toBe("my-ext");
  });

  test("getExtension returns null for unknown", () => {
    expect(getExtension("nonexistent")).toBeNull();
  });

  test("unregisterExtension removes extension", () => {
    registerExtension(makeManifest(), {});
    expect(unregisterExtension("test-ext")).toBe(true);
    expect(getExtensions()).toHaveLength(0);
  });

  test("registerExtension with tools", () => {
    registerExtension(makeManifest(), {
      tools: [
        {
          name: "MyTool",
          description: "A test tool",
          parameters: {},
          execute: async () => "result",
        },
      ],
    });
    expect(getExtensionTools()).toHaveLength(1);
    expect(getExtensionTools()[0]!.name).toBe("MyTool");
  });

  test("registerExtension with commands", () => {
    registerExtension(makeManifest(), {
      commands: [
        {
          name: "/mycommand",
          description: "A test command",
          execute: async () => "done",
        },
      ],
    });
    expect(getExtensionCommands()).toHaveLength(1);
  });

  test("multiple extensions aggregate tools", () => {
    registerExtension(makeManifest("ext-a"), {
      tools: [{ name: "ToolA", description: "A", parameters: {}, execute: async () => "" }],
    });
    registerExtension(makeManifest("ext-b"), {
      tools: [{ name: "ToolB", description: "B", parameters: {}, execute: async () => "" }],
    });
    expect(getExtensionTools()).toHaveLength(2);
  });

  test("replacing extension updates it", () => {
    registerExtension(makeManifest(), { tools: [] });
    registerExtension(makeManifest(), {
      tools: [{ name: "NewTool", description: "New", parameters: {}, execute: async () => "" }],
    });
    expect(getExtensions()).toHaveLength(1);
    expect(getExtensionTools()).toHaveLength(1);
    expect(getExtensionTools()[0]!.name).toBe("NewTool");
  });
});
