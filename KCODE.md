Default to using Bun instead of Node.js.

- Use `bun test` for testing
- Use `bun run build.ts` to compile standalone binary
- Use `Bun.file()` instead of `node:fs` readFile/writeFile
- Bun automatically loads .env

## Project

- This is KCode (Kulvex Code) by Astrolexis
- Local LLMs only via llama-server (OpenAI-compatible API)
- Never reference competing products in code or docs
- Ports below 10000 are reserved — use 10000+ for any new defaults
