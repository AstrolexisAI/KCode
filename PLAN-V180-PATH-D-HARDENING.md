# Plan v1.8.0 — Camino D: Hardening & Performance

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~6,000-8,000 LoC nuevas
**Filosofia:** Antes de agregar features nuevas, KCode debe ser SOLIDO. Este camino
endurece el runtime, optimiza el arranque, y cierra brechas de calidad frente a
Claude Code sin agregar complejidad innecesaria.

> NOTA: Cada feature tiene flag para activar/desactivar. Todo backwards-compatible
> con v1.7.0. NO se copia codigo de ningun competidor — se reimplementan conceptos
> adaptados al stack KCode (Bun + SQLite + React/Ink).

---

## INDICE

1. [Feature D1: Startup Profiling & Lazy Imports](#feature-d1-startup-profiling--lazy-imports)
2. [Feature D2: Feature Flags con Dead Code Elimination](#feature-d2-feature-flags-con-dead-code-elimination)
3. [Feature D3: Policy Limits & Rate Limiting Interno](#feature-d3-policy-limits--rate-limiting-interno)
4. [Feature D4: OAuth & Keychain Integration](#feature-d4-oauth--keychain-integration)
5. [Feature D5: Context Compaction Hardening](#feature-d5-context-compaction-hardening)
6. [Feature D6: Crash Recovery & Session Persistence](#feature-d6-crash-recovery--session-persistence)

---

## Feature D1: Startup Profiling & Lazy Imports

### 1.1 Contexto

KCode tarda ~800ms-1.5s en arrancar dependiendo de la maquina. Claude Code tiene
un sistema de `profileCheckpoint`/`profileReport` que permite medir EXACTAMENTE
donde se gasta el tiempo de arranque. Ademas, usa lazy imports agresivos para
diferir la carga de modulos no criticos.

Con KCode creciendo (200+ archivos core, 46 tools, SQLite, MCP, etc.), cada import
al inicio suma. El binario compilado ya es 105MB — necesitamos que el tiempo
hasta el primer prompt sea <500ms consistentemente.

### 1.2 Archivos Nuevos

```
src/
  core/
    profiler/
      startup-profiler.ts          (~180 lineas) - Profiler de arranque con checkpoints
      startup-profiler.test.ts     (~150 lineas) - Tests
      lazy-loader.ts               (~120 lineas) - Proxy de imports lazy con cache
      lazy-loader.test.ts          (~100 lineas) - Tests
      types.ts                     (~40 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/index.ts` — Agregar checkpoints de profiling en cada fase de init
- `src/core/conversation.ts` — Lazy-load tools que no se usan inmediatamente
- `src/core/mcp-client.ts` — Diferir init de MCP servers hasta primer uso
- `src/core/lsp.ts` — Lazy-load LSP client
- `src/core/hardware/detector.ts` — Cache resultado para evitar re-scan
- `src/core/model-manager.ts` — Diferir descubrimiento de modelos locales

### 1.3 Diseño del Profiler

```typescript
// src/core/profiler/startup-profiler.ts

interface ProfileCheckpoint {
  name: string;
  timestamp: number;       // performance.now()
  deltaMs: number;         // Tiempo desde checkpoint anterior
  memoryMB: number;        // RSS en MB
  importsLoaded: number;   // Cantidad de modulos cargados
}

interface ProfileReport {
  checkpoints: ProfileCheckpoint[];
  totalMs: number;
  peakMemoryMB: number;
  slowestPhase: string;
  recommendations: string[];  // Sugerencias automaticas si algo tarda >100ms
}

class StartupProfiler {
  private checkpoints: ProfileCheckpoint[] = [];
  private startTime: number;
  private enabled: boolean;

  constructor(enabled = false) {
    this.startTime = performance.now();
    this.enabled = enabled || process.env.KCODE_PROFILE === '1';
  }

  /** Marca un checkpoint con nombre descriptivo */
  checkpoint(name: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    const prev = this.checkpoints.at(-1)?.timestamp ?? this.startTime;
    this.checkpoints.push({
      name,
      timestamp: now,
      deltaMs: now - prev,
      memoryMB: process.memoryUsage.rss() / 1024 / 1024,
      importsLoaded: Object.keys(require.cache ?? {}).length,
    });
  }

  /** Genera reporte con recomendaciones */
  report(): ProfileReport {
    const totalMs = performance.now() - this.startTime;
    const slowest = [...this.checkpoints].sort((a, b) => b.deltaMs - a.deltaMs)[0];
    const recommendations: string[] = [];

    for (const cp of this.checkpoints) {
      if (cp.deltaMs > 100) {
        recommendations.push(`${cp.name} tarda ${cp.deltaMs.toFixed(0)}ms — considerar lazy-load`);
      }
    }

    return {
      checkpoints: this.checkpoints,
      totalMs,
      peakMemoryMB: Math.max(...this.checkpoints.map(c => c.memoryMB)),
      slowestPhase: slowest?.name ?? 'N/A',
      recommendations,
    };
  }

  /** Imprime reporte en formato tabla */
  print(): void {
    const report = this.report();
    console.log('\n--- Startup Profile ---');
    for (const cp of report.checkpoints) {
      const bar = '█'.repeat(Math.min(50, Math.round(cp.deltaMs / 10)));
      console.log(`  ${cp.name.padEnd(25)} ${cp.deltaMs.toFixed(0).padStart(6)}ms ${bar}`);
    }
    console.log(`  ${'TOTAL'.padEnd(25)} ${report.totalMs.toFixed(0).padStart(6)}ms`);
    if (report.recommendations.length > 0) {
      console.log('\n  Recomendaciones:');
      for (const r of report.recommendations) {
        console.log(`    ! ${r}`);
      }
    }
  }
}

export { StartupProfiler, type ProfileReport, type ProfileCheckpoint };
```

### 1.4 Lazy Loader

```typescript
// src/core/profiler/lazy-loader.ts

/**
 * Crea un proxy que difiere el import real hasta el primer acceso.
 * Uso: const mcp = lazy(() => import('../mcp-client'));
 */
function lazy<T>(factory: () => Promise<T>): T {
  let module: T | undefined;
  let loading: Promise<T> | undefined;

  return new Proxy({} as T, {
    get(_target, prop) {
      if (!module) {
        if (!loading) {
          loading = factory().then(m => { module = m; return m; });
        }
        // Ejecucion sincrona en Bun — top-level await resuelto
        throw new Error(`Lazy module not yet loaded. Use 'await lazy.load()' first.`);
      }
      return (module as Record<string | symbol, unknown>)[prop];
    },
  });
}

/**
 * Version sincrona para modulos que Bun puede resolver sincronamente.
 * Cache en Map para evitar re-require.
 */
const moduleCache = new Map<string, unknown>();

function lazyRequire<T>(modulePath: string): () => T {
  return () => {
    if (!moduleCache.has(modulePath)) {
      moduleCache.set(modulePath, require(modulePath));
    }
    return moduleCache.get(modulePath) as T;
  };
}

export { lazy, lazyRequire };
```

### 1.5 Integracion con src/index.ts

```typescript
// Al inicio de src/index.ts (ANTES de cualquier import pesado)
import { StartupProfiler } from './core/profiler/startup-profiler';

const profiler = new StartupProfiler();
profiler.checkpoint('module-init');

// ... imports existentes ...
profiler.checkpoint('imports-loaded');

// ... init config ...
profiler.checkpoint('config-loaded');

// ... init SQLite ...
profiler.checkpoint('db-ready');

// ... init tools ...
profiler.checkpoint('tools-registered');

// ... init UI ...
profiler.checkpoint('ui-ready');

// Al final del startup:
if (process.env.KCODE_PROFILE === '1') {
  profiler.print();
}
```

### 1.6 Tests

```typescript
// src/core/profiler/startup-profiler.test.ts
import { describe, test, expect } from 'bun:test';
import { StartupProfiler } from './startup-profiler';

describe('StartupProfiler', () => {
  test('registra checkpoints correctamente', () => {
    const p = new StartupProfiler(true);
    p.checkpoint('a');
    p.checkpoint('b');
    const report = p.report();
    expect(report.checkpoints).toHaveLength(2);
    expect(report.checkpoints[0]!.name).toBe('a');
    expect(report.totalMs).toBeGreaterThan(0);
  });

  test('no registra nada si disabled', () => {
    const p = new StartupProfiler(false);
    p.checkpoint('a');
    expect(p.report().checkpoints).toHaveLength(0);
  });

  test('detecta fases lentas en recommendations', async () => {
    const p = new StartupProfiler(true);
    p.checkpoint('fast');
    await Bun.sleep(120); // Simular fase lenta
    p.checkpoint('slow');
    const report = p.report();
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.slowestPhase).toBe('slow');
  });
});
```

### 1.7 Criterios de Aceptacion

- [ ] `KCODE_PROFILE=1 kcode` imprime tabla de tiempos al arranque
- [ ] Todos los modulos no-criticos usan lazy-load
- [ ] Tiempo de arranque <500ms en hardware tipico (sin modelos locales)
- [ ] Zero overhead cuando profiling esta desactivado
- [ ] `/doctor` reporta tiempo de arranque y modulos mas lentos

---

## Feature D2: Feature Flags con Dead Code Elimination

### 2.1 Contexto

Claude Code usa un sistema de feature flags via `bun:bundle` que ELIMINA codigo
muerto en compilacion. Si un feature flag es `false`, todo el codigo detras del
`if (feature('X'))` desaparece del bundle.

KCode actualmente tiene gating en `pro.ts` pero es runtime-only: el codigo Pro
se incluye en el binario aunque el usuario no tenga licencia. Esto:
- Aumenta el tamaño del binario innecesariamente
- Expone codigo Pro en el binario free
- No permite builds custom (ej: build sin voice, sin bridge, sin telemetry)

### 2.2 Archivos Nuevos

```
src/
  core/
    feature-flags/
      flags.ts                     (~200 lineas) - Registry de feature flags
      flags.test.ts                (~180 lineas) - Tests
      build-defines.ts             (~80 lineas)  - Constantes para Bun --define
      types.ts                     (~50 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `build.ts` — Agregar --define para cada flag con dead code elimination
- `src/core/pro.ts` — Usar flags en vez de runtime checks
- `src/core/config.ts` — Registrar flags activos en config

### 2.3 Diseño

```typescript
// src/core/feature-flags/flags.ts

/**
 * Feature flags evaluados en build-time via Bun --define.
 * En produccion, Bun reemplaza estas constantes por true/false
 * y elimina el codigo muerto via tree-shaking.
 *
 * En desarrollo, todos los flags estan activos.
 */

// Declarados como constantes globales (inyectados por build.ts via --define)
declare const __FEATURE_VOICE__: boolean;
declare const __FEATURE_BRIDGE__: boolean;
declare const __FEATURE_ENTERPRISE__: boolean;
declare const __FEATURE_TELEMETRY__: boolean;
declare const __FEATURE_LSP__: boolean;
declare const __FEATURE_SWARM__: boolean;
declare const __FEATURE_BROWSER__: boolean;
declare const __FEATURE_MESH__: boolean;
declare const __FEATURE_DISTILLATION__: boolean;
declare const __FEATURE_COLLAB__: boolean;

/** Evaluacion segura con fallback a true en desarrollo */
function featureEnabled(flag: boolean | undefined): boolean {
  return flag ?? true; // En dev sin --define, todo activo
}

export const Features = {
  voice:         featureEnabled(typeof __FEATURE_VOICE__ !== 'undefined' ? __FEATURE_VOICE__ : undefined),
  bridge:        featureEnabled(typeof __FEATURE_BRIDGE__ !== 'undefined' ? __FEATURE_BRIDGE__ : undefined),
  enterprise:    featureEnabled(typeof __FEATURE_ENTERPRISE__ !== 'undefined' ? __FEATURE_ENTERPRISE__ : undefined),
  telemetry:     featureEnabled(typeof __FEATURE_TELEMETRY__ !== 'undefined' ? __FEATURE_TELEMETRY__ : undefined),
  lsp:           featureEnabled(typeof __FEATURE_LSP__ !== 'undefined' ? __FEATURE_LSP__ : undefined),
  swarm:         featureEnabled(typeof __FEATURE_SWARM__ !== 'undefined' ? __FEATURE_SWARM__ : undefined),
  browser:       featureEnabled(typeof __FEATURE_BROWSER__ !== 'undefined' ? __FEATURE_BROWSER__ : undefined),
  mesh:          featureEnabled(typeof __FEATURE_MESH__ !== 'undefined' ? __FEATURE_MESH__ : undefined),
  distillation:  featureEnabled(typeof __FEATURE_DISTILLATION__ !== 'undefined' ? __FEATURE_DISTILLATION__ : undefined),
  collab:        featureEnabled(typeof __FEATURE_COLLAB__ !== 'undefined' ? __FEATURE_COLLAB__ : undefined),
} as const;

export type FeatureName = keyof typeof Features;

/** Lista flags activos (para /doctor y debug) */
export function activeFeatures(): FeatureName[] {
  return (Object.entries(Features) as [FeatureName, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k);
}
```

### 2.4 Integracion con build.ts

```typescript
// En build.ts, agregar al objeto de defines:

const buildProfile = process.env.KCODE_BUILD_PROFILE ?? 'full';

const featureProfiles: Record<string, Record<string, string>> = {
  full: {
    '__FEATURE_VOICE__': 'true',
    '__FEATURE_BRIDGE__': 'true',
    '__FEATURE_ENTERPRISE__': 'true',
    '__FEATURE_TELEMETRY__': 'true',
    '__FEATURE_LSP__': 'true',
    '__FEATURE_SWARM__': 'true',
    '__FEATURE_BROWSER__': 'true',
    '__FEATURE_MESH__': 'true',
    '__FEATURE_DISTILLATION__': 'true',
    '__FEATURE_COLLAB__': 'true',
  },
  free: {
    '__FEATURE_VOICE__': 'false',
    '__FEATURE_BRIDGE__': 'true',
    '__FEATURE_ENTERPRISE__': 'false',
    '__FEATURE_TELEMETRY__': 'true',
    '__FEATURE_LSP__': 'true',
    '__FEATURE_SWARM__': 'false',
    '__FEATURE_BROWSER__': 'false',
    '__FEATURE_MESH__': 'false',
    '__FEATURE_DISTILLATION__': 'false',
    '__FEATURE_COLLAB__': 'false',
  },
  minimal: {
    '__FEATURE_VOICE__': 'false',
    '__FEATURE_BRIDGE__': 'false',
    '__FEATURE_ENTERPRISE__': 'false',
    '__FEATURE_TELEMETRY__': 'false',
    '__FEATURE_LSP__': 'false',
    '__FEATURE_SWARM__': 'false',
    '__FEATURE_BROWSER__': 'false',
    '__FEATURE_MESH__': 'false',
    '__FEATURE_DISTILLATION__': 'false',
    '__FEATURE_COLLAB__': 'false',
  },
};

// Usar en Bun.build({ define: featureProfiles[buildProfile] })
```

### 2.5 Uso en codigo

```typescript
// Antes (runtime check):
if (isPro()) {
  const { startSwarm } = await import('./swarm');
  await startSwarm(config);
}

// Despues (build-time elimination):
import { Features } from './feature-flags/flags';

if (Features.swarm) {
  const { startSwarm } = await import('./swarm');
  await startSwarm(config);
}
// Si __FEATURE_SWARM__ es false, Bun elimina TODO este bloque del bundle
```

### 2.6 Criterios de Aceptacion

- [ ] `KCODE_BUILD_PROFILE=free bun run build` genera binario sin codigo Pro
- [ ] `KCODE_BUILD_PROFILE=minimal bun run build` genera binario minimo (~80MB estimado)
- [ ] `kcode doctor` lista features activos en el build
- [ ] En desarrollo (`bun run src/index.ts`), todos los features estan activos
- [ ] Binario free es al menos 5MB mas pequeño que full

---

## Feature D3: Policy Limits & Rate Limiting Interno

### 3.1 Contexto

Claude Code tiene un sistema de `PolicyLimits` que controla:
- Maximo de tokens por sesion
- Maximo de tool calls por turno
- Maximo de agentes concurrentes
- Cooldown entre requests
- Limites por modelo

KCode no tiene nada de esto. En modo Pro con swarm de agentes, un usuario puede
quemar tokens sin control. En enterprise, el admin no puede limitar el gasto.

### 3.2 Archivos Nuevos

```
src/
  core/
    policy/
      limits.ts                    (~300 lineas) - Motor de limites
      limits.test.ts               (~250 lineas) - Tests
      budget-tracker.ts            (~200 lineas) - Tracker de presupuesto por sesion
      budget-tracker.test.ts       (~180 lineas) - Tests
      types.ts                     (~80 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/conversation.ts` — Verificar limites antes de cada request
- `src/core/pricing.ts` — Exponer costo acumulado para budget tracker
- `src/core/config.ts` — Agregar settings de policy limits
- `src/enterprise/mdm.ts` — Permitir MDM override de limites

### 3.3 Diseño

```typescript
// src/core/policy/types.ts

interface PolicyLimits {
  /** Max tokens (input + output) por sesion. 0 = ilimitado */
  maxTokensPerSession: number;
  /** Max tool calls por turno individual. 0 = ilimitado */
  maxToolCallsPerTurn: number;
  /** Max agentes concurrentes en swarm. 0 = ilimitado */
  maxConcurrentAgents: number;
  /** Cooldown minimo entre requests al LLM en ms. 0 = sin cooldown */
  minRequestIntervalMs: number;
  /** Presupuesto maximo en USD por sesion. 0 = ilimitado */
  maxBudgetUsd: number;
  /** Presupuesto maximo en USD por dia. 0 = ilimitado */
  maxDailyBudgetUsd: number;
  /** Lista de tools bloqueados (por nombre) */
  blockedTools: string[];
  /** Lista de modelos permitidos (vacio = todos) */
  allowedModels: string[];
}

interface PolicyViolation {
  type: 'token_limit' | 'tool_limit' | 'agent_limit' | 'rate_limit' | 'budget_limit' | 'blocked_tool' | 'blocked_model';
  message: string;
  current: number;
  limit: number;
}

type PolicyCheckResult =
  | { allowed: true }
  | { allowed: false; violation: PolicyViolation };
```

```typescript
// src/core/policy/limits.ts

import type { PolicyLimits, PolicyCheckResult, PolicyViolation } from './types';

const DEFAULT_LIMITS: PolicyLimits = {
  maxTokensPerSession: 0,        // ilimitado por defecto
  maxToolCallsPerTurn: 50,       // safety net razonable
  maxConcurrentAgents: 10,       // prevenir fork bombs
  minRequestIntervalMs: 0,       // sin cooldown
  maxBudgetUsd: 0,               // ilimitado
  maxDailyBudgetUsd: 0,          // ilimitado
  blockedTools: [],
  allowedModels: [],
};

class PolicyEngine {
  private limits: PolicyLimits;
  private sessionTokens = 0;
  private turnToolCalls = 0;
  private activeAgents = 0;
  private lastRequestTime = 0;
  private sessionCostUsd = 0;
  private dailyCostUsd = 0;

  constructor(limits: Partial<PolicyLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Verifica si un request al LLM esta permitido */
  checkRequest(estimatedTokens: number): PolicyCheckResult {
    // Token limit
    if (this.limits.maxTokensPerSession > 0 &&
        this.sessionTokens + estimatedTokens > this.limits.maxTokensPerSession) {
      return this.violation('token_limit',
        `Limite de tokens por sesion alcanzado`,
        this.sessionTokens, this.limits.maxTokensPerSession);
    }

    // Rate limit
    const elapsed = Date.now() - this.lastRequestTime;
    if (this.limits.minRequestIntervalMs > 0 && elapsed < this.limits.minRequestIntervalMs) {
      return this.violation('rate_limit',
        `Cooldown: espera ${this.limits.minRequestIntervalMs - elapsed}ms`,
        elapsed, this.limits.minRequestIntervalMs);
    }

    return { allowed: true };
  }

  /** Verifica si un tool call esta permitido */
  checkToolCall(toolName: string): PolicyCheckResult {
    if (this.limits.blockedTools.includes(toolName)) {
      return this.violation('blocked_tool',
        `Tool '${toolName}' esta bloqueado por politica`, 0, 0);
    }

    if (this.limits.maxToolCallsPerTurn > 0 &&
        this.turnToolCalls >= this.limits.maxToolCallsPerTurn) {
      return this.violation('tool_limit',
        `Maximo ${this.limits.maxToolCallsPerTurn} tool calls por turno`,
        this.turnToolCalls, this.limits.maxToolCallsPerTurn);
    }

    return { allowed: true };
  }

  /** Verifica si se puede lanzar un agente mas */
  checkAgentSpawn(): PolicyCheckResult {
    if (this.limits.maxConcurrentAgents > 0 &&
        this.activeAgents >= this.limits.maxConcurrentAgents) {
      return this.violation('agent_limit',
        `Maximo ${this.limits.maxConcurrentAgents} agentes concurrentes`,
        this.activeAgents, this.limits.maxConcurrentAgents);
    }

    return { allowed: true };
  }

  /** Verifica presupuesto */
  checkBudget(estimatedCostUsd: number): PolicyCheckResult {
    if (this.limits.maxBudgetUsd > 0 &&
        this.sessionCostUsd + estimatedCostUsd > this.limits.maxBudgetUsd) {
      return this.violation('budget_limit',
        `Presupuesto de sesion agotado ($${this.limits.maxBudgetUsd})`,
        this.sessionCostUsd, this.limits.maxBudgetUsd);
    }

    if (this.limits.maxDailyBudgetUsd > 0 &&
        this.dailyCostUsd + estimatedCostUsd > this.limits.maxDailyBudgetUsd) {
      return this.violation('budget_limit',
        `Presupuesto diario agotado ($${this.limits.maxDailyBudgetUsd})`,
        this.dailyCostUsd, this.limits.maxDailyBudgetUsd);
    }

    return { allowed: true };
  }

  /** Registra consumo despues de un request exitoso */
  recordUsage(tokens: number, costUsd: number): void {
    this.sessionTokens += tokens;
    this.sessionCostUsd += costUsd;
    this.dailyCostUsd += costUsd;
    this.lastRequestTime = Date.now();
  }

  recordToolCall(): void { this.turnToolCalls++; }
  resetTurnToolCalls(): void { this.turnToolCalls = 0; }
  recordAgentSpawn(): void { this.activeAgents++; }
  recordAgentComplete(): void { this.activeAgents = Math.max(0, this.activeAgents - 1); }

  /** Obtener estado actual para UI */
  getStatus() {
    return {
      sessionTokens: this.sessionTokens,
      sessionCostUsd: this.sessionCostUsd,
      dailyCostUsd: this.dailyCostUsd,
      activeAgents: this.activeAgents,
      limits: { ...this.limits },
    };
  }

  private violation(type: PolicyViolation['type'], message: string, current: number, limit: number): PolicyCheckResult {
    return { allowed: false, violation: { type, message, current, limit } };
  }
}

export { PolicyEngine, DEFAULT_LIMITS };
```

### 3.4 Criterios de Aceptacion

- [ ] Limites configurables en settings.json y via MDM
- [ ] Violacion de limite muestra mensaje claro al usuario (no crash)
- [ ] `/cost` muestra consumo vs limites configurados
- [ ] Tests cubren todos los tipos de violacion
- [ ] Default limits son razonables (no rompen uso normal)
- [ ] Enterprise admin puede forzar limites via `.kcode/settings.json` del proyecto

---

## Feature D4: OAuth & Keychain Integration

### 4.1 Contexto

KCode actualmente depende de API keys manuales (KCODE_API_KEY o en settings.json).
Claude Code tiene OAuth flow integrado + almacenamiento seguro via keychain del OS.

Esto importa para:
- Enterprise: SSO via OAuth, no API keys compartidas
- Seguridad: Keys no en plaintext en archivos de config
- UX: `kcode login` en vez de copiar/pegar API keys

### 4.2 Archivos Nuevos

```
src/
  core/
    auth/
      oauth-flow.ts                (~350 lineas) - OAuth 2.0 PKCE flow
      oauth-flow.test.ts           (~300 lineas) - Tests
      keychain.ts                  (~250 lineas) - Almacenamiento seguro cross-platform
      keychain.test.ts             (~200 lineas) - Tests
      session.ts                   (~150 lineas) - Session management (tokens, refresh)
      session.test.ts              (~120 lineas) - Tests
      types.ts                     (~60 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/config.ts` — Buscar credenciales en keychain antes de env/settings
- `src/cli/login.ts` — Reescribir para usar OAuth flow
- `src/cli/logout.ts` — Limpiar keychain
- `src/core/conversation.ts` — Token refresh transparente si expira mid-session

### 4.3 Diseño de Keychain

```typescript
// src/core/auth/keychain.ts

/**
 * Almacenamiento seguro cross-platform.
 * - Linux: libsecret (GNOME Keyring / KDE Wallet)
 * - macOS: security (Keychain Access)
 * - Windows: cmdkey (Credential Manager)
 * - Fallback: archivo encriptado en ~/.kcode/credentials.enc
 */

interface KeychainEntry {
  service: string;   // 'kcode'
  account: string;   // 'anthropic', 'openai', 'kcode-cloud', etc.
  secret: string;    // API key o token
}

async function setSecret(account: string, secret: string): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    await Bun.spawn(['security', 'add-generic-password',
      '-s', 'kcode', '-a', account, '-w', secret, '-U']).exited;
  } else if (platform === 'linux') {
    await Bun.spawn(['secret-tool', 'store',
      '--label', `KCode: ${account}`,
      'service', 'kcode', 'account', account],
      { stdin: new TextEncoder().encode(secret) }).exited;
  } else if (platform === 'win32') {
    await Bun.spawn(['cmdkey', `/add:kcode:${account}`,
      '/user:kcode', `/pass:${secret}`]).exited;
  } else {
    await fallbackStore(account, secret);
  }
}

async function getSecret(account: string): Promise<string | null> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      const proc = Bun.spawn(['security', 'find-generic-password',
        '-s', 'kcode', '-a', account, '-w']);
      const output = await new Response(proc.stdout).text();
      return output.trim() || null;
    } else if (platform === 'linux') {
      const proc = Bun.spawn(['secret-tool', 'lookup',
        'service', 'kcode', 'account', account]);
      const output = await new Response(proc.stdout).text();
      return output.trim() || null;
    } else if (platform === 'win32') {
      // Windows credential manager no tiene CLI read directo
      // Usar powershell con CredentialManager module
      const proc = Bun.spawn(['powershell', '-Command',
        `(Get-StoredCredential -Target "kcode:${account}").Password`]);
      const output = await new Response(proc.stdout).text();
      return output.trim() || null;
    }
    return fallbackRead(account);
  } catch {
    return fallbackRead(account);
  }
}

async function deleteSecret(account: string): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    await Bun.spawn(['security', 'delete-generic-password',
      '-s', 'kcode', '-a', account]).exited;
  } else if (platform === 'linux') {
    await Bun.spawn(['secret-tool', 'clear',
      'service', 'kcode', 'account', account]).exited;
  } else if (platform === 'win32') {
    await Bun.spawn(['cmdkey', `/delete:kcode:${account}`]).exited;
  } else {
    await fallbackDelete(account);
  }
}

// Fallback: archivo encriptado con clave derivada de machine-id
async function fallbackStore(account: string, secret: string): Promise<void> {
  // Implementar con crypto.subtle.encrypt + machine-id como salt
}
async function fallbackRead(account: string): Promise<string | null> {
  return null;
}
async function fallbackDelete(account: string): Promise<void> {}

export { setSecret, getSecret, deleteSecret };
```

### 4.4 OAuth PKCE Flow

```typescript
// src/core/auth/oauth-flow.ts (esqueleto)

interface OAuthConfig {
  provider: 'anthropic' | 'openai' | 'kcode-cloud' | 'custom';
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  redirectPort: number;  // Puerto local para callback (default: 19284)
}

const PROVIDER_CONFIGS: Record<string, Partial<OAuthConfig>> = {
  'kcode-cloud': {
    provider: 'kcode-cloud',
    authorizationUrl: 'https://cloud.kcode.dev/oauth/authorize',
    tokenUrl: 'https://cloud.kcode.dev/oauth/token',
    clientId: 'kcode-cli',
    scopes: ['api', 'sync'],
  },
  // Otros providers se configuran via settings
};

/**
 * 1. Genera code_verifier + code_challenge (PKCE)
 * 2. Abre browser con URL de autorizacion
 * 3. Levanta servidor HTTP local temporal en redirectPort
 * 4. Espera callback con authorization code
 * 5. Intercambia code por access_token + refresh_token
 * 6. Guarda tokens en keychain
 */
async function startOAuthFlow(provider: string): Promise<{ accessToken: string; refreshToken?: string }> {
  // ... implementacion completa ...
  throw new Error('Not implemented');
}

export { startOAuthFlow, PROVIDER_CONFIGS, type OAuthConfig };
```

### 4.5 Criterios de Aceptacion

- [ ] `kcode login` abre browser para OAuth (KCode Cloud)
- [ ] `kcode login --provider anthropic --api-key sk-...` guarda en keychain
- [ ] `kcode logout` limpia keychain
- [ ] API keys NUNCA se guardan en plaintext en settings.json
- [ ] Funciona en Linux (libsecret), macOS (Keychain), Windows (Credential Manager)
- [ ] Fallback a archivo encriptado si keychain no disponible
- [ ] Token refresh automatico sin interrumpir sesion

---

## Feature D5: Context Compaction Hardening

### 5.1 Contexto

KCode ya tiene compaction multi-estrategia (v1.7.0) pero Claude Code tiene
edge cases bien resueltos que vale la pena auditar:

1. **Emergency pruning** — Cuando compaction normal falla y el contexto sigue lleno
2. **Tool result truncation** — Cortar resultados de tools grandes ANTES de compactar
3. **Continuation merging** — Cuando una respuesta se corta, merge inteligente
4. **Pin protection** — Archivos pinneados NUNCA se compactan

### 5.2 Archivos Nuevos

```
src/
  core/
    compaction/
      emergency-pruner.ts          (~200 lineas) - Poda de emergencia
      emergency-pruner.test.ts     (~180 lineas) - Tests
      tool-result-truncator.ts     (~150 lineas) - Truncamiento inteligente
      tool-result-truncator.test.ts (~130 lineas) - Tests
      continuation-merger.ts       (~180 lineas) - Merge de respuestas cortadas
      continuation-merger.test.ts  (~150 lineas) - Tests
```

**Archivos Existentes a Modificar:**
- `src/core/compaction/` — Integrar emergency pruner como ultimo recurso
- `src/core/conversation.ts` — Agregar continuation merging y pin protection

### 5.3 Emergency Pruner

```typescript
// src/core/compaction/emergency-pruner.ts

/**
 * Activado cuando:
 * 1. Compaction normal fallo o no libero suficiente espacio
 * 2. Contexto esta al >95% de capacidad
 * 3. El modelo retorno error de contexto excedido
 *
 * Estrategia (en orden de prioridad):
 * 1. Truncar tool results a 500 chars (excepto pinned)
 * 2. Eliminar turnos antiguos (mantener ultimo 20%)
 * 3. Eliminar tool results completamente (dejar solo "[resultado truncado]")
 * 4. Nuclear: mantener solo system prompt + ultimo turno
 */

interface PruneResult {
  strategy: 'truncate-tools' | 'remove-old-turns' | 'strip-tool-results' | 'nuclear';
  messagesRemoved: number;
  tokensFreed: number;
  warning: string;
}

function emergencyPrune(
  messages: Message[],
  pinnedIndices: Set<number>,
  targetTokens: number,
  currentTokens: number,
): { messages: Message[]; result: PruneResult } {
  // Implementacion por capas de agresividad
  // Nunca tocar pinnedIndices
  throw new Error('Not implemented');
}

export { emergencyPrune, type PruneResult };
```

### 5.4 Tool Result Truncator

```typescript
// src/core/compaction/tool-result-truncator.ts

interface TruncationConfig {
  /** Max chars por tool result antes de truncar */
  maxChars: number;           // default: 10000
  /** Max chars en modo agresivo */
  aggressiveMaxChars: number; // default: 2000
  /** Preservar primeros N y ultimos N chars */
  headChars: number;          // default: 1000
  tailChars: number;          // default: 500
  /** Tools que nunca se truncan (ej: FileRead de archivos pinneados) */
  protectedTools: string[];
}

/**
 * Trunca tool results grandes ANTES de que lleguen al LLM.
 * Mantiene head + tail para dar contexto, agrega "[... N chars omitidos ...]"
 */
function truncateToolResults(
  messages: Message[],
  config: Partial<TruncationConfig>,
): { messages: Message[]; truncated: number } {
  throw new Error('Not implemented');
}

export { truncateToolResults, type TruncationConfig };
```

### 5.5 Criterios de Aceptacion

- [ ] Emergency pruner se activa automaticamente al >95% de contexto
- [ ] Archivos pinneados NUNCA se compactan ni truncan
- [ ] Tool results >10K chars se truncan preservando head+tail
- [ ] Continuation merging funciona cuando respuesta se corta mid-stream
- [ ] `/compact` muestra estadisticas de que se compacto
- [ ] Tests cubren cada nivel de agresividad del emergency pruner

---

## Feature D6: Crash Recovery & Session Persistence

### 6.1 Contexto

Claude Code tiene session snapshots y la capacidad de transferir sesiones entre
dispositivos ("teleport"). KCode tiene `/resume` pero no tiene:
- Recovery automatico despues de crash
- Checkpoint periodico del estado de la sesion
- Transfer de sesion entre maquinas

### 6.2 Archivos Nuevos

```
src/
  core/
    session/
      checkpoint.ts                (~250 lineas) - Checkpointing periodico
      checkpoint.test.ts           (~200 lineas) - Tests
      crash-recovery.ts            (~200 lineas) - Deteccion y recovery de crash
      crash-recovery.test.ts       (~180 lineas) - Tests
      teleport.ts                  (~300 lineas) - Transfer de sesion entre maquinas
      teleport.test.ts             (~250 lineas) - Tests
      types.ts                     (~60 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/conversation.ts` — Checkpoint cada N turnos o M segundos
- `src/index.ts` — Detectar crash al startup (pid file stale)
- `src/core/config.ts` — Settings de checkpoint interval

### 6.3 Diseño de Checkpoint

```typescript
// src/core/session/checkpoint.ts

interface SessionCheckpoint {
  id: string;                    // UUID
  timestamp: number;
  conversationId: string;
  messages: Message[];           // Snapshot completo
  toolStates: Record<string, unknown>;  // Estado de tools activos
  planState?: PlanState;         // Plan activo si existe
  workingDirectory: string;
  gitBranch?: string;
  modelId: string;
  tokensUsed: number;
  costUsd: number;
}

class CheckpointManager {
  private db: Database;
  private intervalMs: number;
  private timer?: Timer;

  constructor(db: Database, intervalMs = 30_000) {
    this.db = db;
    this.intervalMs = intervalMs;
    this.initTable();
  }

  private initTable(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS session_checkpoints (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(conversation_id, timestamp)
    )`);
    // Mantener solo los ultimos 10 checkpoints por sesion
    this.db.run(`CREATE TRIGGER IF NOT EXISTS prune_old_checkpoints
      AFTER INSERT ON session_checkpoints
      BEGIN
        DELETE FROM session_checkpoints
        WHERE conversation_id = NEW.conversation_id
        AND id NOT IN (
          SELECT id FROM session_checkpoints
          WHERE conversation_id = NEW.conversation_id
          ORDER BY timestamp DESC LIMIT 10
        );
      END`);
  }

  /** Inicia checkpointing automatico */
  startAutoCheckpoint(getState: () => SessionCheckpoint): void {
    this.timer = setInterval(() => {
      this.save(getState());
    }, this.intervalMs);
  }

  stopAutoCheckpoint(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Guarda checkpoint manualmente */
  save(checkpoint: SessionCheckpoint): void {
    this.db.run(
      `INSERT OR REPLACE INTO session_checkpoints (id, conversation_id, timestamp, data) VALUES (?, ?, ?, ?)`,
      [checkpoint.id, checkpoint.conversationId, checkpoint.timestamp, JSON.stringify(checkpoint)]
    );
  }

  /** Recupera ultimo checkpoint de una sesion */
  getLatest(conversationId: string): SessionCheckpoint | null {
    const row = this.db.query(
      `SELECT data FROM session_checkpoints WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 1`
    ).get(conversationId) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }

  /** Lista sesiones con checkpoints disponibles */
  listRecoverable(): { conversationId: string; timestamp: number; tokensUsed: number }[] {
    // Para mostrar en crash recovery UI
    throw new Error('Not implemented');
  }
}

export { CheckpointManager, type SessionCheckpoint };
```

### 6.4 Crash Recovery

```typescript
// src/core/session/crash-recovery.ts

/**
 * Al inicio de KCode:
 * 1. Buscar ~/.kcode/kcode.pid
 * 2. Si existe y el proceso NO esta vivo → crash anterior
 * 3. Mostrar al usuario: "Se detecto una sesion interrumpida. Recuperar? [Y/n]"
 * 4. Si acepta: cargar ultimo checkpoint y continuar
 * 5. Limpiar pid file
 */

async function detectCrash(): Promise<SessionCheckpoint | null> {
  const pidFile = `${homedir()}/.kcode/kcode.pid`;
  const file = Bun.file(pidFile);

  if (!await file.exists()) return null;

  const pid = parseInt(await file.text());
  const isAlive = processIsAlive(pid);

  if (isAlive) return null; // Otra instancia corriendo, no es crash

  // Crash detectado — buscar checkpoint
  const db = getDb();
  const manager = new CheckpointManager(db);
  return manager.getLatest('last'); // Ultimo checkpoint disponible
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

export { detectCrash };
```

### 6.5 Teleport (Session Transfer)

```typescript
// src/core/session/teleport.ts

/**
 * Permite transferir una sesion activa a otra maquina:
 * 1. `kcode teleport export` → Genera paquete comprimido con:
 *    - Mensajes de la sesion
 *    - Archivos referenciados
 *    - Git diff pendiente
 *    - Plan activo
 * 2. Sube a KCode Cloud (o genera archivo local)
 * 3. `kcode teleport import <code>` en otra maquina → Restaura sesion
 *
 * Requiere: KCode Cloud account o transferencia manual del archivo.
 */

interface TeleportPackage {
  version: string;
  exportedAt: number;
  sourceHost: string;
  session: SessionCheckpoint;
  gitDiff?: string;
  referencedFiles: { path: string; content: string }[];
  plan?: PlanState;
}

async function exportSession(session: SessionCheckpoint): Promise<{ code: string; url?: string }> {
  // Empaquetar, comprimir, subir a cloud o generar archivo local
  throw new Error('Not implemented');
}

async function importSession(codeOrPath: string): Promise<TeleportPackage> {
  // Descargar/leer, descomprimir, validar, restaurar
  throw new Error('Not implemented');
}

export { exportSession, importSession, type TeleportPackage };
```

### 6.6 Criterios de Aceptacion

- [ ] Crash recovery detecta sesion interrumpida al startup
- [ ] Checkpoints cada 30s (configurable)
- [ ] `/checkpoint` crea checkpoint manual
- [ ] `kcode teleport export` genera paquete de sesion
- [ ] `kcode teleport import <code>` restaura sesion en otra maquina
- [ ] Max 10 checkpoints por sesion (auto-prune)
- [ ] Tests cubren: crash detection, checkpoint save/load, teleport round-trip
