import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginOutputStyles, parseFrontmatter } from "./output-style-loader";

let tempDir: string;

function createPluginWithStyles(
  name: string,
  styles: Record<string, string>,
  opts?: { enabled?: boolean },
): { name: string; dir: string; enabled?: boolean } {
  const pluginDir = join(tempDir, name);
  const stylesDir = join(pluginDir, "output-styles");
  mkdirSync(stylesDir, { recursive: true });

  for (const [filename, content] of Object.entries(styles)) {
    writeFileSync(join(stylesDir, filename), content);
  }

  return { name, dir: pluginDir, enabled: opts?.enabled };
}

describe("parseFrontmatter", () => {
  test("parses frontmatter with name, description, priority", () => {
    const input = `---
name: concise-code
description: Concise code output
priority: 50
---
Be concise. Code only.`;

    const { frontmatter, content } = parseFrontmatter(input);
    expect(frontmatter.name).toBe("concise-code");
    expect(frontmatter.description).toBe("Concise code output");
    expect(frontmatter.priority).toBe(50);
    expect(content.trim()).toBe("Be concise. Code only.");
  });

  test("returns empty frontmatter when no delimiter", () => {
    const input = "Just plain markdown content.";
    const { frontmatter, content } = parseFrontmatter(input);
    expect(frontmatter).toEqual({});
    expect(content).toBe(input);
  });

  test("handles quoted strings", () => {
    const input = `---
name: "my-style"
description: 'A style with quotes'
---
Body.`;

    const { frontmatter } = parseFrontmatter(input);
    expect(frontmatter.name).toBe("my-style");
    expect(frontmatter.description).toBe("A style with quotes");
  });

  test("handles boolean values", () => {
    const input = `---
enabled: true
disabled: false
---
Content.`;

    const { frontmatter } = parseFrontmatter(input);
    expect(frontmatter.enabled).toBe(true);
    expect(frontmatter.disabled).toBe(false);
  });

  test("handles missing closing delimiter", () => {
    const input = `---
name: broken
No closing delimiter`;

    const { frontmatter, content } = parseFrontmatter(input);
    expect(frontmatter).toEqual({});
    expect(content).toBe(input);
  });
});

describe("loadPluginOutputStyles", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-style-loader-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("loads styles from enabled plugins", () => {
    const plugin = createPluginWithStyles("my-plugin", {
      "concise.md": `---
name: concise
description: Be concise
priority: 10
---
Be concise in all responses.`,
      "verbose.md": `---
name: verbose
description: Be verbose
priority: 20
---
Be thorough and detailed.`,
    });

    const styles = loadPluginOutputStyles([plugin]);
    expect(styles).toHaveLength(2);
    expect(styles[0]!.name).toBe("my-plugin:concise");
    expect(styles[0]!.description).toBe("Be concise");
    expect(styles[0]!.priority).toBe(10);
    expect(styles[0]!.instructions).toBe("Be concise in all responses.");
    expect(styles[1]!.name).toBe("my-plugin:verbose");
  });

  test("skips disabled plugins", () => {
    const plugin = createPluginWithStyles("disabled-plugin", {
      "style.md": "Some style",
    }, { enabled: false });

    const styles = loadPluginOutputStyles([plugin]);
    expect(styles).toHaveLength(0);
  });

  test("uses filename as style name when no frontmatter name", () => {
    const plugin = createPluginWithStyles("test-plugin", {
      "my-style.md": "Just instructions, no frontmatter.",
    });

    const styles = loadPluginOutputStyles([plugin]);
    expect(styles).toHaveLength(1);
    expect(styles[0]!.name).toBe("test-plugin:my-style");
    expect(styles[0]!.priority).toBe(100); // default
  });

  test("sorts by priority (lower first)", () => {
    const plugin = createPluginWithStyles("sort-test", {
      "low.md": `---\npriority: 200\n---\nLow priority.`,
      "high.md": `---\npriority: 5\n---\nHigh priority.`,
      "mid.md": `---\npriority: 50\n---\nMid priority.`,
    });

    const styles = loadPluginOutputStyles([plugin]);
    expect(styles).toHaveLength(3);
    expect(styles[0]!.priority).toBe(5);
    expect(styles[1]!.priority).toBe(50);
    expect(styles[2]!.priority).toBe(200);
  });

  test("handles plugins without output-styles directory", () => {
    const pluginDir = join(tempDir, "no-styles");
    mkdirSync(pluginDir, { recursive: true });

    const styles = loadPluginOutputStyles([{ name: "no-styles", dir: pluginDir }]);
    expect(styles).toHaveLength(0);
  });

  test("only loads .md files", () => {
    const plugin = createPluginWithStyles("mixed", {
      "valid.md": "Valid style.",
      "config.json": '{"not": "a style"}',
      "readme.txt": "Not a style",
    });

    const styles = loadPluginOutputStyles([plugin]);
    expect(styles).toHaveLength(1);
    expect(styles[0]!.name).toBe("mixed:valid");
  });

  test("loads styles from multiple plugins", () => {
    const plugin1 = createPluginWithStyles("plugin-a", {
      "a-style.md": "Style from A.",
    });
    const plugin2 = createPluginWithStyles("plugin-b", {
      "b-style.md": "Style from B.",
    });

    const styles = loadPluginOutputStyles([plugin1, plugin2]);
    expect(styles).toHaveLength(2);
    expect(styles.some(s => s.name === "plugin-a:a-style")).toBe(true);
    expect(styles.some(s => s.name === "plugin-b:b-style")).toBe(true);
  });

  test("namespaces correctly with plugin prefix", () => {
    const plugin = createPluginWithStyles("my-org-plugin", {
      "dark-mode.md": `---\nname: dark-mode\n---\nDark mode instructions.`,
    });

    const styles = loadPluginOutputStyles([plugin]);
    expect(styles[0]!.name).toBe("my-org-plugin:dark-mode");
  });
});
