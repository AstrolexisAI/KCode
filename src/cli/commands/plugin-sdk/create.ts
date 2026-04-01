// KCode - Plugin Scaffolding
// Creates a new plugin project with boilerplate files.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginComponent, PluginScaffoldConfig } from "../../../core/plugin-sdk/types";

export async function createPlugin(config: PluginScaffoldConfig): Promise<string> {
  const dir = join(process.cwd(), `kcode-plugin-${config.name}`);
  mkdirSync(dir, { recursive: true });

  // 1. Generate manifest
  const manifest = buildManifest(config);
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));

  // 2. Create component directories and example files
  for (const component of config.components) {
    createComponent(dir, component, config);
  }

  // 3. README
  writeFileSync(join(dir, "README.md"), readmeTemplate(config));

  // 4. Tests directory
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests/plugin.test.ts"), testTemplate(config));

  // 5. .gitignore
  writeFileSync(join(dir, ".gitignore"), gitignoreTemplate());

  // 6. package.json (if typescript)
  if (config.language === "typescript") {
    writeFileSync(join(dir, "package.json"), packageJsonTemplate(config));
    writeFileSync(join(dir, "tsconfig.json"), tsconfigTemplate());
  }

  return dir;
}

function buildManifest(config: PluginScaffoldConfig): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: config.name,
    version: "0.1.0",
    description: config.description,
    author: config.author,
    license: config.license,
    kcode: ">=1.8.0",
  };

  if (config.components.includes("skills")) {
    manifest.skills = ["skills/*.md"];
  }
  if (config.components.includes("hooks")) {
    manifest.hooks = {
      PostToolUse: [
        {
          match: { toolName: "Bash" },
          action: "command",
          command: "echo",
          args: ["Tool executed: {{toolName}}"],
        },
      ],
    };
  }
  if (config.components.includes("mcp")) {
    manifest.mcpServers = {
      "example-server": {
        command: "npx",
        args: ["@example/mcp-server"],
        env: {},
      },
    };
  }
  if (config.components.includes("output-styles")) {
    manifest.outputStyles = ["output-styles/*.md"];
  }
  if (config.components.includes("agents")) {
    manifest.agents = ["agents/*.md"];
  }

  return manifest;
}

function createComponent(
  dir: string,
  component: PluginComponent,
  config: PluginScaffoldConfig,
): void {
  const compDir = join(dir, component);
  mkdirSync(compDir, { recursive: true });

  switch (component) {
    case "skills":
      writeFileSync(join(compDir, "example.md"), skillTemplate(config.name));
      break;
    case "hooks":
      // Hooks are defined in manifest, no separate files needed
      break;
    case "mcp":
      writeFileSync(join(compDir, "README.md"), mcpReadmeTemplate());
      break;
    case "output-styles":
      writeFileSync(join(compDir, "concise.md"), outputStyleTemplate());
      break;
    case "agents":
      writeFileSync(join(compDir, "helper.md"), agentTemplate(config.name));
      break;
  }
}

// ─── Templates ──────────────────────────────────────────────────

function skillTemplate(name: string): string {
  return `---
name: example
description: Example skill for ${name}
aliases: [ex]
args:
  - name: target
    description: What to operate on
    required: true
---

Perform the example operation on {{target}}.
Analyze the target and provide a detailed report.
`;
}

function agentTemplate(name: string): string {
  return `---
name: ${name}-helper
description: Helper agent for ${name} plugin
model: null
tools: [Read, Glob, Grep]
maxTurns: 10
---

You are a helper agent for the ${name} plugin.
Your job is to assist with specialized tasks.
`;
}

function outputStyleTemplate(): string {
  return `---
name: concise
description: Short and to the point responses
---

Be concise. Lead with the answer. Skip preamble.
Use bullet points for lists. One sentence per idea.
`;
}

function mcpReadmeTemplate(): string {
  return `# MCP Server

This directory contains MCP server configuration.
See plugin.json for server definitions.
`;
}

function readmeTemplate(config: PluginScaffoldConfig): string {
  return `# kcode-plugin-${config.name}

${config.description}

## Installation

\`\`\`bash
kcode plugin install ${config.name}
\`\`\`

## Components

${config.components.map((c) => `- ${c}`).join("\n")}

## Development

\`\`\`bash
# Validate the plugin
kcode plugin validate .

# Run plugin tests
kcode plugin test .

# Publish to marketplace
kcode plugin publish .
\`\`\`

## License

${config.license}
`;
}

function testTemplate(config: PluginScaffoldConfig): string {
  return `import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(__dirname, "..");

describe("${config.name} plugin", () => {
  test("plugin.json is valid JSON", () => {
    const raw = readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf-8");
    const manifest = JSON.parse(raw);
    expect(manifest.name).toBe("${config.name}");
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
  });

  test("plugin has required fields", () => {
    const raw = readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf-8");
    const manifest = JSON.parse(raw);
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toMatch(/^\\d+\\.\\d+\\.\\d+/);
    expect(manifest.description).toBeTruthy();
  });
});
`;
}

function gitignoreTemplate(): string {
  return `node_modules/
.kcode/
dist/
*.tar.gz
.DS_Store
`;
}

function packageJsonTemplate(config: PluginScaffoldConfig): string {
  return JSON.stringify(
    {
      name: `kcode-plugin-${config.name}`,
      version: "0.1.0",
      description: config.description,
      author: config.author,
      license: config.license,
      scripts: {
        test: "bun test",
        validate: "kcode plugin validate .",
        publish: "kcode plugin publish .",
      },
      devDependencies: {
        "bun-types": "latest",
      },
    },
    null,
    2,
  );
}

function tsconfigTemplate(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        types: ["bun-types"],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  );
}
