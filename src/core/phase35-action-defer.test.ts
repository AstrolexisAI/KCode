// Phase 35 — action-defer nudge tests.
//
// Local models (Gemma 4, mark6-31b) produce verbose plans and ask
// "¿Deseas que me enfoque en algún vector?" instead of executing
// tools. Phase 35 detects this and injects a nudge to force
// tool execution.
//
// We can't run the full handlePostTurn path here (it has heavy
// imports), so we test the detection logic in isolation: action
// intent in user text + deferral pattern in assistant text.

import { describe, expect, test } from "bun:test";

// ─── Extracted detection logic (mirrors conversation-post-turn.ts) ──

const DEFERRAL_PATTERNS = [
  /\?[\s\n]*$/,
  /¿(?:Deseas|Quieres|Prefieres|Cómo quieres|Te gustaría)\b/i,
  /\b(?:Would you like|Do you want|Shall I|Should I|How would you like)\b/i,
  /\b(?:¿(?:Empiezo|Procedo|Continúo|Inicio))\b/i,
  /\b(?:Let me know|Dime cómo|Dime si)\b/i,
  // v2.10.86b: intention-without-execution patterns
  /\b(?:Próximos\s+(?:Pasos|pasos)|Next\s+Steps)\b/i,
  /\b(?:Voy\s+a\s+(?:proceder|realizar|ejecutar|analizar|leer|revisar))\b/i,
  /\b(?:I(?:'ll| will)\s+(?:start|begin|proceed|analyze|read|review|examine))\b/i,
  /(?:Leeré|Analizaré|Revisaré|Evaluaré|Inspeccionaré)/i,
];

const ACTION_INTENT =
  /\b(audit[ae]?|crea|create|build|fix|arregl[ae]|implement[ae]?|haz|make|run|test|review|revis[ae]|analiz[ae]|genera|deploy|install[ae]?|configur[ae]|escrib[ae]|write|refactor|debug|soluciona|resuelv[ae]|ejecut[ae]|lanz[ae]|compil[ae])\b/i;

function hasDeferral(text: string): boolean {
  return DEFERRAL_PATTERNS.some((p) => p.test(text));
}

function hasActionIntent(text: string): boolean {
  return ACTION_INTENT.test(text);
}

describe("Phase 35 — action intent detection", () => {
  test("detects Spanish action verbs", () => {
    expect(hasActionIntent("audita todo este proyecto")).toBe(true);
    expect(hasActionIntent("crea una aplicación web")).toBe(true);
    expect(hasActionIntent("arregla el bug del login")).toBe(true);
    expect(hasActionIntent("analiza el código")).toBe(true);
    expect(hasActionIntent("genera un reporte")).toBe(true);
    expect(hasActionIntent("soluciona el problema")).toBe(true);
    expect(hasActionIntent("ejecuta los tests")).toBe(true);
  });

  test("detects English action verbs", () => {
    expect(hasActionIntent("audit this project")).toBe(true);
    expect(hasActionIntent("create a web app")).toBe(true);
    expect(hasActionIntent("fix the login bug")).toBe(true);
    expect(hasActionIntent("build the project")).toBe(true);
    expect(hasActionIntent("run the tests")).toBe(true);
    expect(hasActionIntent("write a Python script")).toBe(true);
    expect(hasActionIntent("deploy to production")).toBe(true);
  });

  test("does NOT match non-action messages", () => {
    expect(hasActionIntent("what is this project?")).toBe(false);
    expect(hasActionIntent("explain how it works")).toBe(false);
    expect(hasActionIntent("how many files are there?")).toBe(false);
    expect(hasActionIntent("I like this code")).toBe(false);
    expect(hasActionIntent("tell me about the architecture")).toBe(false);
  });
});

describe("Phase 35 — deferral detection", () => {
  test("detects Spanish deferral questions", () => {
    expect(hasDeferral("¿Deseas que me enfoque en algún vector en particular?")).toBe(true);
    expect(hasDeferral("¿Quieres que proceda con el análisis completo?")).toBe(true);
    expect(hasDeferral("¿Prefieres que empiece por la seguridad?")).toBe(true);
    expect(hasDeferral("Dime cómo quieres continuar.")).toBe(true);
    expect(hasDeferral("¿Empiezo con la auditoría de seguridad?")).toBe(true);
  });

  test("detects English deferral questions", () => {
    expect(hasDeferral("Would you like me to focus on security first?")).toBe(true);
    expect(hasDeferral("Do you want me to proceed?")).toBe(true);
    expect(hasDeferral("Shall I start with the audit?")).toBe(true);
    expect(hasDeferral("Let me know how you'd like to proceed.")).toBe(true);
    expect(hasDeferral("Should I focus on the core module?")).toBe(true);
  });

  test("detects responses ending with question mark", () => {
    expect(hasDeferral("I have a plan. Ready to proceed?")).toBe(true);
    expect(hasDeferral("That covers the overview.\n\n?")).toBe(true);
  });

  test("does NOT match non-deferral text", () => {
    expect(hasDeferral("Here are the findings from the audit.")).toBe(false);
    expect(hasDeferral("I found 3 bugs in the code.")).toBe(false);
    expect(hasDeferral("The fix has been applied successfully.")).toBe(false);
    expect(hasDeferral("Done. All tests pass.")).toBe(false);
  });

  // v2.10.86b: intention-without-execution patterns
  test("detects Spanish intention declarations (Gemma 4 pattern)", () => {
    expect(hasDeferral("Leeré src/core/permissions.ts para entender el modelo")).toBe(true);
    expect(hasDeferral("Analizaré la jerarquía de configuración")).toBe(true);
    expect(hasDeferral("Revisaré el flujo de datos")).toBe(true);
    expect(hasDeferral("Voy a proceder con el análisis")).toBe(true);
    expect(hasDeferral("Voy a realizar las siguientes acciones")).toBe(true);
    expect(hasDeferral("Voy a leer los archivos principales")).toBe(true);
  });

  test("detects English intention declarations", () => {
    expect(hasDeferral("I'll start by reading the core module")).toBe(true);
    expect(hasDeferral("I will proceed with the security analysis")).toBe(true);
    expect(hasDeferral("I'll analyze the permission system")).toBe(true);
    expect(hasDeferral("I will review the configuration flow")).toBe(true);
  });

  test("detects 'Próximos Pasos' / 'Next Steps' headers", () => {
    expect(hasDeferral("Próximos Pasos Inmediatos:\n1. Leer el código")).toBe(true);
    expect(hasDeferral("Next Steps:\n- Read the source")).toBe(true);
  });
});

describe("Phase 35 — combined (NEXUS mark6 canonical case)", () => {
  test("Gemma 4 audit plan + deferral → should trigger nudge", () => {
    const userMsg = "audita todo este proyecto";
    const assistantText = `Para realizar una auditoría exhaustiva de este proyecto, necesito primero entender la arquitectura completa.

Voy a proceder en fases:
1. Exploración y Mapeo
2. Análisis de Seguridad
3. Análisis de Calidad
4. Informe de Hallazgos

¿Deseas que me enfoque en algún vector en particular o procedo con el análisis exhaustivo de seguridad primero?`;

    expect(hasActionIntent(userMsg)).toBe(true);
    expect(hasDeferral(assistantText)).toBe(true);
  });

  test("Model that declares intent with 0 tool calls IS a deferral", () => {
    const userMsg = "audita todo este proyecto";
    const assistantText = `Voy a leer los archivos principales del proyecto para comenzar la auditoría.`;
    // If the model said "Voy a leer" but has ZERO tool calls, that's
    // a plan-without-action — phase 35 should nudge. In the runtime,
    // if the model actually called Read, toolCalls.length > 0 and
    // phase 35 never enters this path.
    expect(hasActionIntent(userMsg)).toBe(true);
    expect(hasDeferral(assistantText)).toBe(true);
  });

  test("Model that produces findings → should NOT trigger nudge", () => {
    const userMsg = "audita todo este proyecto";
    const assistantText = `He analizado el código y encontré 3 vulnerabilidades:\n1. SQL injection en login.ts:45\n2. Path traversal en api.ts:92\n3. Missing auth check en admin.ts:12`;
    // Actual findings text (no intention declarations, no questions)
    expect(hasActionIntent(userMsg)).toBe(true);
    expect(hasDeferral(assistantText)).toBe(false);
  });

  test("Informational question from user → should NOT trigger nudge", () => {
    const userMsg = "what does this project do?";
    const assistantText = "Would you like me to explain the architecture in detail?";
    // User asked an informational question, so even though the model
    // deferred, the user didn't have action intent — no nudge.
    expect(hasActionIntent(userMsg)).toBe(false);
    expect(hasDeferral(assistantText)).toBe(true);
  });

  test("Gemma 4 v2.10.86 canonical failure — plan + 'Próximos Pasos' no question", () => {
    const userMsg = "audita todo este proyecto";
    const assistantText = `Para realizar una auditoría exhaustiva de este proyecto...

🛡️ 1. Auditoría de Seguridad (Security Audit)
...
⚙️ 2. Auditoría de Robustez y Estabilidad
...

🚀 Próximos Pasos Inmediatos
Para empezar la ejecución, voy a realizar las siguientes acciones técnicas:
 1. Análisis de la herramienta Bash: Leeré src/tools/index.ts
 2. Revisión de Permisos: Analizaré src/core/permissions.ts
 3. Inspección de Configuración: Revisaré src/core/config.ts`;

    expect(hasActionIntent(userMsg)).toBe(true);
    // MUST trigger — this was the v2.10.86 failure where phase 35
    // didn't fire because the model used intention declarations
    // instead of question-based deferrals.
    expect(hasDeferral(assistantText)).toBe(true);
  });

  test("grok planning style also triggers", () => {
    const userMsg = "crea una aplicación web llamada NEXUS Telemetry";
    const assistantText = `Voy a crear una aplicación increíble. Mi plan:
- HTML5 + Tailwind CSS
- Chart.js para gráficos
- Lucide Icons

¿Quieres que proceda con esta arquitectura?`;

    expect(hasActionIntent(userMsg)).toBe(true);
    expect(hasDeferral(assistantText)).toBe(true);
  });
});
