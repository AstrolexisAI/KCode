import type { Command } from "commander";

export function registerNewCommand(program: Command): void {
  program
    .command("new <template> [name]")
    .description("Create a new project from a template (api, cli, web, library)")
    .action(async (template: string, name?: string) => {
      const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const projectName = name ?? template;
      const projectDir = join(process.cwd(), projectName);

      if (existsSync(projectDir)) {
        console.error(`\x1b[31mDirectory "${projectName}" already exists.\x1b[0m`);
        process.exit(1);
      }

      mkdirSync(projectDir, { recursive: true });

      const templates: Record<string, () => void> = {
        api: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          mkdirSync(join(projectDir, "src", "routes"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: { start: "bun run src/index.ts", dev: "bun --watch run src/index.ts", test: "bun test" },
            devDependencies: { "@types/bun": "latest" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, outDir: "dist" },
            include: ["src"],
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "index.ts"), `const server = Bun.serve({
  port: 10080,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    return new Response("Not found", { status: 404 });
  },
});

console.log(\`Server running at http://localhost:\${server.port}\`);
`);
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun API project. Run with \`bun run dev\`.\n`);
        },
        cli: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            bin: { [projectName]: "src/index.ts" },
            scripts: { start: "bun run src/index.ts", build: "bun build src/index.ts --compile --outfile dist/" + projectName, test: "bun test" },
            devDependencies: { "@types/bun": "latest" },
            dependencies: { commander: "^14.0.0" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true },
            include: ["src"],
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "index.ts"), `#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command()
  .name("${projectName}")
  .description("A CLI tool")
  .version("0.1.0")
  .argument("[input]", "Input to process")
  .action((input?: string) => {
    console.log(\`Hello from ${projectName}!\`, input ?? "");
  });

program.parse();
`);
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun CLI project. Run with \`bun run start\`, build with \`bun run build\`.\n`);
        },
        web: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          mkdirSync(join(projectDir, "public"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: { start: "bun run src/server.ts", dev: "bun --watch run src/server.ts", test: "bun test" },
            devDependencies: { "@types/bun": "latest" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "server.ts"), `const server = Bun.serve({
  port: 10080,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(Bun.file("public/index.html"));
    const file = Bun.file("public" + url.pathname);
    return new Response(file);
  },
});
console.log(\`Server running at http://localhost:\${server.port}\`);
`);
          writeFileSync(join(projectDir, "public", "index.html"), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${projectName}</title><link rel="stylesheet" href="/styles.css"></head>
<body><h1>${projectName}</h1><script src="/app.js"></script></body>
</html>
`);
          writeFileSync(join(projectDir, "public", "styles.css"), "body { font-family: system-ui; max-width: 800px; margin: 2rem auto; }\n");
          writeFileSync(join(projectDir, "public", "app.js"), "console.log('Ready');\n");
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun web project. Run with \`bun run dev\`.\n`);
        },
        library: () => {
          mkdirSync(join(projectDir, "src"), { recursive: true });
          mkdirSync(join(projectDir, "tests"), { recursive: true });
          writeFileSync(join(projectDir, "package.json"), JSON.stringify({
            name: projectName,
            version: "0.1.0",
            type: "module",
            main: "src/index.ts",
            scripts: { test: "bun test", build: "bun build src/index.ts --outdir dist" },
            devDependencies: { "@types/bun": "latest" },
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, declaration: true, outDir: "dist" },
            include: ["src"],
          }, null, 2) + "\n");
          writeFileSync(join(projectDir, "src", "index.ts"), `export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`);
          writeFileSync(join(projectDir, "tests", "index.test.ts"), `import { test, expect } from "bun:test";
import { hello } from "../src/index";

test("hello returns greeting", () => {
  expect(hello("World")).toBe("Hello, World!");
});
`);
          writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun library project. Test with \`bun test\`.\n`);
        },
      };

      if (!templates[template]) {
        console.error(`\x1b[31mUnknown template "${template}". Available: ${Object.keys(templates).join(", ")}\x1b[0m`);
        process.exit(1);
      }

      templates[template]();

      // Initialize KCode in the new project
      const kcodeDir = join(projectDir, ".kcode");
      mkdirSync(join(kcodeDir, "awareness"), { recursive: true });
      writeFileSync(join(kcodeDir, "settings.json"), JSON.stringify({ hooks: {} }, null, 2) + "\n");

      // Add .gitignore
      writeFileSync(join(projectDir, ".gitignore"), "node_modules/\ndist/\n.kcode/\n");

      console.log(`\x1b[32m✓\x1b[0m Created ${template} project: ${projectName}/`);
      console.log(`\n  cd ${projectName}`);
      console.log("  bun install");
      console.log("  kcode\n");
    });
}
