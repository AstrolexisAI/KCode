# Plan v1.8.0 — Camino F: Quality of Life & Developer Experience

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~4,000-5,500 LoC nuevas
**Filosofia:** Features que no son glamorosas pero hacen que KCode se SIENTA mejor
de usar dia a dia. Pulido, integraciones, y detalles que marcan la diferencia.

> NOTA: Cada feature tiene flag para activar/desactivar. Todo backwards-compatible
> con v1.7.0. NO se copia codigo — se reimplementan conceptos adaptados al stack
> KCode (Bun + SQLite + React/Ink).

---

## INDICE

1. [Feature F1: Doctor Avanzado con Health Score](#feature-f1-doctor-avanzado-con-health-score)
2. [Feature F2: Cost Dashboard Interactivo](#feature-f2-cost-dashboard-interactivo)
3. [Feature F3: GrepReplace Mejorado con Preview](#feature-f3-grepreplace-mejorado-con-preview)
4. [Feature F4: Auto-Test Detection & Runner](#feature-f4-auto-test-detection--runner)
5. [Feature F5: Changelog Generator](#feature-f5-changelog-generator)
6. [Feature F6: Shell Completions Nativas](#feature-f6-shell-completions-nativas)

---

## Feature F1: Doctor Avanzado con Health Score

### 1.1 Contexto

`kcode doctor` actualmente verifica dependencias basicas. Claude Code no tiene
un doctor comparable, pero KCode puede diferenciarse con un sistema de health
scoring que califique el estado del entorno y sugiera mejoras.

### 1.2 Archivos Nuevos

```
src/
  core/
    doctor/
      health-score.ts              (~300 lineas) - Calculador de health score
      health-score.test.ts         (~250 lineas) - Tests
      checks/
        runtime-check.ts           (~100 lineas) - Verifica Bun, versiones
        model-check.ts             (~150 lineas) - Verifica modelos disponibles
        config-check.ts            (~120 lineas) - Verifica config valida
        network-check.ts           (~100 lineas) - Verifica conectividad
        storage-check.ts           (~100 lineas) - Verifica espacio en disco y DB
        gpu-check.ts               (~120 lineas) - Verifica GPU/VRAM
        plugin-check.ts            (~100 lineas) - Verifica plugins sanos
```

**Archivos Existentes a Modificar:**
- `src/core/doctor.ts` — Integrar health score y checks modulares

### 1.3 Diseño

```typescript
// src/core/doctor/health-score.ts

interface HealthCheck {
  name: string;
  category: 'runtime' | 'model' | 'config' | 'network' | 'storage' | 'gpu' | 'plugin';
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
  fix?: string;          // Sugerencia de como arreglar
  weight: number;        // Importancia (1-10)
}

interface HealthReport {
  score: number;         // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  checks: HealthCheck[];
  summary: string;
  criticalIssues: HealthCheck[];
  suggestions: string[];
  timestamp: number;
}

function calculateScore(checks: HealthCheck[]): number {
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const check of checks) {
    if (check.status === 'skip') continue;
    totalWeight += check.weight;
    if (check.status === 'pass') earnedWeight += check.weight;
    else if (check.status === 'warn') earnedWeight += check.weight * 0.5;
    // fail = 0 points
  }

  return totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 100;
}

function scoreToGrade(score: number): HealthReport['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

async function runHealthChecks(): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  // Ejecutar todos los checks registrados
  checks.push(await checkRuntime());
  checks.push(await checkModels());
  checks.push(await checkConfig());
  checks.push(await checkNetwork());
  checks.push(await checkStorage());
  checks.push(await checkGpu());
  checks.push(await checkPlugins());

  const score = calculateScore(checks);
  const grade = scoreToGrade(score);
  const criticalIssues = checks.filter(c => c.status === 'fail');
  const suggestions = checks.filter(c => c.fix).map(c => c.fix!);

  return {
    score,
    grade,
    checks,
    summary: `Health Score: ${score}/100 (${grade}) — ${criticalIssues.length} issues criticos`,
    criticalIssues,
    suggestions,
    timestamp: Date.now(),
  };
}

// Checks individuales:

async function checkRuntime(): Promise<HealthCheck> {
  const bunVersion = Bun.version;
  const major = parseInt(bunVersion.split('.')[0] ?? '0');
  const minor = parseInt(bunVersion.split('.')[1] ?? '0');

  if (major >= 1 && minor >= 2) {
    return { name: 'Bun Runtime', category: 'runtime', status: 'pass', message: `Bun ${bunVersion}`, weight: 10 };
  }
  return {
    name: 'Bun Runtime', category: 'runtime', status: 'warn',
    message: `Bun ${bunVersion} (recomendado >=1.2)`,
    fix: 'Actualizar Bun: curl -fsSL https://bun.sh/install | bash',
    weight: 10,
  };
}

async function checkModels(): Promise<HealthCheck> {
  // Verificar que al menos un modelo esta disponible
  // Local o cloud
  return { name: 'Models', category: 'model', status: 'pass', message: 'Al menos 1 modelo disponible', weight: 10 };
}

async function checkConfig(): Promise<HealthCheck> {
  // Validar que settings.json es JSON valido y no tiene campos deprecados
  return { name: 'Config', category: 'config', status: 'pass', message: 'Configuracion valida', weight: 5 };
}

async function checkNetwork(): Promise<HealthCheck> {
  // Ping a APIs configuradas
  return { name: 'Network', category: 'network', status: 'pass', message: 'Conectividad OK', weight: 3 };
}

async function checkStorage(): Promise<HealthCheck> {
  // Verificar espacio en disco, tamaño de DB, WAL size
  return { name: 'Storage', category: 'storage', status: 'pass', message: 'Espacio suficiente', weight: 5 };
}

async function checkGpu(): Promise<HealthCheck> {
  // Verificar GPU disponible si hay modelos locales configurados
  return { name: 'GPU', category: 'gpu', status: 'skip', message: 'No hay modelos locales configurados', weight: 7 };
}

async function checkPlugins(): Promise<HealthCheck> {
  // Verificar que plugins instalados son validos
  return { name: 'Plugins', category: 'plugin', status: 'pass', message: '0 plugins con errores', weight: 3 };
}

export { runHealthChecks, calculateScore, type HealthReport, type HealthCheck };
```

### 1.4 Output Esperado

```
$ kcode doctor

  KCode Health Report — Score: 87/100 (B)

  ✓ Bun Runtime         Bun 1.2.4                                    [PASS]
  ✓ Models              mnemo:mark5 + claude-sonnet-4-20250514            [PASS]
  ✓ Config              Configuracion valida                         [PASS]
  ✓ Network             Conectividad OK (Anthropic: 45ms)            [PASS]
  ! Storage             DB awareness.db: 847MB (>500MB recomendado)  [WARN]
  ✓ GPU                 NVIDIA RTX 4090 — 24GB VRAM                  [PASS]
  ✗ Plugins             plugin-git v0.3 incompatible con KCode 1.8   [FAIL]

  Sugerencias:
    1. Ejecutar `kcode db vacuum` para reducir tamaño de DB
    2. Actualizar plugin-git: `kcode plugins update plugin-git`
```

### 1.5 Criterios de Aceptacion

- [ ] `kcode doctor` muestra score numerico y grade (A-F)
- [ ] Checks modulares y extensibles (facil agregar nuevos)
- [ ] Cada check tiene sugerencia de fix
- [ ] Colores: verde=pass, amarillo=warn, rojo=fail, gris=skip
- [ ] Exit code 0 si score >= 60, exit code 1 si < 60

---

## Feature F2: Cost Dashboard Interactivo

### 2.1 Contexto

KCode tiene `/cost` basico que muestra tokens y costo de la sesion actual.
Claude Code tiene cost tracking similar. Pero ninguno tiene un dashboard
interactivo con historial, tendencias, y comparacion entre modelos.

### 2.2 Archivos Nuevos

```
src/
  core/
    cost/
      tracker.ts                   (~250 lineas) - Tracker persistente con historial
      tracker.test.ts              (~200 lineas) - Tests
      dashboard.ts                 (~300 lineas) - Dashboard interactivo
      dashboard.test.ts            (~200 lineas) - Tests
      types.ts                     (~60 lineas)  - Interfaces
  ui/
    components/
      cost-chart.tsx               (~150 lineas) - Componente de grafico ASCII
```

**Archivos Existentes a Modificar:**
- `src/core/pricing.ts` — Exponer historial de costos
- `src/core/config.ts` — Settings de cost tracking

### 2.3 Diseño

```typescript
// src/core/cost/types.ts

interface CostEntry {
  timestamp: number;
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolName?: string;       // Si fue un tool call
}

interface CostSummary {
  period: 'today' | 'week' | 'month' | 'all';
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessions: number;
  avgCostPerSession: number;
  byModel: { model: string; costUsd: number; percentage: number }[];
  byDay: { date: string; costUsd: number }[];
  trend: 'up' | 'down' | 'stable';
  trendPercentage: number;
}
```

```typescript
// src/core/cost/tracker.ts

class CostTracker {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.run(`CREATE TABLE IF NOT EXISTS cost_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      tool_name TEXT
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_history(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_history(session_id)`);
  }

  record(entry: CostEntry): void {
    this.db.run(
      `INSERT INTO cost_history (timestamp, session_id, model, provider, input_tokens, output_tokens, cost_usd, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.timestamp, entry.sessionId, entry.model, entry.provider, entry.inputTokens, entry.outputTokens, entry.costUsd, entry.toolName ?? null]
    );
  }

  getSummary(period: CostSummary['period']): CostSummary {
    const since = this.periodToTimestamp(period);

    const totals = this.db.query(`
      SELECT COUNT(DISTINCT session_id) as sessions,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(cost_usd) as cost_usd
      FROM cost_history WHERE timestamp >= ?
    `).get(since) as any;

    const byModel = this.db.query(`
      SELECT model, SUM(cost_usd) as cost_usd
      FROM cost_history WHERE timestamp >= ?
      GROUP BY model ORDER BY cost_usd DESC
    `).all(since) as any[];

    const byDay = this.db.query(`
      SELECT date(timestamp/1000, 'unixepoch') as date, SUM(cost_usd) as cost_usd
      FROM cost_history WHERE timestamp >= ?
      GROUP BY date ORDER BY date
    `).all(since) as any[];

    const totalCost = totals?.cost_usd ?? 0;

    return {
      period,
      totalCostUsd: totalCost,
      totalInputTokens: totals?.input_tokens ?? 0,
      totalOutputTokens: totals?.output_tokens ?? 0,
      sessions: totals?.sessions ?? 0,
      avgCostPerSession: totals?.sessions > 0 ? totalCost / totals.sessions : 0,
      byModel: byModel.map(m => ({
        model: m.model,
        costUsd: m.cost_usd,
        percentage: totalCost > 0 ? (m.cost_usd / totalCost) * 100 : 0,
      })),
      byDay: byDay.map(d => ({ date: d.date, costUsd: d.cost_usd })),
      trend: 'stable',
      trendPercentage: 0,
    };
  }

  private periodToTimestamp(period: CostSummary['period']): number {
    const now = Date.now();
    switch (period) {
      case 'today': return now - 24 * 60 * 60 * 1000;
      case 'week': return now - 7 * 24 * 60 * 60 * 1000;
      case 'month': return now - 30 * 24 * 60 * 60 * 1000;
      case 'all': return 0;
    }
  }
}

export { CostTracker };
```

### 2.4 Output Esperado

```
$ kcode cost --period month

  Cost Dashboard — Last 30 Days

  Total:    $12.47 across 43 sessions ($0.29/session avg)
  Tokens:   1.2M input / 340K output
  Trend:    ↓ 15% vs previous month

  By Model:
    claude-sonnet-4-20250514   $8.20  ████████████████░░░░  66%
    mnemo:mark5         $2.10  █████░░░░░░░░░░░░░░░  17%
    gpt-4o              $1.50  ████░░░░░░░░░░░░░░░░  12%
    deepseek-v3         $0.67  ██░░░░░░░░░░░░░░░░░░   5%

  By Day:
    Mar 01  $0.45 ██
    Mar 02  $0.82 ████
    Mar 03  $0.33 ██
    ...
```

### 2.5 Criterios de Aceptacion

- [ ] Historial de costos persistente en SQLite
- [ ] `/cost` muestra sesion actual (comportamiento existente preservado)
- [ ] `/cost --period week|month|all` muestra dashboard con tendencias
- [ ] Desglose por modelo con porcentajes
- [ ] Graficos ASCII por dia
- [ ] Indicador de tendencia (up/down/stable vs periodo anterior)

---

## Feature F3: GrepReplace Mejorado con Preview

### 3.1 Contexto

KCode tiene GrepReplace pero no muestra preview de los cambios antes de aplicarlos.
Esto es critico para operaciones masivas donde un regex incorrecto puede dañar
muchos archivos.

### 3.2 Archivos Nuevos

```
src/
  tools/
    grep-replace-preview.ts       (~200 lineas) - Preview engine
    grep-replace-preview.test.ts  (~180 lineas) - Tests
```

**Archivos Existentes a Modificar:**
- `src/tools/grep-replace.ts` — Agregar modo preview con diff

### 3.3 Diseño

```typescript
// src/tools/grep-replace-preview.ts

interface GrepReplacePreview {
  /** Archivos que serian modificados */
  files: {
    path: string;
    matches: number;
    diff: string;          // Unified diff format
  }[];
  totalFiles: number;
  totalMatches: number;
}

/**
 * Genera preview de un grep-replace sin modificar archivos.
 * Muestra diff unificado de cada archivo afectado.
 */
async function previewGrepReplace(
  pattern: string,
  replacement: string,
  glob: string,
  cwd: string,
): Promise<GrepReplacePreview> {
  // 1. Buscar archivos que matchean el glob
  // 2. Para cada archivo, buscar lineas que matchean el pattern
  // 3. Generar diff (antes/despues) sin escribir
  // 4. Retornar preview

  const results: GrepReplacePreview['files'] = [];
  // ... implementacion ...

  return {
    files: results,
    totalFiles: results.length,
    totalMatches: results.reduce((sum, f) => sum + f.matches, 0),
  };
}

export { previewGrepReplace, type GrepReplacePreview };
```

### 3.4 Criterios de Aceptacion

- [ ] GrepReplace muestra preview antes de aplicar cambios
- [ ] Preview en formato unified diff con colores
- [ ] Cuenta de archivos y matches afectados
- [ ] El modelo puede revisar el preview antes de confirmar
- [ ] Flag `--no-preview` para skip (para scripts)

---

## Feature F4: Auto-Test Detection & Runner

### 4.1 Contexto

Cuando KCode modifica codigo, deberia detectar automaticamente si hay tests
relacionados y sugerir ejecutarlos. Claude Code hace algo similar pero no
de forma proactiva.

### 4.2 Archivos Nuevos

```
src/
  core/
    auto-test/
      detector.ts                  (~250 lineas) - Detecta tests relacionados
      detector.test.ts             (~200 lineas) - Tests
      runner.ts                    (~200 lineas) - Runner inteligente
      runner.test.ts               (~150 lineas) - Tests
      types.ts                     (~50 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/hooks.ts` — Hook PostFileWrite para trigger auto-test suggestion

### 4.3 Diseño

```typescript
// src/core/auto-test/detector.ts

interface TestDetection {
  /** Archivo fuente modificado */
  sourceFile: string;
  /** Tests relacionados encontrados */
  testFiles: string[];
  /** Comando para ejecutar los tests */
  command: string;
  /** Framework detectado */
  framework: 'bun' | 'vitest' | 'jest' | 'pytest' | 'go' | 'cargo' | 'mocha' | 'unknown';
  /** Confianza en la deteccion (0-1) */
  confidence: number;
}

/**
 * Dado un archivo modificado, encuentra tests relacionados.
 *
 * Estrategias (en orden):
 * 1. Nombre directo: foo.ts → foo.test.ts, foo.spec.ts, foo_test.ts
 * 2. Directorio __tests__: foo.ts → __tests__/foo.test.ts
 * 3. Directorio tests/: src/foo.ts → tests/foo.test.ts
 * 4. Import analysis: buscar tests que importan el archivo modificado
 */
async function detectTests(modifiedFile: string, cwd: string): Promise<TestDetection | null> {
  const testFiles: string[] = [];

  // Estrategia 1: nombre directo
  const base = modifiedFile.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, '');
  const extensions = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '_test.go', '_test.py'];

  for (const ext of extensions) {
    const testPath = base + ext;
    if (await Bun.file(testPath).exists()) {
      testFiles.push(testPath);
    }
  }

  // Estrategia 2: __tests__/
  // ... similar pattern matching ...

  if (testFiles.length === 0) return null;

  const framework = detectFramework(cwd);
  const command = buildTestCommand(framework, testFiles);

  return {
    sourceFile: modifiedFile,
    testFiles,
    command,
    framework,
    confidence: testFiles.length > 0 ? 0.9 : 0.5,
  };
}

function detectFramework(cwd: string): TestDetection['framework'] {
  // Detectar por package.json, pyproject.toml, go.mod, Cargo.toml
  // Verificar scripts de test en package.json
  return 'bun'; // Default para KCode
}

function buildTestCommand(framework: TestDetection['framework'], testFiles: string[]): string {
  switch (framework) {
    case 'bun': return `bun test ${testFiles.join(' ')}`;
    case 'vitest': return `npx vitest run ${testFiles.join(' ')}`;
    case 'jest': return `npx jest ${testFiles.join(' ')}`;
    case 'pytest': return `pytest ${testFiles.join(' ')}`;
    case 'go': return `go test ${testFiles.join(' ')}`;
    case 'cargo': return `cargo test`;
    default: return `echo "Framework desconocido — ejecutar tests manualmente"`;
  }
}

export { detectTests, type TestDetection };
```

### 4.4 Criterios de Aceptacion

- [ ] Detecta tests por naming convention (foo.ts → foo.test.ts)
- [ ] Detecta framework automaticamente (bun, vitest, jest, pytest, go, cargo)
- [ ] Sugiere comando de test despues de editar archivos
- [ ] Configurable: `settings.autoTest.enabled`, `settings.autoTest.autoRun`
- [ ] Si `autoRun: true`, ejecuta tests automaticamente despues de cada edit

---

## Feature F5: Changelog Generator

### 5.1 Contexto

Generar changelogs es tedioso. KCode puede analizar commits desde el ultimo tag
y generar un changelog estructurado automaticamente.

### 5.2 Archivos Nuevos

```
src/
  core/
    changelog/
      generator.ts                 (~300 lineas) - Generador de changelog
      generator.test.ts            (~250 lineas) - Tests
      commit-parser.ts             (~200 lineas) - Parser de conventional commits
      commit-parser.test.ts        (~150 lineas) - Tests
      types.ts                     (~50 lineas)  - Interfaces
```

### 5.3 Diseño

```typescript
// src/core/changelog/types.ts

interface ChangelogEntry {
  type: 'feat' | 'fix' | 'docs' | 'refactor' | 'test' | 'chore' | 'perf' | 'breaking';
  scope?: string;
  description: string;
  hash: string;
  author: string;
  date: string;
  breaking: boolean;
}

interface Changelog {
  version: string;
  date: string;
  entries: ChangelogEntry[];
  breaking: ChangelogEntry[];
  features: ChangelogEntry[];
  fixes: ChangelogEntry[];
  other: ChangelogEntry[];
  markdown: string;       // Rendered markdown
}
```

```typescript
// src/core/changelog/generator.ts

/**
 * Genera changelog a partir de git log.
 *
 * 1. Obtener commits desde ultimo tag (o desde inicio)
 * 2. Parsear conventional commits (feat:, fix:, etc.)
 * 3. Si commit no sigue convencion, usar LLM para clasificar
 * 4. Agrupar por tipo
 * 5. Generar markdown
 */
async function generateChangelog(options: {
  since?: string;         // Tag o commit (default: ultimo tag)
  version?: string;       // Version del release
  useLlm?: boolean;       // Usar LLM para commits no-conventional
  cwd?: string;
}): Promise<Changelog> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Obtener ultimo tag
  const lastTag = options.since ?? await getLastTag(cwd);

  // 2. Obtener commits
  const commits = await getCommitsSince(lastTag, cwd);

  // 3. Parsear
  const entries: ChangelogEntry[] = [];
  for (const commit of commits) {
    const parsed = parseConventionalCommit(commit.message);
    if (parsed) {
      entries.push({ ...parsed, hash: commit.hash, author: commit.author, date: commit.date });
    } else if (options.useLlm) {
      // Usar LLM para clasificar
      const classified = await classifyWithLlm(commit.message);
      entries.push({ ...classified, hash: commit.hash, author: commit.author, date: commit.date });
    } else {
      entries.push({
        type: 'chore', description: commit.message, hash: commit.hash,
        author: commit.author, date: commit.date, breaking: false,
      });
    }
  }

  // 4. Agrupar
  const breaking = entries.filter(e => e.breaking);
  const features = entries.filter(e => e.type === 'feat');
  const fixes = entries.filter(e => e.type === 'fix');
  const other = entries.filter(e => !['feat', 'fix'].includes(e.type) && !e.breaking);

  // 5. Render markdown
  const version = options.version ?? 'Unreleased';
  const date = new Date().toISOString().split('T')[0]!;
  let md = `## ${version} (${date})\n\n`;

  if (breaking.length > 0) {
    md += `### BREAKING CHANGES\n\n`;
    for (const e of breaking) md += `- ${e.description} (${e.hash.slice(0, 7)})\n`;
    md += '\n';
  }
  if (features.length > 0) {
    md += `### Features\n\n`;
    for (const e of features) md += `- ${e.scope ? `**${e.scope}:** ` : ''}${e.description} (${e.hash.slice(0, 7)})\n`;
    md += '\n';
  }
  if (fixes.length > 0) {
    md += `### Bug Fixes\n\n`;
    for (const e of fixes) md += `- ${e.scope ? `**${e.scope}:** ` : ''}${e.description} (${e.hash.slice(0, 7)})\n`;
    md += '\n';
  }
  if (other.length > 0) {
    md += `### Other Changes\n\n`;
    for (const e of other) md += `- ${e.description} (${e.hash.slice(0, 7)})\n`;
    md += '\n';
  }

  return { version, date, entries, breaking, features, fixes, other, markdown: md };
}

async function getLastTag(cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', 'describe', '--tags', '--abbrev=0'], { cwd });
  const output = await new Response(proc.stdout).text();
  return output.trim() || '';
}

async function getCommitsSince(since: string, cwd: string): Promise<{ hash: string; message: string; author: string; date: string }[]> {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const proc = Bun.spawn(['git', 'log', range, '--pretty=format:%H|%s|%an|%as'], { cwd });
  const output = await new Response(proc.stdout).text();
  return output.trim().split('\n').filter(Boolean).map(line => {
    const [hash, message, author, date] = line.split('|');
    return { hash: hash!, message: message!, author: author!, date: date! };
  });
}

export { generateChangelog };
```

### 5.4 Criterios de Aceptacion

- [ ] `/changelog` genera changelog desde ultimo tag
- [ ] `/changelog --version 1.8.0` genera para release especifico
- [ ] Parsea conventional commits automaticamente
- [ ] Opcion de usar LLM para clasificar commits no-conventional
- [ ] Output en markdown listo para CHANGELOG.md
- [ ] Agrupa por: breaking, features, fixes, other
- [ ] Incluye hash y autor

---

## Feature F6: Shell Completions Nativas

### 6.1 Contexto

KCode no tiene completions de shell. `kcode <TAB>` no autocompleta subcomandos,
flags, ni opciones. Claude Code tampoco tiene esto bien resuelto.

### 6.2 Archivos Nuevos

```
src/
  cli/
    completions/
      generator.ts                 (~300 lineas) - Generador multi-shell
      generator.test.ts            (~200 lineas) - Tests
      bash-completions.ts          (~150 lineas) - Template bash
      zsh-completions.ts           (~150 lineas) - Template zsh
      fish-completions.ts          (~150 lineas) - Template fish
```

**Archivos Existentes a Modificar:**
- `src/cli/` — Agregar subcomando `kcode completions bash|zsh|fish`

### 6.3 Diseño

```typescript
// src/cli/completions/generator.ts

type Shell = 'bash' | 'zsh' | 'fish';

interface CompletionSpec {
  subcommands: { name: string; description: string }[];
  globalFlags: { name: string; short?: string; description: string; takesValue: boolean }[];
  slashCommands: { name: string; description: string }[];
}

function generateCompletions(shell: Shell, spec: CompletionSpec): string {
  switch (shell) {
    case 'bash': return generateBashCompletions(spec);
    case 'zsh': return generateZshCompletions(spec);
    case 'fish': return generateFishCompletions(spec);
  }
}

function generateZshCompletions(spec: CompletionSpec): string {
  let output = '#compdef kcode\n\n';
  output += '_kcode() {\n';
  output += '  local -a subcommands\n';
  output += '  subcommands=(\n';
  for (const cmd of spec.subcommands) {
    output += `    '${cmd.name}:${cmd.description}'\n`;
  }
  output += '  )\n\n';
  output += '  _describe "kcode commands" subcommands\n';
  output += '}\n\n';
  output += '_kcode "$@"\n';
  return output;
}

function generateBashCompletions(spec: CompletionSpec): string {
  const cmds = spec.subcommands.map(c => c.name).join(' ');
  return `_kcode_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  COMPREPLY=($(compgen -W "${cmds}" -- "$cur"))
}
complete -F _kcode_completions kcode
`;
}

function generateFishCompletions(spec: CompletionSpec): string {
  let output = '';
  for (const cmd of spec.subcommands) {
    output += `complete -c kcode -n "__fish_use_subcommand" -a "${cmd.name}" -d "${cmd.description}"\n`;
  }
  return output;
}

export { generateCompletions, type Shell, type CompletionSpec };
```

### 6.4 Criterios de Aceptacion

- [ ] `kcode completions bash` genera script de completions para bash
- [ ] `kcode completions zsh` genera script para zsh
- [ ] `kcode completions fish` genera script para fish
- [ ] `eval "$(kcode completions zsh)"` funciona sin errores
- [ ] Autocompleta subcomandos, flags globales, y modelos
- [ ] Instrucciones de instalacion en output

---

## Resumen de Estimaciones por Feature

| Feature | Archivos Nuevos | LoC Estimadas | Prioridad |
|---------|----------------|---------------|-----------|
| F1: Doctor Health Score | 8 | ~940 | Alta |
| F2: Cost Dashboard | 6 | ~860 | Media |
| F3: GrepReplace Preview | 2 | ~380 | Media |
| F4: Auto-Test Detection | 5 | ~650 | Alta |
| F5: Changelog Generator | 5 | ~750 | Baja |
| F6: Shell Completions | 5 | ~950 | Alta |
| **TOTAL** | **31** | **~4,530** | — |
