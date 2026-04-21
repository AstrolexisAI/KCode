# KCode — Plan de Corrección: APIs de Terceros + Agente de Programación
**Fecha:** 2026-04-21 | **Estado:** En ejecución

---

## DIAGNÓSTICO EJECUTIVO

Dos problemas distintos con causas raíz diferentes:

1. **APIs de terceros**: Arquitectura multi-provider bien diseñada en un 90%, pero 3 bugs concretos y deuda de generalización.
2. **Agente de programación**: Audit engine es determinístico (scan→verify→fix→validate). Coding agent no tiene ningún feedback loop.

---

## PRIORIDAD 1 — Bugs reales en APIs de terceros (impacto inmediato)

### Bug #1 — CRÍTICO: OpenAI o1/o3/o4 reciben `system` field que rechazan
- **Dónde:** `src/core/request-builder.ts` (rama OpenAI-compatible)
- **Qué pasa:** OpenAI o1/o3/o4 rechaza `system` como rol separado con HTTP 400. KCode lo envía igual para todos.
- **Fix:** Detectar `isReasoningModel` y hacer prepend del system prompt al primer user message.
- **Tests a agregar:** `buildRequestForModel()` para o1 no incluye `system` field.
- **Estado:** ⬜ PENDIENTE

### Bug #2 — MEDIO: `ModelProvider` enum truncado
- **Dónde:** `src/core/models.ts:11`
- **Actual:** `"openai" | "anthropic"` (solo 2 de 8+ providers reales)
- **Correcto:** extender con `"xai" | "google" | "deepseek" | "groq" | "openrouter" | "together"`
- **Estado:** ⬜ PENDIENTE

### Bug #3 — MEDIO: `reasoning_effort` no generalizado a Grok
- **Dónde:** `src/core/request-builder.ts:647-668`
- **Problema:** Solo aplica si `apiBase.includes("openai.com")`. Grok también lo soporta en algunos modelos.
- **Fix:** Map de soporte por provider + model-prefix.
- **Estado:** ⬜ PENDIENTE

### Tests faltantes (Prioridad 1)
| Test | Estado |
|------|--------|
| `buildRequestForModel()` para o1 → NO incluye `system` field | ⬜ |
| `buildRequestForModel()` para grok-* → SÍ incluye system field | ⬜ |
| `buildRequestForModel()` para o3-mini → system va en primer user message | ⬜ |
| reasoning_effort NO se aplica a xAI cuando es grok-standard | ⬜ |

---

## PRIORIDAD 2 — Arquitectura: Provider Capabilities Registry

### Problema
Cada nuevo provider requiere encontrar 4-6 lugares dispersos con if/else hardcodeados.
No hay un `PROVIDER_CAPABILITIES` registry central.

### Solución: `src/core/provider-capabilities.ts` (nuevo archivo)

```typescript
export interface ProviderCaps {
  usesSystemField: boolean;
  systemFieldExceptionForReasoning: boolean; // o1/o3/o4 no lo soportan
  supportsThinking: boolean;
  supportsPromptCache: boolean;
  supportsReasoningEffort: boolean | "selective";
  toolFormat: "anthropic" | "openai";
  streamParser: "anthropic" | "openai";
}

export const PROVIDER_CAPABILITIES: Record<string, ProviderCaps> = {
  anthropic: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: false,
    supportsThinking: true,
    supportsPromptCache: true,
    supportsReasoningEffort: false,
    toolFormat: "anthropic",
    streamParser: "anthropic",
  },
  openai: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: true,
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: true,
    toolFormat: "openai",
    streamParser: "openai",
  },
  xai: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: false,
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: "selective",
    toolFormat: "openai",
    streamParser: "openai",
  },
  google: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: false,
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  deepseek: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: false,
    supportsThinking: true,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  groq: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: false,
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  openrouter: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: false,
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  together: {
    usesSystemField: true,
    systemFieldExceptionForReasoning: false,
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
};
```

- **Estado:** ⬜ PENDIENTE

---

## PRIORIDAD 3 — Coding Agent: Feedback Loops

### 3a — System prompt: protocolo de validación post-edit
- **Problema:** El system prompt dice "silent execution, maximize throughput" sin instrucción de verificar el trabajo.
- **Adición:** Instrucción explícita post-Write/Edit: compilar → tests relacionados → solo reportar "done" si pasan.
- **Esfuerzo:** 1h
- **Estado:** ⬜ PENDIENTE

### 3b — MAX_AGENT_TURNS por tipo de tarea
- **Problema:** 25 turns es suficiente para auditoría, insuficiente para programación real (feature grande = 50+ turns).
- **Dónde:** `src/core/agent-loop-guards.ts`
- **Fix:** `getMaxTurnsForTask(taskType)` — audit: 30, coding: 60, debug: 45, explain: 15.
- **Estado:** ⬜ PENDIENTE

### 3c — Post-edit feedback hook (compilación + tests automáticos)
- **Problema:** Después de Write/Edit, no hay verificación automática de que el código sea válido.
- **Nuevo archivo:** `src/core/conversation-post-edit-hook.ts`
- **Lógica:** detectar tipo de proyecto → compilar → tests relacionados → inyectar errores en messages si fallan.
- **Esfuerzo:** 8h
- **Estado:** ⬜ PENDIENTE

---

## PRIORIDAD 4 — Infraestructura: RAG + Error Recovery

### 4a — Investigar crash RAG (44GB / Illegal instruction)
- **Hipótesis:** Regex con catastrophic backtracking en `src/core/rag/code-chunker.ts`.
- **Plan:**
  1. Leer `code-chunker.ts` — identificar regex complejos
  2. Probar con `bun --smol` para limitar memoria y confirmar
  3. Reemplazar regex ofensivo por parser lineal o splitting por líneas
  4. Restaurar tests `.skip` → `.test.ts`
- **Estado:** ⬜ PENDIENTE

### 4b — Error recovery determinístico en agent loop
- **Problema:** Si Claude encuentra compilation error, no hay lógica determinística que lo fuerce a reintentar.
- **Dónde:** `src/core/conversation.ts` — tool_result processing
- **Fix:** Detectar patrones de error en tool results → inyectar `buildErrorRecoveryPrompt()`.
- **Estado:** ⬜ PENDIENTE

---

## RESUMEN DE ESFUERZO

| Prioridad | Item | Esfuerzo estimado | Estado |
|-----------|------|-------------------|--------|
| 1 | Fix o1/o3 system field | 2h | ⬜ |
| 1 | Extender ModelProvider enum | 30min | ⬜ |
| 1 | reasoning_effort generalizado | 2h | ⬜ |
| 1 | Tests por provider | 2h | ⬜ |
| 2 | provider-capabilities.ts registry | 4h | ⬜ |
| 3a | System prompt validación post-edit | 1h | ⬜ |
| 3b | MAX_AGENT_TURNS por tarea | 1h | ⬜ |
| 3c | Post-edit feedback hook | 8h | ⬜ |
| 4a | RAG crash investigation | 4-8h | ⬜ |
| 4b | Error recovery en agent loop | 3h | ⬜ |

**Total estimado:** ~28-32h de trabajo

---

## CHECKLIST DE PROGRESO

- [x] P1: o1/o3 system field fix + tests
- [x] P1: ModelProvider enum extendido
- [x] P1: reasoning_effort generalizado
- [x] P2: provider-capabilities.ts creado e integrado en request-builder.ts
- [x] P3a: system prompt actualizado
- [x] P3b: MAX_AGENT_TURNS por tipo
- [ ] P3c: post-edit feedback hook
- [x] P4a: RAG crash resuelto, tests restaurados
- [ ] P4b: error recovery en agent loop
