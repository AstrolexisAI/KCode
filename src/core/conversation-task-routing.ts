// KCode - Task orchestrator routing
//
// Extracted from conversation.ts `sendMessage()` to keep the main
// class shell focused on orchestration. This module decides, for a
// given user message, whether the turn can be handled
// deterministically (0 LLM tokens) or needs to fall through to the
// LLM — and, in the latter case, produces an orchestrated prompt
// that pre-fills context the LLM would otherwise have to discover.
//
// Levels:
//
//   0. Workflow chains     — detect "audita y arregla y commitea"
//                            style multi-step chains, run them
//                            directly. 0 tokens.
//   1. Level-1 handlers    — "git status", "run tests", etc. —
//                            pure-regex dispatch. 0 tokens.
//   2. Task classifier     — implement/test/debug/... — builds a
//                            focused LLM prompt from collected
//                            evidence. Variable tokens.
//
// Side effects that stay inside this module: pushing synthetic
// assistant/user messages into `state.messages`, updating
// `config.workingDirectory` (web-engine path), calling
// `setToolWorkspace`, `process.chdir`, and writing the
// last-project marker.
//
// The return value describes what the caller (`sendMessage`) must
// do next:
//
//   { action: "handled", events, [replaceUserMessage] }
//       — We handled the turn entirely. Caller yields `events`,
//         skips the whole LLM path, and returns.
//   { action: "continue", orchestratedMessage }
//       — We did NOT handle the turn. Caller should push
//         `orchestratedMessage` (possibly rewritten from the raw
//         userMessage) to state and proceed to the LLM.

import { log } from "./logger";
import type { KCodeConfig, StreamEvent, ConversationState } from "./types";

/**
 * Normalize content for an assistant message. If the orchestrator produced
 * empty/null output, fall back to a placeholder so the API doesn't reject
 * the request with "Each message must have at least one content element".
 */
function safeAssistantContent(content: unknown): string {
  if (typeof content === "string" && content.trim().length > 0) return content;
  if (Array.isArray(content) && content.length > 0) {
    const hasReal = (content as Array<{ type: string; text?: string }>).some(
      (b) => b.type !== "text" || (b.text ?? "").trim().length > 0,
    );
    if (hasReal) return JSON.stringify(content); // shouldn't hit, but keep a string fallback
  }
  return "[orchestrator produced no output]";
}

export type TaskRoutingResult =
  | {
      action: "handled";
      events: StreamEvent[];
    }
  | {
      action: "continue";
      orchestratedMessage: string;
      preLlmEvents: StreamEvent[];
    };

export interface TaskRoutingDeps {
  state: ConversationState;
  config: KCodeConfig;
  userMessage: string;
}

export async function runTaskRouting(deps: TaskRoutingDeps): Promise<TaskRoutingResult> {
  const { state, config, userMessage } = deps;

  // Pre-LLM event buffer. Populated by non-terminating passes (agent
  // intent detection) and prepended to ANY handled-branch events so
  // the dispatch summary survives even when a later level-1 / engine
  // path claims the turn. Level-0 chain detection returns before this
  // is populated, so its handled() calls don't need the prepend.
  const preLlmEvents: StreamEvent[] = [];
  const handled = (events: StreamEvent[]): TaskRoutingResult => ({
    action: "handled",
    events: [...preLlmEvents, ...events],
  });

  // ── Level 0: multi-step workflow chain ────────────────────────
  // Detect "audita y arregla y commitea" / "benchmark then deploy"
  // and run the deterministic chain. 0 tokens.
  try {
    const { detectChain, executeChain } = await import("./task-orchestrator/workflow-chain.js");
    const chain = detectChain(userMessage);
    if (chain) {
      state.messages.push({ role: "user", content: userMessage });
      const lines: string[] = [`  ⛓ Workflow: ${chain}\n`];
      const result = await executeChain(chain, config.workingDirectory, (step) => {
        const icon =
          step.status === "done"
            ? "✅"
            : step.status === "failed"
              ? "❌"
              : step.status === "skipped"
                ? "⏭"
                : step.status === "running"
                  ? "⚡"
                  : "⏳";
        if (step.status !== "pending") {
          lines.push(
            `  ${icon} ${step.name}${step.durationMs ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : ""}` +
              (step.output ? `\n     ${step.output.split("\n")[0]?.slice(0, 80)}` : ""),
          );
        }
      });
      lines.push("");
      lines.push(result.success ? "  ✅ Workflow complete" : "  ⚠️ Workflow completed with issues");
      lines.push(`  Total: ${(result.totalMs / 1000).toFixed(1)}s`);
      const output = lines.join("\n");
      state.messages.push({ role: "assistant", content: safeAssistantContent(output) });
      log.info(
        "orchestrator",
        `Chain "${chain}" completed: ${result.steps.length} steps, ${result.totalMs}ms, 0 tokens`,
      );
      return {
        action: "handled",
        events: [
          { type: "text", text: output } as unknown as StreamEvent,
          { type: "turn_end", inputTokens: 0, outputTokens: 0 } as unknown as StreamEvent,
        ],
      };
    }
  } catch (err) {
    log.debug("orchestrator", `Chain detection skipped: ${err}`);
  }

  // ── Agent intent (non-terminating) ────────────────────────────
  // "liberemos 3 agentes para auditar backend" → spawn via pool.
  // Does NOT end the turn — the LLM still responds, just with the
  // dispatch summary already rendered.
  try {
    const { detectAgentIntent } = await import("./agents/intent.js");
    const intent = detectAgentIntent(userMessage, config.workingDirectory);
    if (intent && intent.detected && intent.spawned.length > 0) {
      state.messages.push({ role: "user", content: userMessage });
      preLlmEvents.push({ type: "text_delta", text: intent.message + "\n\n" } as StreamEvent);
      // Fall through — LLM gets the next-step framing.
    }
  } catch (err) {
    log.debug("agents", `Intent detection skipped: ${err}`);
  }

  // ── Level 1: deterministic handlers ───────────────────────────
  // "git status", "run tests", dev-server verbs. Skipped under
  // customFetch (in-process test harness) because the regexes would
  // swallow test prompts before they hit the scripted fake provider.
  if (!config.customFetch) {
    try {
      const { tryLevel1 } = await import("./task-orchestrator/level1-handlers.js");
      const lower = userMessage.toLowerCase().trim();
      const isSlowCommand =
        /(?:levant|start|run\s|launch|arranca|build|compile|construir)/.test(lower) &&
        !/\b(?:create|make|crea|genera)\b/.test(lower);

      if (isSlowCommand) {
        const { engineState, resetEngineState } = await import("./engine-progress.js");
        resetEngineState();
        engineState.active = true;
        engineState.startTime = Date.now();

        const isBuild = /^(?:build|compile|construir|compilar)/i.test(lower);
        engineState.phase = isBuild ? "Building project..." : "Starting server...";
        engineState.step = 1;
        engineState.totalSteps = isBuild ? 2 : 3;

        await new Promise((r) => setTimeout(r, 100));

        if (!isBuild) {
          engineState.phase = "Installing dependencies...";
          engineState.step = 2;
        }

        const l1 = tryLevel1(userMessage, config.workingDirectory);
        if (l1.handled) {
          engineState.phase = isBuild ? "Build complete!" : "Server started!";
          engineState.step = engineState.totalSteps;
          await new Promise((r) => setTimeout(r, 200));
          engineState.active = false;

          state.messages.push({ role: "user", content: userMessage });
          state.messages.push({ role: "assistant", content: safeAssistantContent(l1.output) });
          log.info("orchestrator", `Level 1 handled: "${userMessage.slice(0, 40)}..." → 0 tokens`);
          return handled([
              { type: "turn_start" } as unknown as StreamEvent,
              { type: "text_delta", text: l1.output } as unknown as StreamEvent,
              {
                type: "turn_end",
                inputTokens: 0,
                outputTokens: 0,
                stopReason: "end_turn",
              } as unknown as StreamEvent,
            ]);
        }
        engineState.active = false;
      } else {
        const l1 = tryLevel1(userMessage, config.workingDirectory);
        if (l1.handled) {
          state.messages.push({ role: "user", content: userMessage });
          state.messages.push({ role: "assistant", content: safeAssistantContent(l1.output) });
          log.info("orchestrator", `Level 1 handled: "${userMessage.slice(0, 40)}..." → 0 tokens`);
          return handled([
              { type: "turn_start" } as unknown as StreamEvent,
              { type: "text_delta", text: l1.output } as unknown as StreamEvent,
              {
                type: "turn_end",
                inputTokens: 0,
                outputTokens: 0,
                stopReason: "end_turn",
              } as unknown as StreamEvent,
            ]);
        }
      }
    } catch (err) {
      log.debug("orchestrator", `Level 1 skipped: ${err}`);
    }
  }

  // ── Level 2: task classifier → engine dispatch ─────────────────
  let orchestratedMessage = userMessage;
  try {
    const { classifyTask } = await import("./task-orchestrator/classifier.js");
    const task = classifyTask(userMessage);

    if (task.type !== "general" && task.confidence >= 0.8) {
      // "make X / fix X / update X" are modifications — don't auto-
      // scaffold, let the LLM edit. "create X / new X / genera X" are
      // fresh scaffolds — engine path eligible.
      const isModification =
        /\b(?:make|hazlo|fix|arregla|change|cambia|update|actualiza|add|agrega|remove|quita|improve|mejora|refactor|move|mueve|delete|borra|resize|collaps|expand|drag)\b/i.test(
          userMessage,
        ) &&
        !/\b(?:create|crea|build|construye|scaffold|genera|new|nueva?o?)\b/i.test(userMessage);

      // Explicit non-web stack mention nukes the web-engine path.
      // "Python 3.11+ terminal dashboard" must NOT trigger a Next.js
      // auto-scaffold. Checked first so nothing downstream fires.
      const mentionsNonWebStack =
        /\b(?:python|rust|go(?:lang)?|c\+\+|ruby|elixir|erlang|zig|haskell|scala)\b/i.test(
          userMessage,
        ) ||
        /\b(?:cli|terminal|tui|curses|textual|rich|typer|click|ink|tauri)\b/i.test(userMessage) ||
        /\b(?:pip\s+install|pyinstaller|cargo|gradle|maven|gem\s+install)\b/i.test(userMessage);

      // Web-engine auto-scaffold is off by default. Too many misfires
      // in the past (the Python+textual "btctop" prompt triggered a
      // Next.js scaffold). Opt in with KCODE_EXPERIMENTAL_SCAFFOLD=1.
      const webEngineEnabled = !!process.env.KCODE_EXPERIMENTAL_SCAFFOLD;
      const isWebRequest =
        webEngineEnabled &&
        !isModification &&
        !mentionsNonWebStack &&
        /\b(?:website|web\s*(?:site|app|page)|landing|dashboard|blog|portfolio|store|shop|tienda|sitio\s*web|p[aá]gina\s*web|saas|e-?commerce|trading|social|chat|crm|kanban|lms|course|education|iot|monitor|analytics|admin\s*panel|feed|board|panel|platform)\b/i.test(
          userMessage,
        );

      if (task.type === "implement" && !isModification) {
        const { detectCodeEngine, runCodeEngine } = await import("./code-engine-router.js");
        const engineMatch = detectCodeEngine(userMessage);

        let engineHandled = false;

        if (engineMatch) {
          try {
            const result = await runCodeEngine(
              engineMatch.engine,
              userMessage,
              config.workingDirectory,
            );
            if (result) {
              const hasLlmFiles =
                result.includes("LLM customization") ||
                result.includes("need LLM") ||
                !result.includes("0 LLM");
              if (!hasLlmFiles) {
                state.messages.push({ role: "user", content: userMessage });
                state.messages.push({ role: "assistant", content: safeAssistantContent(result) });
                log.info(
                  "orchestrator",
                  `Engine handled 100% machine: ${engineMatch.engine} (0 tokens)`,
                );
                return handled([
                    { type: "turn_start" } as unknown as StreamEvent,
                    { type: "text_delta", text: result } as unknown as StreamEvent,
                    {
                      type: "turn_end",
                      inputTokens: 0,
                      outputTokens: 0,
                      stopReason: "end_turn",
                    } as unknown as StreamEvent,
                  ]);
              }
              orchestratedMessage = result;
              engineHandled = true;
              log.info(
                "orchestrator",
                `${engineMatch.engine} engine + LLM for: "${userMessage.slice(0, 50)}"`,
              );
            }
          } catch (err) {
            log.debug("code-engine", `${engineMatch.engine} engine skipped: ${err}`);
          }
        }

        if (!engineHandled && isWebRequest) {
          const webResult = await runWebEngine({
            state,
            config,
            userMessage,
            preLlmEvents,
          });
          if (webResult.action === "handled") return handled(webResult.events);
          if (webResult.action === "delegate-to-llm") {
            orchestratedMessage = webResult.orchestratedMessage;
            engineHandled = true;
          }
        }

        if (!engineHandled) {
          try {
            const { buildImplementPrompt } = await import("./implement-engine/scaffold.js");
            const result = buildImplementPrompt(userMessage, config.workingDirectory);
            orchestratedMessage = result.prompt;
            log.info(
              "orchestrator",
              `Implement engine: ${result.project.framework} (${result.project.language}), ` +
                `${result.patterns.length} patterns found, ${result.estimatedFiles.length} files to create`,
            );
          } catch (err) {
            log.debug("implement-engine", `Implement engine skipped: ${err}`);
          }
        }
      } else if (task.type === "test") {
        try {
          const { buildTestPrompt } = await import("./test-engine/generator.js");
          const files = task.entities.files ?? [];
          if (files.length > 0) {
            const result = buildTestPrompt(files[0]!, userMessage, config.workingDirectory);
            orchestratedMessage = result.prompt;
            log.info(
              "orchestrator",
              `Test engine: ${result.functions.length} functions, ` +
                `${result.edgeCases.length} edge cases, framework: ${result.framework.name}`,
            );
          }
        } catch (err) {
          log.debug("test-engine", `Test engine skipped: ${err}`);
        }
      } else if (task.type === "debug") {
        try {
          const { collectEvidence, buildDebugPrompt } = await import(
            "./debug-engine/evidence-collector.js"
          );
          const evidence = await collectEvidence({
            files: task.entities.files ?? [],
            errorMessage: task.entities.error,
            cwd: config.workingDirectory,
          });
          orchestratedMessage = buildDebugPrompt(evidence, userMessage);
          log.info(
            "orchestrator",
            `Debug engine: ${evidence.targetFiles.length} files, ` +
              `${evidence.errorPatterns.length} error patterns, ` +
              `${evidence.testFiles.length} test files, ` +
              `${evidence.callers.length} callers`,
          );
        } catch (err) {
          log.debug("debug-engine", `Debug engine skipped: ${err}`);
        }
      } else {
        const { runPipeline } = await import("./task-orchestrator/pipelines.js");
        const pipelineResult = await runPipeline(task, config.workingDirectory);
        if (pipelineResult) {
          orchestratedMessage = pipelineResult.prompt;
          log.info(
            "orchestrator",
            `Classified "${task.type}" (${(task.confidence * 100).toFixed(0)}%) → ` +
              `${pipelineResult.steps.length} pipeline steps, ` +
              `${pipelineResult.context.length} chars context`,
          );
        }
      }
    }
  } catch (err) {
    log.debug("orchestrator", `Pipeline skipped: ${err}`);
  }

  return { action: "continue", orchestratedMessage, preLlmEvents };
}

// ── Web engine handler (extracted for readability) ────────────────

type WebEngineResult =
  | { action: "handled"; events: StreamEvent[] }
  | { action: "delegate-to-llm"; orchestratedMessage: string }
  | { action: "skip" };

async function runWebEngine(deps: {
  state: ConversationState;
  config: KCodeConfig;
  userMessage: string;
  preLlmEvents: StreamEvent[];
}): Promise<WebEngineResult> {
  const { state, config, userMessage } = deps;
  try {
    log.info("orchestrator", `Trying web engine for: "${userMessage.slice(0, 50)}"`);

    const { engineState, resetEngineState } = await import("./engine-progress.js");
    resetEngineState();
    engineState.active = true;
    engineState.phase = "Detecting project type...";
    engineState.step = 0;
    engineState.startTime = Date.now();

    const { createWebProject } = await import("./web-engine/web-engine.js");
    const webResult = createWebProject(userMessage, config.workingDirectory);
    log.info(
      "orchestrator",
      `Web engine result: type=${webResult.intent.siteType} machine=${webResult.machineFiles} llm=${webResult.llmFiles}`,
    );
    const totalFiles = webResult.machineFiles + webResult.llmFiles;

    if (webResult.llmFiles === 0) {
      // 100% machine — buffer progress updates + terminal events.
      engineState.siteType = webResult.intent.siteType;
      engineState.projectPath = webResult.projectPath;
      engineState.startTime = Date.now();
      engineState.totalSteps = 4;

      const events: StreamEvent[] = [{ type: "turn_start" } as StreamEvent];

      engineState.phase = "Scaffolding project...";
      engineState.step = 1;
      await new Promise((r) => setTimeout(r, 200));

      engineState.phase = `Writing ${totalFiles} files...`;
      engineState.step = 2;
      await new Promise((r) => setTimeout(r, 200));

      config.workingDirectory = webResult.projectPath;
      (require("../tools/workspace") as typeof import("../tools/workspace")).setToolWorkspace(
        webResult.projectPath,
      );
      try {
        process.chdir(webResult.projectPath);
        const { writeFileSync } = await import("node:fs");
        const { kcodePath } = await import("./paths.js");
        writeFileSync(kcodePath("last-project"), webResult.projectPath);
      } catch {
        /* last-project marker best-effort */
      }

      const runMatch = userMessage.match(/(?:levant|run|start|launch|arranca|ejecuta|inicia|lanza)/i);
      const portMatch = userMessage.match(/(?:(?:en|on|at)\s+)?(?:(?:el\s+)?puerto|port)\s+(\d+)/i);
      let runOutput = "";
      if (runMatch) {
        const port = portMatch?.[1] ? parseInt(portMatch[1], 10) : 10080;
        engineState.phase = "Installing dependencies...";
        engineState.step = 3;
        await new Promise((r) => setTimeout(r, 200));

        const { tryLevel1 } = await import("./task-orchestrator/level1-handlers.js");
        const l1 = tryLevel1(`levantalo en el puerto ${port}`, webResult.projectPath);

        engineState.phase = "Server started!";
        engineState.step = 4;
        if (l1.handled) runOutput = "\n" + l1.output;
      } else {
        engineState.phase = "Done!";
        engineState.step = 4;
      }

      await new Promise((r) => setTimeout(r, 300));
      engineState.active = false;

      const summary = [
        `  ✅ ${webResult.intent.siteType} — ${totalFiles} files (${webResult.machineFiles} machine, 0 LLM)`,
        `  📁 ${webResult.projectPath}`,
      ].join("\n");

      const finalText =
        summary +
        runOutput +
        (runMatch ? "" : `\n\n  To run: "levantalo en el puerto 15623"`);
      events.push({ type: "text_delta", text: finalText + "\n" } as StreamEvent);

      state.messages.push({ role: "user", content: userMessage });
      state.messages.push({ role: "assistant", content: safeAssistantContent(summary) });
      events.push({
        type: "turn_end",
        inputTokens: 0,
        outputTokens: 0,
        stopReason: "end_turn",
      } as StreamEvent);
      log.info(
        "orchestrator",
        `Web engine 100% machine: ${webResult.intent.siteType} (0 tokens)${runMatch ? " + auto-serve" : ""}`,
      );
      return { action: "handled", events };
    }

    // LLM files present — send focused prompt to the LLM.
    engineState.active = false;
    const orchestratedMessage =
      `${webResult.prompt}\n\nThe machine already created ${webResult.machineFiles} files at ${webResult.projectPath}.\n` +
      `You MUST only edit the ${webResult.llmFiles} files marked for LLM customization.\n` +
      `Do NOT create new files or restructure the project. Only customize content.\nUSER REQUEST: "${userMessage}"`;
    log.info(
      "orchestrator",
      `Web engine + LLM: ${webResult.intent.siteType} (${webResult.llmFiles} files to customize)`,
    );
    return { action: "delegate-to-llm", orchestratedMessage };
  } catch (err) {
    try {
      const { engineState } = await import("./engine-progress.js");
      engineState.active = false;
    } catch {
      /* engine-progress optional */
    }
    log.debug("web-engine", `Web engine skipped: ${err}`);
    return { action: "skip" };
  }
}
