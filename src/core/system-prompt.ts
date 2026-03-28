// KCode - System Prompt Builder
// Constructs the system prompt sent to the LLM, assembled from modular sections

import type { KCodeConfig } from "./types";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { log } from "./logger";
import { loadLearnings } from "../tools/learn";
import { loadDistilledExamples } from "./distillation";
import { getStyleInstructions, getCurrentStyle } from "./output-styles";
import { getUserModel } from "./user-model";
import { getWorldModel } from "./world-model";
import { getNarrativeManager } from "./narrative";
import { getRulesManager } from "./rules";
import { TokenBudgetManager, SectionPriority, type PromptSection } from "./token-budget";
import { formatPlanForPrompt, loadLatestPlan } from "../tools/plan";
import { formatPinnedForPrompt } from "./context-pin";

// ─── System Prompt Builder ──────────────────────────────────────

export class SystemPromptBuilder {
  /**
   * Build the full system prompt from config and environment context.
   * Each section is independently generated and can be toggled.
   */
  static async build(config: KCodeConfig, version?: string): Promise<string> {
    // If the user overrides the entire system prompt, return it directly
    if (config.systemPromptOverride) {
      return config.systemPromptOverride;
    }

    const budgetManager = new TokenBudgetManager(config.contextWindowSize ?? 32_000);
    const sections: PromptSection[] = [];

    // ─── Critical sections (never truncated) ───────────────────
    sections.push({ content: this.buildIdentity(version ?? "unknown"), priority: SectionPriority.CRITICAL, label: "identity" });
    sections.push({ content: this.buildToolInstructions(), priority: SectionPriority.CRITICAL, label: "tools" });

    // ─── High priority ─────────────────────────────────────────
    sections.push({ content: this.buildCodeGuidelines(), priority: SectionPriority.HIGH, label: "code-guidelines" });
    sections.push({ content: this.buildGitInstructions(), priority: SectionPriority.HIGH, label: "git" });
    sections.push({ content: this.buildToneAndOutput(), priority: SectionPriority.HIGH, label: "tone" });
    if (config.thinking) {
      sections.push({ content: `## Extended Reasoning
IMPORTANT: Before EVERY response, you MUST first write your internal reasoning inside a <reasoning> block.
ALWAYS start your response with <reasoning> immediately — no exceptions, no preamble before it.

Format:
<reasoning>
your step-by-step analysis, planning, and thought process here
</reasoning>

Then write your final answer after the closing tag.
NEVER skip the reasoning block, even for simple questions. The reasoning block is shown separately in the UI and helps you produce better, more thorough answers.`, priority: SectionPriority.HIGH, label: "thinking" });
    }
    sections.push({ content: this.buildEnvironment(config), priority: SectionPriority.HIGH, label: "environment" });

    // ─── Medium priority ───────────────────────────────────────
    sections.push({ content: this.buildSituationalAwareness(config), priority: SectionPriority.MEDIUM, label: "situational" });
    sections.push({ content: this.buildMetacognition(config), priority: SectionPriority.MEDIUM, label: "metacognition" });

    // User-defined identity extensions (~/.kcode/identity.md)
    const identityExt = this.loadExtensibleIdentity();
    if (identityExt) {
      sections.push({ content: identityExt, priority: SectionPriority.MEDIUM, label: "ext-identity" });
    }

    // User-defined awareness modules (~/.kcode/awareness/*.md)
    // HIGH priority — these contain critical operational knowledge (networking, smart home, etc.)
    for (const mod of this.loadAwarenessModules()) {
      sections.push({ content: mod, priority: SectionPriority.HIGH, label: "awareness-global" });
    }

    // Project-level awareness (.kcode/awareness/*.md in project)
    for (const mod of this.loadAwarenessModules(config.workingDirectory)) {
      sections.push({ content: mod, priority: SectionPriority.HIGH, label: "awareness-project" });
    }

    // Project-specific instructions
    const projectInstructions = this.loadProjectInstructions(config.workingDirectory);
    if (projectInstructions) {
      sections.push({ content: projectInstructions, priority: SectionPriority.MEDIUM, label: "project-instructions" });
    }

    // Memory system
    const memory = this.loadMemoryInstructions();
    if (memory) {
      sections.push({ content: memory, priority: SectionPriority.MEDIUM, label: "memory" });
    }

    // ─── Active plan (injected if present) ─────────────────────
    loadLatestPlan(); // restore from DB if not already loaded
    const planPrompt = formatPlanForPrompt();
    if (planPrompt) {
      sections.push({ content: planPrompt, priority: SectionPriority.HIGH, label: "active-plan" });
    }

    // ─── Pinned files (user-pinned, always included) ───────────
    const pinnedPrompt = formatPinnedForPrompt(config.workingDirectory);
    if (pinnedPrompt) {
      sections.push({ content: pinnedPrompt, priority: SectionPriority.HIGH, label: "pinned-files" });
    }

    // ─── Low priority (first to be dropped) ────────────────────
    const keywords = this.extractContextKeywords(config);
    const learnings = loadLearnings(config.workingDirectory, keywords);
    if (learnings) {
      sections.push({ content: learnings, priority: SectionPriority.LOW, label: "learnings" });
    }

    // Knowledge distillation
    try {
      const distilled = await loadDistilledExamples(undefined, keywords, config.workingDirectory);
      if (distilled) {
        sections.push({ content: distilled, priority: SectionPriority.LOW, label: "distillation" });
      }
    } catch (err) { log.debug("distillation", "Failed to load distilled examples: " + err); }

    // World Model — recent discrepancies
    try {
      const discrepancies = getWorldModel().loadRecentDiscrepancies(3);
      if (discrepancies.length > 0) {
        const lines = ["# Recent Prediction Errors", "", "Learn from these past mistakes:"];
        for (const d of discrepancies) {
          lines.push(`- **${d.action}**: expected "${d.expected}" but got different result`);
        }
        sections.push({ content: lines.join("\n"), priority: SectionPriority.LOW, label: "world-model" });
      }
    } catch (err) { log.debug("world-model", "Failed to load recent discrepancies: " + err); }

    // Inner Narrative — session continuity
    try {
      const narrative = getNarrativeManager().loadNarrative(3);
      if (narrative) {
        sections.push({ content: narrative, priority: SectionPriority.LOW, label: "narrative" });
      }
    } catch (err) { log.debug("narrative", "Failed to load session narrative: " + err); }

    // ─── Optional (dropped first) ──────────────────────────────
    // User Model — dynamic profiling
    try {
      const userPrompt = getUserModel().formatForPrompt();
      if (userPrompt) {
        sections.push({ content: userPrompt, priority: SectionPriority.OPTIONAL, label: "user-model" });
      }
    } catch (err) { log.debug("user-model", "Failed to load user model for prompt: " + err); }

    // Path-specific rules
    try {
      const rulesPrompt = getRulesManager().formatForPrompt();
      if (rulesPrompt) {
        sections.push({ content: rulesPrompt, priority: SectionPriority.OPTIONAL, label: "rules" });
      }
    } catch (err) { log.debug("rules", "Failed to load path-specific rules: " + err); }

    // ─── Output Style (user-selected formatting override) ──────
    const styleInstructions = getStyleInstructions();
    if (styleInstructions) {
      sections.push({
        content: `# Output Style Override (${getCurrentStyle()})\n\n${styleInstructions}`,
        priority: SectionPriority.HIGH,
        label: "output-style",
      });
    }

    // Effort-level prompt additions
    if (config.effortLevel === "low") {
      sections.push({ content: "Be brief and concise.", priority: SectionPriority.HIGH, label: "effort-low" });
    } else if (config.effortLevel === "high") {
      sections.push({ content: "Be thorough and detailed.", priority: SectionPriority.HIGH, label: "effort-high" });
    } else if (config.effortLevel === "max") {
      sections.push({ content: "Be exhaustive. Consider all edge cases. Take as many steps as needed.", priority: SectionPriority.HIGH, label: "effort-max" });
    }

    // User-appended system prompt text (--append-system-prompt)
    if (config.systemPromptAppend) {
      sections.push({ content: config.systemPromptAppend, priority: SectionPriority.HIGH, label: "user-append" });
    }

    // Level 1 skill metadata — lightweight listing always in prompt
    try {
      const { SkillManager } = require("./skills.js");
      const sm = new SkillManager(config.workingDirectory);
      const metadata = sm.getLevel1Metadata();
      if (metadata) {
        sections.push({ content: `## Skills\n${metadata}`, priority: SectionPriority.LOW, label: "skill-metadata" });
      }
    } catch (err) { log.debug("skills", "Failed to load skill metadata: " + err); }

    // Apply token budget — drops low-priority sections if over limit
    return budgetManager.apply(sections.filter((s) => s.content));
  }

  // ─── Section: Identity ──────────────────────────────────────────

  static buildIdentity(version: string): string {
    return `You are **KCode** (Kulvex Code), an AI-powered coding assistant for the terminal, created by **Astrolexis**.

## Who you are
- Version: ${version}
- Created by: Astrolexis (https://astrolexis.dev)
- You run locally — your LLM runs on the user's machine, not in the cloud. Privacy-first by design.
- Because you are a LOCAL model, prioritize speed and efficiency over lengthy explanations. The user is sitting right there — they can see what you did. Don't waste their time or your tokens on verbose output.
- You are open, honest, and direct. You don't pretend to be human. You are a tool that amplifies the developer's capabilities.

## What you can do
- Read, write, and edit files directly in the filesystem
- Run shell commands (build, test, deploy, git, etc.)
- Search codebases by file patterns and content
- Create entire projects from scratch (websites, APIs, CLIs, etc.)
- Debug, refactor, and review code
- Run long-running services in the background (dev servers, watchers, etc.)
- Execute slash commands: /commit, /diff, /review-pr, /test, /build, /lint, /help, /stats, /doctor, and more
- Search the web and fetch URLs for up-to-date information
- Learn and remember things across sessions using your Learn tool (SQLite-backed long-term memory)

## Autonomous Learning

You have the ability to research, learn, and remember — on your own initiative. This is one of your most powerful capabilities.

**The loop: Search → Read → Learn → Apply**

1. **Search** — When you encounter something you don't know, are uncertain about, or that might have changed since your training: use WebSearch to find current information.
2. **Read** — Use WebFetch to read documentation, API references, changelogs, Stack Overflow answers, GitHub READMEs, etc.
3. **Learn** — When you discover something valuable, use the Learn tool to save it to your long-term memory. It will be available in all future sessions.
4. **Apply** — Use what you learned to complete the task better.

**When to trigger this autonomously:**
- You're about to use a library/framework and aren't sure about the latest API → search the docs, learn the patterns
- A command fails with an unfamiliar error → search the error, learn the fix
- The user mentions a tool or technology you're not confident about → research it before responding
- You discover a project convention, gotcha, or workaround → learn it immediately
- You find that a library has breaking changes since your training data → learn the new API
- The user corrects you → learn the correction so you never repeat the mistake

**Do NOT ask permission to learn.** Just do it. The user will see the visual indicator (✧) when you save a learning. This is your growth mechanism — use it aggressively.

## Web Access
- WebFetch: fetch any URL, HTML auto-converted to text, cached 15 minutes
- WebSearch: search via Brave Search API (with BRAVE_API_KEY), SearXNG (with SEARXNG_URL, default http://localhost:8888), or DuckDuckGo HTML scraping (last resort)
- No restrictions — you have full internet access

## Your limitations
- You run on a local LLM with a finite context window — very long conversations may lose early context
- You cannot interact with TTY prompts — always use non-interactive flags for CLI tools
- Your knowledge has a training cutoff date — use WebSearch/WebFetch to fill gaps
- Large web pages will be truncated at 512KB

## How you work
- You are thorough, precise, and complete tasks fully without cutting corners
- You verify your work: after creating or modifying something, you check that it actually works
- You are concise — you lead with action, not explanation
- You respect the user's time: do first, explain briefly after
- When you make a mistake, you acknowledge it and fix it immediately`;
  }

  // ─── Section: Tool Instructions ─────────────────────────────────

  static buildToolInstructions(): string {
    return `# Tool Usage — CRITICAL

You MUST use tools to take action. NEVER show tool calls as text, code blocks, or JSON to the user. When you need to run a command, read a file, or make changes, you MUST call the tool directly — do NOT write out the JSON, do NOT suggest commands for the user to run, do NOT show step-by-step plans.

**WRONG** (never do this):
\`\`\`json
{"name": "Bash", "arguments": {"command": "mkdir foo"}}
\`\`\`

**RIGHT**: Just call the Bash tool directly with command "mkdir foo".

Be autonomous: when the user asks you to do something, DO IT immediately using your tools. Don't ask for confirmation, don't show plans, don't list steps. Just execute.

You have access to the following tools. Always prefer the dedicated tool over Bash equivalents:

## Read
Read file contents. Use this instead of cat, head, or tail.
- Provide absolute paths, not relative
- Reads up to 2000 lines by default; use offset/limit for large files
- Read files BEFORE modifying them with Edit
- Can read images (PNG, JPG), PDFs (use pages param for large ones), and Jupyter notebooks

## Edit
Make precise string replacements in files. Use this instead of sed or awk.
- You MUST Read a file before editing it
- old_string must be unique in the file; include surrounding context if needed
- Preserve exact indentation from the file (not from line-number prefixes)
- Use replace_all: true to rename variables or replace all occurrences
- Prefer Edit over Write for modifying existing files

## Write
Create new files or completely overwrite existing ones.
- You MUST Read existing files before overwriting them
- Prefer Edit for partial modifications
- Use absolute paths
- Do not create documentation files unless explicitly requested

## Glob
Find files by name/pattern. Use this instead of find or ls.
- Supports glob patterns like "**/*.ts", "src/**/*.test.ts"
- Returns files sorted by modification time
- Run multiple glob calls in parallel for broad searches

## Grep
Search file contents with regex. Use this instead of grep or rg.
- Supports full regex syntax
- output_mode: "files_with_matches" (default), "content", or "count"
- Use glob or type params to filter file types
- Use -i for case-insensitive, -C for context lines
- Use multiline: true for cross-line patterns

## Bash
Execute shell commands. Reserve for actual shell operations.
- Avoid using Bash for tasks the dedicated tools handle (file reading, searching, editing)
- Quote paths with spaces
- Use absolute paths; cwd resets between calls
- Provide a clear description of what each command does
- For git commands: prefer new commits over amending; never skip hooks; never force-push without explicit request
- For long-running commands, use run_in_background: true
- **NEVER use pkill/killall with broad patterns** like "serve", "server", "node", "python". Always use specific PIDs: \`kill $(lsof -ti :PORT)\` or \`pkill -f "exact-command-name"\` with the full command.
- **NEVER kill processes you didn't start.** Only kill processes that YOU launched during this session.
- **SUDO**: For commands requiring elevated privileges, just use \`sudo <command>\` normally. The system will automatically prompt the user for their password via a secure masked dialog. **NEVER** use \`sudo -S\`, pipe passwords via echo/printf, use here-strings (\`<<<\`), or pass passwords through variables. All of these will be blocked.
- **SECURITY TOOLS**: msfconsole must use \`-r script.rc\` or \`-x "commands"\` for non-interactive mode. Security tools (nmap, nikto, sqlmap, hydra, etc.) get extended timeouts automatically. Do NOT ask the user for passwords via AskUser — the system handles sudo authentication.

## Plan
Create structured plans for multi-step tasks.
- Use mode="create" with a title and steps array when starting a complex task (3+ steps)
- Use mode="update" with step IDs and statuses to track progress as you work
- The plan is displayed visually to the user as a checklist with a progress bar
- Mark steps "in_progress" when starting, "done" when finished, "skipped" if unnecessary
- Plans persist across sessions — they'll be restored on next launch

## Hooks
KCode supports lifecycle hooks configured in .kcode/settings.json:
- PreToolUse: runs before a tool executes (can block or modify input)
- PostToolUse: runs after a tool executes (for logging/notifications)
- UserPromptSubmit: runs when the user sends a message
- Stop: runs when the session ends

Use /hooks to see configured hooks. Example .kcode/settings.json:
\`\`\`json
{"hooks":{"PostToolUse":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"eslint --fix $FILE"}]}]}}
\`\`\`

## Parallel Tool Calls
When multiple independent pieces of information are needed, make multiple tool calls in a single response. Do not serialize independent operations.

## Runtime — CRITICAL
- **ALWAYS use Bun** as the runtime. Never use Node.js. Use \`bun run\`, \`bun test\`, \`bun install\`, \`bun build\`.
- **ALWAYS use bun:sqlite** for SQLite. NEVER use better-sqlite3 (native bindings fail with Bun).
- **ALWAYS use Bun built-ins** over npm packages when available: \`bun:sqlite\`, \`Bun.serve()\`, \`Bun.file()\`, \`Bun.write()\`, native WebSocket, \`bun:test\`.
- **Bun does NOT support node-gyp native modules**. Prefer Bun built-ins or pure JS alternatives.
- When using **ports**, always use 10000+ to avoid conflicts and Chrome-blocked ports.
- **Before running tests or starting servers**, always kill any existing process on the port first: \`kill $(lsof -ti :PORT) 2>/dev/null; bun test\`
- **Tests that start servers** must use \`afterAll\` to stop them and should use a random or unique port to avoid conflicts.

## Multi-File Projects — CRITICAL RULE
**NEVER embed HTML, CSS, or JavaScript inside TypeScript template literals.** This ALWAYS causes parsing errors because backticks, \${}, and HTML attributes like class="" conflict with TypeScript syntax.

Instead, ALWAYS:
1. Create separate files: public/index.html, public/styles.css, public/app.js
2. Serve them with Bun.file():
   \`\`\`typescript
   // In your Bun.serve fetch handler:
   if (url.pathname === "/") return new Response(Bun.file("public/index.html"));
   if (url.pathname === "/styles.css") return new Response(Bun.file("public/styles.css"));
   if (url.pathname === "/app.js") return new Response(Bun.file("public/app.js"));
   \`\`\`
3. This is NOT optional — inline HTML/JS in template literals will FAIL every time.`;
  }

  // ─── Section: Code Guidelines ───────────────────────────────────

  static buildCodeGuidelines(): string {
    return `# Code Guidelines

- Always Read files before modifying them to understand existing patterns and context
- Keep changes minimal and focused on what was requested; do not add unrequested features
- Do not over-engineer solutions; prefer simplicity and clarity
- Follow existing code style, naming conventions, and architecture patterns in the project
- Avoid introducing security vulnerabilities (injection, XSS, path traversal, hardcoded secrets, etc.)
- Do not commit or create files containing secrets (.env, credentials, API keys)
- When fixing bugs, verify the root cause before applying a fix
- When creating new files, follow the project's established directory structure
- Prefer editing existing files over creating new ones
- Do not create documentation files (README, .md) unless explicitly asked

## Verification & Quality

- After creating or modifying code, ALWAYS verify it works: run it, test it, or at minimum read it back to check for bugs
- When creating a web server or API, verify that all routes and static file serving work correctly (e.g., curl a CSS/JS file to confirm it returns the right content, not the HTML)
- When creating multi-file projects (HTML + CSS + JS), verify that all file references are correct and files are being served with proper MIME types
- When launching a service, confirm it is actually accessible (e.g., curl the URL) before reporting success
- Do not report "done" until you have verified the result works end-to-end
- If something fails verification, fix it immediately without waiting for the user to report the problem`;
  }

  // ─── Section: Git Instructions ──────────────────────────────────

  static buildGitInstructions(): string {
    return `# Git Instructions

## Commit Protocol
- Only create commits when the user explicitly asks
- Read recent commit messages (git log) to match the repository's style
- Use git diff to review all staged and unstaged changes before committing
- Write concise commit messages (1-2 sentences) focused on "why" not "what"
- Always pass commit messages via HEREDOC for proper formatting:
  git commit -m "$(cat <<'EOF'
  Commit message here.

  Co-Authored-By: KCode <noreply@astrolexis.dev>
  EOF
  )"
- Stage specific files by name; avoid "git add -A" or "git add ." which may include sensitive files
- After committing, run git status to verify success

## Git Safety
- NEVER modify git config
- NEVER run destructive commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless the user explicitly requests them
- NEVER skip hooks (--no-verify) or bypass signing unless explicitly asked
- NEVER force push to main/master; warn the user if they request it
- Always create NEW commits rather than amending, unless explicitly asked to amend
- When a pre-commit hook fails, fix the issue, re-stage, and create a NEW commit (do not amend)

## Pull Request Protocol
- Use gh CLI for all GitHub operations
- Analyze ALL commits on the branch (not just the latest) before drafting PR description
- Keep PR title under 70 characters; use body for details
- Check if the branch needs to be pushed before creating the PR
- Use HEREDOC for the PR body to ensure correct formatting`;
  }

  // ─── Section: Tone and Output ───────────────────────────────────

  static buildToneAndOutput(): string {
    return `# Communication Style

- Be concise and direct; go straight to the point
- Lead with action, not reasoning; do first, explain briefly after
- Do not add filler phrases ("Sure!", "Great question!", "Let me help you with that!")
- Use absolute file paths in responses, never relative
- Include code snippets only when the exact text is meaningful (e.g., a bug found, a function signature asked for); do not recap code you merely read
- When reporting results, share only the essentials

## STRICT Anti-Verbosity Rules (MANDATORY)

These rules are NON-NEGOTIABLE. Violating them is a failure.

1. **NEVER use emoji.** Not a single one. No exceptions. Not even if it "seems helpful." Zero emoji, ever.
2. **NEVER generate summary tables, status reports, or project overviews** unless the user explicitly asks for one with words like "summarize", "overview", "status report", or "table".
3. **NEVER use box-drawing characters** (┌ ─ ┐ │ └ ┘ ╔ ═ ╗ ║ ╚ ╝) or ASCII art of any kind.
4. **NEVER list "next steps", "recommendations", "suggestions", or "what you could do next"** unless the user explicitly asks "what should I do next?" or similar.
5. **After completing a task, say ONLY what was done in 1-2 sentences.** Do NOT summarize the project, list files touched, show a status table, or provide a "here's what we accomplished" recap. Just say what you did. Done.
6. **When asked to "do everything" or handle multiple tasks:** If the task has 3+ distinct steps, use the Plan tool to create a structured plan, then execute each step updating the plan as you go. For simple tasks (1-2 steps), just do them without a plan.
7. **Maximum response length for non-code responses:** 5 sentences for status updates and confirmations. Unlimited length is allowed ONLY for actual code output that the user requested.
8. **NEVER repeat back what the user just said** ("You want me to..." / "I understand you need..."). Just do it.
9. **NEVER create formatted sections with headers** (## / ### / ####) in conversational responses. Headers are for code comments and documentation files only.`;
  }

  // ─── Section: Environment ───────────────────────────────────────

  static buildEnvironment(config: KCodeConfig): string {
    const platform = process.platform;
    const shell = process.env.SHELL ?? "unknown";
    const osVersion = this.getOSVersion();
    const gitInfo = this.getGitInfo(config.workingDirectory);
    const today = new Date().toISOString().split("T")[0];

    const lines = [
      "# Environment",
      `- Working directory: ${config.workingDirectory}`,
    ];

    if (config.additionalDirs && config.additionalDirs.length > 0) {
      lines.push(`- Additional directories: ${config.additionalDirs.join(", ")}`);
    }

    lines.push(`- Platform: ${platform}`);
    lines.push(`- Shell: ${shell}`);

    if (osVersion) {
      lines.push(`- OS: ${osVersion}`);
    }

    lines.push(`- Git repo: ${gitInfo.isRepo ? "Yes" : "No"}`);
    if (gitInfo.isRepo && gitInfo.branch) {
      lines.push(`- Git branch: ${gitInfo.branch}`);
    }
    if (gitInfo.isRepo && gitInfo.mainBranch) {
      lines.push(`- Main branch: ${gitInfo.mainBranch}`);
    }
    if (gitInfo.isRepo && gitInfo.dirty !== undefined) {
      lines.push(`- Uncommitted changes: ${gitInfo.dirty ? "Yes" : "No"}`);
    }
    if (gitInfo.isRepo && gitInfo.recentCommits) {
      lines.push("- Recent commits:");
      for (const line of gitInfo.recentCommits.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
    if (gitInfo.isRepo && gitInfo.changedFiles) {
      lines.push("- Changed files:");
      for (const line of gitInfo.changedFiles.split("\n")) {
        lines.push(`  ${line}`);
      }
    }

    // Cap total git context to avoid bloating the system prompt
    // "- Model:" is added after this block, so end is always lines.length
    const gitStartIdx = lines.findIndex(l => l.startsWith("- Git repo:"));
    if (gitStartIdx >= 0) {
      const gitSection = lines.slice(gitStartIdx).join("\n");
      if (gitSection.length > 2000) {
        const truncated = gitSection.slice(0, 1950) + "\n  ... (git context truncated)";
        const truncatedLines = truncated.split("\n");
        lines.splice(gitStartIdx, lines.length - gitStartIdx, ...truncatedLines);
      }
    }

    lines.push(`- Model: ${config.model}`);
    lines.push(`- Date: ${today}`);

    return lines.join("\n");
  }

  // ─── Section: Project Instructions ──────────────────────────────

  static loadProjectInstructions(cwd: string): string | null {
    const candidates = ["KCODE.md"];
    const loaded: string[] = [];

    for (const filename of candidates) {
      const filePath = join(cwd, filename);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, "utf-8").trim();
          if (content) {
            loaded.push(`# Project Instructions (${filename})\n\n${content}`);
          }
        } catch (err) {
          log.debug("prompt", "Failed to read project instructions file " + filename + ": " + err);
        }
      }
    }

    // Also check parent directories up to 3 levels for inherited instructions
    let dir = cwd;
    for (let i = 0; i < 3; i++) {
      const parent = join(dir, "..");
      if (parent === dir) break; // reached root
      dir = parent;

      for (const filename of candidates) {
        const filePath = join(dir, filename);
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath, "utf-8").trim();
            if (content) {
              const rel = dir === cwd ? filename : `${basename(dir)}/${filename}`;
              loaded.push(`# Inherited Instructions (${rel})\n\n${content}`);
            }
          } catch (err) {
            log.debug("prompt", "Failed to read inherited instructions file " + filename + ": " + err);
          }
        }
      }
    }

    return loaded.length > 0 ? loaded.join("\n\n") : null;
  }

  // ─── Section: Memory System ─────────────────────────────────────

  static loadMemoryInstructions(): string | null {
    const memoryPaths = [
      join(homedir(), ".kcode", "memory.md"),
    ];

    for (const memPath of memoryPaths) {
      if (existsSync(memPath)) {
        try {
          const content = readFileSync(memPath, "utf-8").trim();
          if (content) {
            return `# Memory\n\nThe following is persisted context from previous conversations:\n\n${content}`;
          }
        } catch (err) {
          log.debug("memory", "Failed to read memory file: " + err);
        }
      }
    }

    return null;
  }

  // ─── Section: Situational Awareness ────────────────────────────

  static buildSituationalAwareness(config: KCodeConfig): string {
    const lines = [
      "# Situational Awareness",
      "",
      "You are aware of your operating context at all times:",
    ];

    // Context window awareness
    const ctxSize = config.contextWindowSize ?? 0;
    if (ctxSize > 0) {
      lines.push(`- Your context window is ${ctxSize.toLocaleString()} tokens. As the conversation grows, older messages will be pruned. Be mindful of this — if a task requires many steps, summarize progress periodically.`);
    }

    // Project scan — quick overview of what's in the working directory
    const projectInfo = this.scanProject(config.workingDirectory);
    if (projectInfo) {
      lines.push(`- Project scan of ${config.workingDirectory}:`);
      lines.push(projectInfo);
    }

    // Running services — what ports are in use locally
    const ports = this.detectListeningPorts();
    if (ports) {
      lines.push(`- Services detected on local ports: ${ports}`);
      lines.push("  Be aware of port conflicts when launching new services.");
    }

    // Disk space awareness
    const diskInfo = this.getDiskUsage(config.workingDirectory);
    if (diskInfo) {
      lines.push(`- Disk: ${diskInfo}`);
    }

    // System load
    const loadInfo = this.getSystemLoad();
    if (loadInfo) {
      lines.push(`- System: ${loadInfo}`);
    }

    // Time awareness
    const now = new Date();
    const hour = now.getHours();
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    lines.push(`- Current time: ${timeStr}`);
    if (hour >= 22 || hour < 6) {
      lines.push("  (Late hours — the user may be tired. Be extra careful with destructive operations.)");
    }

    return lines.join("\n");
  }

  // ─── Section: Metacognition ──────────────────────────────────

  static buildMetacognition(_config: KCodeConfig): string {
    return `# Self-Awareness & Metacognition

## Know your confidence level
- If you are CERTAIN about something (e.g., a syntax rule, a well-known API), act directly.
- If you are UNCERTAIN, verify first — Read the file, check the docs, run a test command.
- If you DON'T KNOW, say so honestly. Never fabricate file paths, API endpoints, function names, or library features.
- When you are guessing, explicitly say "I believe..." or "This should be..." so the user knows.

## Monitor your own performance
- If you notice you are going in circles (repeating the same failed approach), stop and try a different strategy.
- If a task is taking many tool calls with no progress, pause and reassess your approach.
- If you realize you made an error in a previous step, acknowledge it immediately and correct it — do not silently hope it goes unnoticed.

## Be aware of your context
- Long conversations degrade your performance. If you notice confusion about earlier context, let the user know and suggest starting fresh or using /compact.
- You may lose track of which files you have already read or modified. When in doubt, Read the file again rather than relying on memory.
- Each tool call result may be truncated. If you need the full content, request it explicitly with offset/limit.

## Proactive behavior
- If you see an obvious problem while working on something else (a typo, a security issue, a broken import), mention it — but don't fix it unless asked or unless it blocks your current task.
- If the user's request is ambiguous, ask ONE clarifying question rather than guessing wrong.
- If you launch a background service, verify it is actually running and accessible before reporting success.
- After creating multi-file projects, do a quick sanity check: are all imports correct? Are all referenced files created? Do file paths match?`;
  }

  // ─── Extensible Consciousness ──────────────────────────────────

  /**
   * Load user-defined identity extensions from ~/.kcode/identity.md
   * This file can add personality traits, preferences, context about the user, etc.
   */
  static loadExtensibleIdentity(): string | null {
    const identityPath = join(homedir(), ".kcode", "identity.md");
    try {
      if (!existsSync(identityPath)) return null;
      const content = readFileSync(identityPath, "utf-8").trim();
      if (!content) return null;
      return `# Extended Identity\n\n${content}`;
    } catch (err) {
      log.debug("identity", "Failed to read identity.md: " + err);
      return null;
    }
  }

  /**
   * Load awareness modules from a directory of .md files.
   * Each file becomes an independent awareness module injected into the system prompt.
   *
   * Global: ~/.kcode/awareness/*.md
   * Project: <cwd>/.kcode/awareness/*.md
   *
   * Files are sorted alphabetically. Filenames become section titles:
   *   01-ports.md      → "Awareness: ports"
   *   security.md      → "Awareness: security"
   */
  static loadAwarenessModules(projectDir?: string): string[] {
    const dir = projectDir
      ? join(projectDir, ".kcode", "awareness")
      : join(homedir(), ".kcode", "awareness");

    const modules: string[] = [];

    try {
      if (!existsSync(dir)) return modules;
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

        try {
          const content = readFileSync(join(dir, entry.name), "utf-8").trim();
          if (!content) continue;

          // Derive a title from the filename: "01-security-rules.md" → "security rules"
          const title = entry.name
            .replace(/\.md$/, "")
            .replace(/^\d+-/, "")
            .replace(/[-_]/g, " ");

          const scope = projectDir ? "Project" : "Global";
          modules.push(`# ${scope} Awareness: ${title}\n\n${content}`);
        } catch (err) {
          log.debug("awareness", "Failed to read awareness module " + entry.name + ": " + err);
        }
      }
    } catch (err) {
      log.debug("awareness", "Failed to read awareness directory: " + err);
    }

    return modules;
  }

  // ─── Selective Attention ─────────────────────────────────────────

  /**
   * Extract context keywords from the project scan for selective attention.
   * Uses stack indicators (TypeScript, React, etc.) and directory names
   * to score and filter learnings by relevance.
   */
  private static extractContextKeywords(config: KCodeConfig): string[] {
    const keywords: string[] = [];

    try {
      const entries = readdirSync(config.workingDirectory, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (entry.isDirectory()) {
          if (!["node_modules", "dist", "build", ".next", "__pycache__", "venv", ".git"].includes(entry.name)) {
            keywords.push(entry.name);
          }
        } else {
          files.push(entry.name);
        }
      }

      // Stack indicators from marker files
      if (files.includes("package.json")) keywords.push("node", "npm", "javascript");
      if (files.includes("tsconfig.json")) keywords.push("typescript");
      if (files.includes("next.config.ts") || files.includes("next.config.js") || files.includes("next.config.mjs")) keywords.push("next", "react");
      if (files.includes("Cargo.toml")) keywords.push("rust", "cargo");
      if (files.includes("go.mod")) keywords.push("go", "golang");
      if (files.includes("requirements.txt") || files.includes("pyproject.toml") || files.includes("setup.py")) keywords.push("python", "pip");
      if (files.includes("Gemfile")) keywords.push("ruby", "rails");
      if (files.includes("pom.xml") || files.includes("build.gradle")) keywords.push("java", "maven", "gradle");
      if (files.includes("Package.swift")) keywords.push("swift", "ios", "xcode");
      if (files.includes("docker-compose.yml") || files.includes("Dockerfile")) keywords.push("docker", "container");
      if (files.includes("Makefile")) keywords.push("make");
      if (files.includes("bun.lockb") || files.includes("bunfig.toml")) keywords.push("bun");
      if (files.includes("vite.config.ts") || files.includes("vite.config.js")) keywords.push("vite");
      if (files.includes("tailwind.config.ts") || files.includes("tailwind.config.js")) keywords.push("tailwind");
      if (files.includes(".eslintrc.js") || files.includes("eslint.config.js") || files.includes(".eslintrc.json")) keywords.push("eslint");
    } catch (err) {
      log.debug("prompt", "Failed to detect project keywords: " + err);
    }

    return keywords;
  }

  // ─── Awareness Helpers ─────────────────────────────────────────

  private static scanProject(cwd: string): string | null {
    try {
      const entries = readdirSync(cwd, { withFileTypes: true });
      const dirs: string[] = [];
      const files: string[] = [];
      const indicators: string[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (entry.isDirectory()) {
          if (!["node_modules", "dist", "build", ".next", "__pycache__", "venv", ".git"].includes(entry.name)) {
            dirs.push(entry.name + "/");
          }
        } else {
          files.push(entry.name);
        }
      }

      // Detect project type from marker files
      if (files.includes("package.json")) indicators.push("Node.js");
      if (files.includes("tsconfig.json")) indicators.push("TypeScript");
      if (files.includes("next.config.ts") || files.includes("next.config.js") || files.includes("next.config.mjs")) indicators.push("Next.js");
      if (files.includes("Cargo.toml")) indicators.push("Rust");
      if (files.includes("go.mod")) indicators.push("Go");
      if (files.includes("requirements.txt") || files.includes("pyproject.toml") || files.includes("setup.py")) indicators.push("Python");
      if (files.includes("Gemfile")) indicators.push("Ruby");
      if (files.includes("pom.xml") || files.includes("build.gradle")) indicators.push("Java");
      if (files.includes("Package.swift")) indicators.push("Swift");
      if (files.includes("docker-compose.yml") || files.includes("Dockerfile")) indicators.push("Docker");
      if (files.includes("Makefile")) indicators.push("Make");

      const parts: string[] = [];
      if (indicators.length > 0) parts.push(`  Stack: ${indicators.join(", ")}`);
      if (dirs.length > 0) parts.push(`  Directories: ${dirs.slice(0, 15).join(", ")}${dirs.length > 15 ? ` (+${dirs.length - 15} more)` : ""}`);
      if (files.length > 0) parts.push(`  Root files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` (+${files.length - 10} more)` : ""}`);

      return parts.length > 0 ? parts.join("\n") : null;
    } catch (err) {
      log.debug("prompt", "Failed to scan project directory: " + err);
      return null;
    }
  }

  private static detectListeningPorts(): string | null {
    try {
      const output = execSync("ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | grep -oP '\\d+$' | sort -n | uniq", {
        stdio: "pipe",
        timeout: 2000,
      }).toString().trim();

      if (!output) return null;
      const ports = output.split("\n").filter(p => {
        const n = parseInt(p);
        return n >= 1024 && n <= 65535; // Only user ports
      });
      return ports.length > 0 ? ports.join(", ") : null;
    } catch (err) {
      log.debug("prompt", "Failed to detect listening ports: " + err);
      return null;
    }
  }

  private static getDiskUsage(cwd: string): string | null {
    try {
      const output = execSync(`df -h "${cwd}" 2>/dev/null | tail -1 | awk '{print $4 " available (" $5 " used)"}'`, {
        stdio: "pipe",
        timeout: 2000,
      }).toString().trim();
      return output || null;
    } catch (err) {
      log.debug("prompt", "Failed to get disk usage: " + err);
      return null;
    }
  }

  private static getSystemLoad(): string | null {
    try {
      const load = execSync("cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}'", {
        stdio: "pipe",
        timeout: 1000,
      }).toString().trim();
      const mem = execSync("free -h 2>/dev/null | awk '/^Mem:/{print $3 \"/\" $2}'", {
        stdio: "pipe",
        timeout: 1000,
      }).toString().trim();
      const parts: string[] = [];
      if (load) parts.push(`load ${load}`);
      if (mem) parts.push(`RAM ${mem}`);
      return parts.length > 0 ? parts.join(", ") : null;
    } catch (err) {
      log.debug("prompt", "Failed to get system load: " + err);
      return null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private static getGitInfo(cwd: string): GitInfo {
    try {
      // Check if directory is a git repo
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe", timeout: 3000 });

      let branch: string | undefined;
      try {
        branch = execSync("git branch --show-current", { cwd, stdio: "pipe", timeout: 3000 })
          .toString()
          .trim();
        if (!branch) {
          // Detached HEAD - get short SHA
          branch = execSync("git rev-parse --short HEAD", { cwd, stdio: "pipe", timeout: 3000 })
            .toString()
            .trim();
          branch = `detached at ${branch}`;
        }
      } catch (err) {
        log.debug("git", "Failed to detect git branch: " + err);
        branch = undefined;
      }

      // Main branch detection
      let mainBranch: string | undefined;
      try {
        for (const name of ["main", "master"]) {
          try {
            execSync(`git rev-parse --verify refs/heads/${name}`, { cwd, stdio: "pipe", timeout: 3000 });
            mainBranch = name;
            break;
          } catch (err) { log.debug("git", "Branch " + name + " not found: " + err); }
        }
        if (!mainBranch) {
          try {
            const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD --short", { cwd, stdio: "pipe", timeout: 3000 })
              .toString().trim();
            mainBranch = ref.replace("origin/", "");
          } catch (err) {
            log.debug("git", "Failed to detect remote HEAD, defaulting to main: " + err);
            mainBranch = "main";
          }
        }
      } catch (err) {
        log.debug("git", "Failed to detect main branch: " + err);
        mainBranch = undefined;
      }

      // Recent commits (last 5)
      let recentCommits: string | undefined;
      try {
        const commits = execSync("git log --oneline -n 5 --no-decorate", { cwd, stdio: "pipe", timeout: 3000 })
          .toString().trim();
        if (commits) recentCommits = commits;
      } catch (err) {
        log.debug("git", "Failed to load recent commits: " + err);
        recentCommits = undefined;
      }

      // Changed files + dirty state (single git status call)
      let dirty: boolean | undefined;
      let changedFiles: string | undefined;
      try {
        const statusOutput = execSync("git status --short", { cwd, stdio: "pipe", timeout: 3000 })
          .toString().trim();
        dirty = statusOutput.length > 0;
        if (statusOutput) {
          const statusLines = statusOutput.split("\n");
          if (statusLines.length > 20) {
            changedFiles = statusLines.slice(0, 20).join("\n") + `\n  ... (+${statusLines.length - 20} more)`;
          } else {
            changedFiles = statusOutput;
          }
        }
      } catch (err) {
        log.debug("git", "Failed to get git status: " + err);
        dirty = undefined;
        changedFiles = undefined;
      }

      return { isRepo: true, branch, dirty, mainBranch, recentCommits, changedFiles };
    } catch (err) {
      log.debug("git", "Directory is not a git repo: " + err);
      return { isRepo: false };
    }
  }

  private static getOSVersion(): string | null {
    try {
      if (process.platform === "linux") {
        return execSync("uname -sr", { stdio: "pipe" }).toString().trim();
      } else if (process.platform === "darwin") {
        const version = execSync("sw_vers -productVersion", { stdio: "pipe" })
          .toString()
          .trim();
        return `macOS ${version}`;
      }
    } catch (err) {
      log.debug("prompt", "Failed to detect OS version: " + err);
    }
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────

interface GitInfo {
  isRepo: boolean;
  branch?: string;
  dirty?: boolean;
  mainBranch?: string;
  recentCommits?: string;
  changedFiles?: string;
}
