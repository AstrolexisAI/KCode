# Plan v1.8.0 — Camino E: Feature Parity con Claude Code

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~5,000-7,000 LoC nuevas
**Filosofia:** Features que Claude Code tiene y KCode no, que aportan valor real
al usuario. NO se trata de copiar todo — solo lo que genuinamente mejora KCode.

> NOTA: Cada feature tiene flag para activar/desactivar. Todo backwards-compatible
> con v1.7.0. NO se copia codigo — se reimplementan conceptos adaptados al stack
> KCode (Bun + SQLite + React/Ink).

---

## INDICE

1. [Feature E1: Notebook Edit Tool](#feature-e1-notebook-edit-tool)
2. [Feature E2: Remote Agent Triggers](#feature-e2-remote-agent-triggers)
3. [Feature E3: Dream Tasks (Background Processing)](#feature-e3-dream-tasks-background-processing)
4. [Feature E4: Synthetic Output Tool](#feature-e4-synthetic-output-tool)
5. [Feature E5: Session Snapshots & History Browser](#feature-e5-session-snapshots--history-browser)
6. [Feature E6: Advanced Permission Policies](#feature-e6-advanced-permission-policies)

---

## Feature E1: Notebook Edit Tool

### 1.1 Contexto

Claude Code tiene `NotebookEditTool` que permite editar Jupyter notebooks (.ipynb)
cell-by-cell. Los notebooks son JSON con estructura especifica y editarlos como
texto plano es fragil y propenso a errores.

KCode actualmente puede leer notebooks (FileRead los renderiza) pero no puede
editarlos de forma estructurada. Esto es critico para data scientists.

### 1.2 Archivos Nuevos

```
src/
  tools/
    notebook-edit.ts               (~350 lineas) - Tool de edicion de notebooks
    notebook-edit.test.ts          (~300 lineas) - Tests
    notebook-utils.ts              (~200 lineas) - Parsing/serialization de .ipynb
    notebook-utils.test.ts         (~180 lineas) - Tests
```

**Archivos Existentes a Modificar:**
- `src/tools/index.ts` — Registrar NotebookEditTool
- `src/core/system-prompt.ts` — Agregar instrucciones de uso del tool

### 1.3 Estructura de Jupyter Notebook

```typescript
// src/tools/notebook-utils.ts

/** Estructura de un Jupyter Notebook v4 */
interface JupyterNotebook {
  nbformat: 4;
  nbformat_minor: number;
  metadata: {
    kernelspec?: { display_name: string; language: string; name: string };
    language_info?: { name: string; version: string };
    [key: string]: unknown;
  };
  cells: JupyterCell[];
}

interface JupyterCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[];           // Lineas de contenido
  metadata: Record<string, unknown>;
  outputs?: CellOutput[];     // Solo en code cells
  execution_count?: number | null;
  id?: string;
}

interface CellOutput {
  output_type: 'stream' | 'display_data' | 'execute_result' | 'error';
  text?: string[];
  data?: Record<string, unknown>;
  name?: string;              // stdout/stderr
  ename?: string;             // error name
  evalue?: string;            // error value
  traceback?: string[];       // error traceback
}

/** Parse seguro de .ipynb */
function parseNotebook(content: string): JupyterNotebook {
  const nb = JSON.parse(content);
  if (nb.nbformat !== 4) {
    throw new Error(`Solo se soporta nbformat 4, encontrado: ${nb.nbformat}`);
  }
  return nb as JupyterNotebook;
}

/** Serializar preservando formato original (trailing newline, indent) */
function serializeNotebook(nb: JupyterNotebook): string {
  return JSON.stringify(nb, null, 1) + '\n';
}

/** Buscar cell por indice o por contenido parcial */
function findCell(nb: JupyterNotebook, query: { index?: number; contains?: string }): number {
  if (query.index !== undefined) return query.index;
  if (query.contains) {
    return nb.cells.findIndex(c => c.source.join('').includes(query.contains!));
  }
  return -1;
}

export { parseNotebook, serializeNotebook, findCell };
export type { JupyterNotebook, JupyterCell, CellOutput };
```

### 1.4 Tool Definition

```typescript
// src/tools/notebook-edit.ts

import { parseNotebook, serializeNotebook, findCell } from './notebook-utils';
import type { JupyterCell } from './notebook-utils';

interface NotebookEditInput {
  /** Ruta al archivo .ipynb */
  notebook_path: string;
  /** Accion a realizar */
  action: 'edit_cell' | 'insert_cell' | 'delete_cell' | 'move_cell' | 'clear_outputs';
  /** Indice de la celda (0-based) */
  cell_index?: number;
  /** Buscar celda por contenido (alternativa a cell_index) */
  cell_contains?: string;
  /** Nuevo contenido de la celda (para edit_cell e insert_cell) */
  new_source?: string;
  /** Tipo de celda (para insert_cell, default: code) */
  cell_type?: 'code' | 'markdown' | 'raw';
  /** Posicion destino (para move_cell) */
  target_index?: number;
}

async function execute(input: NotebookEditInput): Promise<string> {
  const file = Bun.file(input.notebook_path);
  if (!await file.exists()) {
    throw new Error(`Notebook no encontrado: ${input.notebook_path}`);
  }

  const content = await file.text();
  const nb = parseNotebook(content);

  switch (input.action) {
    case 'edit_cell': {
      const idx = findCell(nb, { index: input.cell_index, contains: input.cell_contains });
      if (idx < 0 || idx >= nb.cells.length) throw new Error(`Celda no encontrada`);
      const lines = (input.new_source ?? '').split('\n').map((l, i, arr) =>
        i < arr.length - 1 ? l + '\n' : l
      );
      nb.cells[idx]!.source = lines;
      nb.cells[idx]!.outputs = [];
      nb.cells[idx]!.execution_count = null;
      break;
    }

    case 'insert_cell': {
      const idx = input.cell_index ?? nb.cells.length;
      const newCell: JupyterCell = {
        cell_type: input.cell_type ?? 'code',
        source: (input.new_source ?? '').split('\n').map((l, i, arr) =>
          i < arr.length - 1 ? l + '\n' : l
        ),
        metadata: {},
        ...(input.cell_type !== 'markdown' && input.cell_type !== 'raw'
          ? { outputs: [], execution_count: null }
          : {}),
      };
      nb.cells.splice(idx, 0, newCell);
      break;
    }

    case 'delete_cell': {
      const idx = findCell(nb, { index: input.cell_index, contains: input.cell_contains });
      if (idx < 0 || idx >= nb.cells.length) throw new Error(`Celda no encontrada`);
      nb.cells.splice(idx, 1);
      break;
    }

    case 'move_cell': {
      const idx = findCell(nb, { index: input.cell_index, contains: input.cell_contains });
      if (idx < 0 || idx >= nb.cells.length) throw new Error(`Celda origen no encontrada`);
      const target = input.target_index ?? 0;
      const [cell] = nb.cells.splice(idx, 1);
      nb.cells.splice(target, 0, cell!);
      break;
    }

    case 'clear_outputs': {
      if (input.cell_index !== undefined) {
        const cell = nb.cells[input.cell_index];
        if (cell?.cell_type === 'code') {
          cell.outputs = [];
          cell.execution_count = null;
        }
      } else {
        // Limpiar todas
        for (const cell of nb.cells) {
          if (cell.cell_type === 'code') {
            cell.outputs = [];
            cell.execution_count = null;
          }
        }
      }
      break;
    }
  }

  await Bun.write(input.notebook_path, serializeNotebook(nb));
  return `Notebook editado: ${input.action} en ${input.notebook_path} (${nb.cells.length} celdas)`;
}

export const NotebookEditTool = {
  name: 'NotebookEdit',
  description: 'Edit Jupyter notebook (.ipynb) cells: edit, insert, delete, move, or clear outputs.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      notebook_path: { type: 'string', description: 'Path to the .ipynb file' },
      action: { type: 'string', enum: ['edit_cell', 'insert_cell', 'delete_cell', 'move_cell', 'clear_outputs'] },
      cell_index: { type: 'number', description: 'Cell index (0-based)' },
      cell_contains: { type: 'string', description: 'Find cell by content match (alternative to cell_index)' },
      new_source: { type: 'string', description: 'New cell content (for edit/insert)' },
      cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Cell type (for insert, default: code)' },
      target_index: { type: 'number', description: 'Target position (for move)' },
    },
    required: ['notebook_path', 'action'],
  },
  execute,
};
```

### 1.5 Criterios de Aceptacion

- [ ] Editar contenido de celda code/markdown existente
- [ ] Insertar nueva celda en posicion arbitraria
- [ ] Eliminar celda por indice o por contenido
- [ ] Mover celda a nueva posicion
- [ ] Limpiar outputs de una celda o todas
- [ ] Preservar metadata y formato del notebook
- [ ] Error claro si el notebook no es v4
- [ ] Tests con notebook fixture real

---

## Feature E2: Remote Agent Triggers

### 2.1 Contexto

Claude Code tiene `RemoteTriggerTool` que permite programar agentes que se ejecutan
en un servidor remoto con schedule cron. KCode tiene `CronCreate/List/Delete` pero
es local (requiere que la maquina este encendida).

Remote triggers permiten:
- CI/CD: "cada push a main, revisa el PR"
- Monitoreo: "cada hora, revisa los logs de produccion"
- Mantenimiento: "cada lunes, actualiza dependencias"

### 2.2 Archivos Nuevos

```
src/
  remote/
    triggers/
      trigger-manager.ts           (~350 lineas) - CRUD de triggers remotos
      trigger-manager.test.ts      (~300 lineas) - Tests
      trigger-executor.ts          (~250 lineas) - Ejecutor en servidor
      trigger-executor.test.ts     (~200 lineas) - Tests
      trigger-api.ts               (~200 lineas) - API client para KCode Cloud
      trigger-api.test.ts          (~150 lineas) - Tests
      types.ts                     (~80 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/tools/index.ts` — Registrar RemoteTriggerTool
- `src/core/system-prompt.ts` — Instrucciones de uso
- `src/cli/` — Agregar subcomando `kcode triggers list/create/delete/run`

### 2.3 Diseño

```typescript
// src/remote/triggers/types.ts

interface RemoteTrigger {
  id: string;
  name: string;
  /** Cron expression (5 campos: min hour dom month dow) */
  schedule: string;
  /** Prompt que ejecuta el agente remoto */
  prompt: string;
  /** Directorio de trabajo (relativo al repo) */
  workingDirectory?: string;
  /** Modelo a usar */
  model?: string;
  /** Max turnos del agente */
  maxTurns?: number;
  /** Variables de entorno adicionales */
  env?: Record<string, string>;
  /** Estado */
  status: 'active' | 'paused' | 'error';
  /** Ultima ejecucion */
  lastRun?: {
    timestamp: number;
    status: 'success' | 'error';
    summary?: string;
    durationMs: number;
  };
  /** Proxima ejecucion programada */
  nextRun?: number;
  createdAt: number;
  updatedAt: number;
}

interface TriggerCreateInput {
  name: string;
  schedule: string;
  prompt: string;
  workingDirectory?: string;
  model?: string;
  maxTurns?: number;
}

interface TriggerRunResult {
  triggerId: string;
  status: 'success' | 'error';
  summary: string;
  messagesCount: number;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  artifacts?: { path: string; action: 'created' | 'modified' | 'deleted' }[];
}
```

### 2.4 Trigger Manager

```typescript
// src/remote/triggers/trigger-manager.ts

class TriggerManager {
  private apiClient: TriggerApiClient;

  constructor(apiClient: TriggerApiClient) {
    this.apiClient = apiClient;
  }

  async create(input: TriggerCreateInput): Promise<RemoteTrigger> {
    // Validar cron expression
    validateCron(input.schedule);
    // Crear en KCode Cloud
    return this.apiClient.createTrigger(input);
  }

  async list(): Promise<RemoteTrigger[]> {
    return this.apiClient.listTriggers();
  }

  async get(id: string): Promise<RemoteTrigger | null> {
    return this.apiClient.getTrigger(id);
  }

  async update(id: string, updates: Partial<TriggerCreateInput>): Promise<RemoteTrigger> {
    if (updates.schedule) validateCron(updates.schedule);
    return this.apiClient.updateTrigger(id, updates);
  }

  async delete(id: string): Promise<void> {
    return this.apiClient.deleteTrigger(id);
  }

  async pause(id: string): Promise<void> {
    return this.apiClient.updateTrigger(id, { status: 'paused' } as any);
  }

  async resume(id: string): Promise<void> {
    return this.apiClient.updateTrigger(id, { status: 'active' } as any);
  }

  /** Ejecutar trigger manualmente (sin esperar al cron) */
  async runNow(id: string): Promise<TriggerRunResult> {
    return this.apiClient.runTrigger(id);
  }

  /** Obtener historial de ejecuciones */
  async getHistory(id: string, limit = 10): Promise<TriggerRunResult[]> {
    return this.apiClient.getTriggerHistory(id, limit);
  }
}

function validateCron(expression: string): void {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron invalido: se requieren 5 campos (min hour dom month dow), recibido: ${parts.length}`);
  }
  // Validacion basica de rangos
  const ranges = [
    [0, 59],  // minutos
    [0, 23],  // horas
    [1, 31],  // dia del mes
    [1, 12],  // mes
    [0, 7],   // dia de la semana (0 y 7 = domingo)
  ];
  for (let i = 0; i < 5; i++) {
    const part = parts[i]!;
    if (part === '*' || part.includes('/') || part.includes(',') || part.includes('-')) continue;
    const num = parseInt(part);
    if (isNaN(num) || num < ranges[i]![0] || num > ranges[i]![1]) {
      throw new Error(`Cron invalido: campo ${i} fuera de rango (${part})`);
    }
  }
}

export { TriggerManager, validateCron };
```

### 2.5 Criterios de Aceptacion

- [ ] `kcode triggers create --name "review" --schedule "0 9 * * 1-5" --prompt "revisa PRs abiertos"`
- [ ] `kcode triggers list` muestra triggers con estado y proxima ejecucion
- [ ] `kcode triggers run <id>` ejecuta manualmente
- [ ] `kcode triggers delete <id>` elimina
- [ ] `kcode triggers history <id>` muestra historial de ejecuciones
- [ ] RemoteTriggerTool disponible para que el modelo cree triggers conversacionalmente
- [ ] Requiere KCode Cloud account (error claro si no autenticado)

---

## Feature E3: Dream Tasks (Background Processing)

### 3.1 Contexto

Claude Code tiene "DreamTask" — tareas de background que procesan mientras el
usuario trabaja. Ejemplos:
- Indexar codebase para busqueda rapida
- Pre-cargar contexto de archivos probablemente relevantes
- Analizar patterns de uso para sugerencias
- Entrenar modelo local con datos del proyecto (distillation)

### 3.2 Archivos Nuevos

```
src/
  core/
    dream/
      dream-engine.ts              (~300 lineas) - Motor de tareas dream
      dream-engine.test.ts         (~250 lineas) - Tests
      dream-tasks.ts               (~400 lineas) - Tareas dream builtin
      dream-tasks.test.ts          (~300 lineas) - Tests
      scheduler.ts                 (~200 lineas) - Scheduler de prioridades
      scheduler.test.ts            (~150 lineas) - Tests
      types.ts                     (~60 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/conversation.ts` — Iniciar dream engine al idle
- `src/core/config.ts` — Settings de dream (enable/disable, prioridades)
- `src/core/codebase-index.ts` — Exponer reindexacion como dream task

### 3.3 Diseño

```typescript
// src/core/dream/types.ts

interface DreamTask {
  id: string;
  name: string;
  /** Prioridad: lower = mas urgente */
  priority: number;
  /** Funcion que ejecuta la tarea */
  execute: (ctx: DreamContext) => Promise<DreamResult>;
  /** Condicion para ejecutar (ej: "han pasado >5min desde ultimo index") */
  shouldRun: (state: DreamState) => boolean;
  /** Tiempo maximo de ejecucion en ms */
  timeoutMs: number;
  /** Puede interrumpirse si el usuario vuelve a interactuar */
  interruptible: boolean;
}

interface DreamContext {
  /** Acceso a la DB */
  db: Database;
  /** Directorio de trabajo */
  cwd: string;
  /** Señal de abort (se activa si usuario interactua) */
  signal: AbortSignal;
  /** Logger silencioso (no interrumpe UI) */
  log: (msg: string) => void;
}

interface DreamResult {
  taskName: string;
  status: 'completed' | 'interrupted' | 'error';
  durationMs: number;
  details?: string;
}

interface DreamState {
  lastIndexTime?: number;
  lastAnalysisTime?: number;
  lastDistillTime?: number;
  sessionTurnCount: number;
  idleSeconds: number;
}
```

```typescript
// src/core/dream/dream-engine.ts

class DreamEngine {
  private tasks: DreamTask[] = [];
  private running = false;
  private abortController?: AbortController;
  private state: DreamState = { sessionTurnCount: 0, idleSeconds: 0 };

  register(task: DreamTask): void {
    this.tasks.push(task);
    this.tasks.sort((a, b) => a.priority - b.priority);
  }

  /** Llamado cuando el usuario deja de interactuar (idle detected) */
  async startDreaming(ctx: Omit<DreamContext, 'signal'>): Promise<DreamResult[]> {
    if (this.running) return [];
    this.running = true;
    this.abortController = new AbortController();

    const results: DreamResult[] = [];

    for (const task of this.tasks) {
      if (this.abortController.signal.aborted) break;
      if (!task.shouldRun(this.state)) continue;

      const taskCtx: DreamContext = {
        ...ctx,
        signal: this.abortController.signal,
      };

      try {
        const result = await Promise.race([
          task.execute(taskCtx),
          new Promise<DreamResult>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), task.timeoutMs)
          ),
        ]);
        results.push(result);
      } catch (err) {
        results.push({
          taskName: task.name,
          status: this.abortController.signal.aborted ? 'interrupted' : 'error',
          durationMs: 0,
          details: String(err),
        });
      }
    }

    this.running = false;
    return results;
  }

  /** Llamado cuando el usuario vuelve a interactuar */
  wake(): void {
    this.abortController?.abort();
    this.state.idleSeconds = 0;
    this.state.sessionTurnCount++;
  }

  /** Tick de idle (llamar cada segundo mientras idle) */
  tickIdle(): void {
    this.state.idleSeconds++;
  }

  isRunning(): boolean { return this.running; }
}

export { DreamEngine };
```

### 3.4 Dream Tasks Builtin

```typescript
// src/core/dream/dream-tasks.ts

import type { DreamTask, DreamContext, DreamResult, DreamState } from './types';

/** Re-indexar codebase si han pasado >10 minutos */
const reindexTask: DreamTask = {
  id: 'reindex',
  name: 'Reindex Codebase',
  priority: 10,
  timeoutMs: 60_000,
  interruptible: true,
  shouldRun: (state: DreamState) => {
    if (!state.lastIndexTime) return true;
    return Date.now() - state.lastIndexTime > 10 * 60 * 1000;
  },
  execute: async (ctx: DreamContext): Promise<DreamResult> => {
    const start = Date.now();
    // Usar codebase-index existente
    ctx.log('Dream: reindexando codebase...');
    // await reindexCodebase(ctx.cwd, ctx.signal);
    return { taskName: 'Reindex Codebase', status: 'completed', durationMs: Date.now() - start };
  },
};

/** Analizar archivos modificados recientemente para pre-cargar contexto */
const preloadContextTask: DreamTask = {
  id: 'preload-context',
  name: 'Preload Context',
  priority: 20,
  timeoutMs: 30_000,
  interruptible: true,
  shouldRun: (state: DreamState) => state.sessionTurnCount > 3 && state.idleSeconds > 30,
  execute: async (ctx: DreamContext): Promise<DreamResult> => {
    const start = Date.now();
    ctx.log('Dream: pre-cargando contexto de archivos recientes...');
    // Analizar git diff y archivos abiertos recientemente
    // Cachear en memoria para acceso rapido
    return { taskName: 'Preload Context', status: 'completed', durationMs: Date.now() - start };
  },
};

/** Limpiar checkpoints viejos y compactar DB */
const maintenanceTask: DreamTask = {
  id: 'maintenance',
  name: 'DB Maintenance',
  priority: 50,
  timeoutMs: 15_000,
  interruptible: false,
  shouldRun: (state: DreamState) => state.idleSeconds > 120, // 2 min idle
  execute: async (ctx: DreamContext): Promise<DreamResult> => {
    const start = Date.now();
    ctx.log('Dream: mantenimiento de base de datos...');
    ctx.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    ctx.db.run('PRAGMA optimize');
    return { taskName: 'DB Maintenance', status: 'completed', durationMs: Date.now() - start };
  },
};

export const builtinDreamTasks: DreamTask[] = [
  reindexTask,
  preloadContextTask,
  maintenanceTask,
];
```

### 3.5 Criterios de Aceptacion

- [ ] Dream engine se activa despues de 30s de idle
- [ ] Se interrumpe inmediatamente cuando el usuario escribe
- [ ] `/dream status` muestra tareas ejecutadas y pendientes
- [ ] Reindexacion automatica en background
- [ ] DB maintenance automatico (WAL checkpoint, optimize)
- [ ] Configurable: `settings.dream.enabled`, `settings.dream.idleThresholdSeconds`
- [ ] Zero impacto en UX — usuario nunca ve delays por dream tasks

---

## Feature E4: Synthetic Output Tool

### 4.1 Contexto

Claude Code tiene `SyntheticOutputTool` que permite al modelo insertar contenido
en el stream de output sin hacer un tool call real. Esto es util para:
- Agregar contexto adicional al output sin consumir un turno
- Simular resultados cuando el tool real no esta disponible
- Testing y debugging del agent loop

### 4.2 Archivos Nuevos

```
src/
  tools/
    synthetic-output.ts            (~120 lineas) - Tool de output sintetico
    synthetic-output.test.ts       (~100 lineas) - Tests
```

**Archivos Existentes a Modificar:**
- `src/tools/index.ts` — Registrar SyntheticOutputTool

### 4.3 Diseño

```typescript
// src/tools/synthetic-output.ts

interface SyntheticOutputInput {
  /** Contenido a insertar en el stream */
  content: string;
  /** Tipo de contenido */
  type: 'text' | 'json' | 'markdown' | 'error';
  /** Si es true, el contenido se muestra al usuario. Si es false, solo al modelo */
  visible: boolean;
}

async function execute(input: SyntheticOutputInput): Promise<string> {
  // El contenido se retorna directamente como resultado del tool call.
  // El agent loop lo inserta en el historial de mensajes.
  // Si visible=false, se marca como metadata interna.
  return input.content;
}

export const SyntheticOutputTool = {
  name: 'SyntheticOutput',
  description: 'Insert synthetic content into the conversation stream without executing an external action. Useful for injecting context, simulated results, or structured data.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: { type: 'string', description: 'Content to inject' },
      type: { type: 'string', enum: ['text', 'json', 'markdown', 'error'], description: 'Content type (default: text)' },
      visible: { type: 'boolean', description: 'Whether the user sees this output (default: true)' },
    },
    required: ['content'],
  },
  execute,
};
```

### 4.4 Criterios de Aceptacion

- [ ] Tool disponible para el modelo
- [ ] Contenido con `visible: false` no se muestra en terminal
- [ ] Contenido con `visible: true` se renderiza normalmente
- [ ] No ejecuta ninguna accion externa (pure output)

---

## Feature E5: Session Snapshots & History Browser

### 5.1 Contexto

Claude Code tiene un sistema de session snapshots que permite navegar el historial
de sesiones pasadas, buscar en transcripts, y reanudar cualquier sesion.

KCode tiene `/resume` y session narratives, pero no tiene:
- Browser interactivo de sesiones pasadas
- Busqueda full-text en transcripts de sesiones
- Export de sesiones en formatos multiples

### 5.2 Archivos Nuevos

```
src/
  core/
    session/
      browser.ts                   (~300 lineas) - Browser interactivo de sesiones
      browser.test.ts              (~200 lineas) - Tests
      search.ts                    (~200 lineas) - Busqueda FTS5 en transcripts
      search.test.ts               (~150 lineas) - Tests
      exporter.ts                  (~250 lineas) - Export multi-formato
      exporter.test.ts             (~200 lineas) - Tests
  ui/
    components/
      session-browser.tsx          (~200 lineas) - UI del browser
```

**Archivos Existentes a Modificar:**
- `src/core/conversation.ts` — Guardar transcript completo en SQLite
- `src/cli/` — Agregar subcomando `kcode sessions`
- `src/core/system-prompt.ts` — Agregar instrucciones de /sessions

### 5.3 Diseño

```typescript
// src/core/session/search.ts

interface SessionSearchResult {
  sessionId: string;
  timestamp: number;
  matchSnippet: string;          // Fragmento con highlight
  turnIndex: number;
  role: 'user' | 'assistant';
  score: number;                 // Relevancia FTS5
}

class SessionSearch {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initFTS();
  }

  private initFTS(): void {
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts USING fts5(
      session_id,
      turn_index,
      role,
      content,
      timestamp UNINDEXED,
      tokenize='porter unicode61'
    )`);
  }

  /** Indexar un turno de conversacion */
  indexTurn(sessionId: string, turnIndex: number, role: string, content: string): void {
    this.db.run(
      `INSERT INTO session_transcripts (session_id, turn_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, turnIndex, role, content, Date.now()]
    );
  }

  /** Buscar en todas las sesiones */
  search(query: string, limit = 20): SessionSearchResult[] {
    const rows = this.db.query(`
      SELECT session_id, turn_index, role, snippet(session_transcripts, 3, '<b>', '</b>', '...', 50) as snippet,
             rank as score, timestamp
      FROM session_transcripts
      WHERE content MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as any[];

    return rows.map(r => ({
      sessionId: r.session_id,
      timestamp: r.timestamp,
      matchSnippet: r.snippet,
      turnIndex: r.turn_index,
      role: r.role,
      score: r.score,
    }));
  }
}

export { SessionSearch, type SessionSearchResult };
```

```typescript
// src/core/session/exporter.ts

type ExportFormat = 'markdown' | 'json' | 'html' | 'txt';

interface ExportOptions {
  sessionId: string;
  format: ExportFormat;
  includeToolCalls: boolean;
  includeTimestamps: boolean;
  outputPath?: string;   // Si no se da, stdout
}

async function exportSession(options: ExportOptions): Promise<string> {
  // Cargar sesion completa de SQLite
  // Formatear segun formato solicitado
  // Escribir a archivo o retornar string
  throw new Error('Not implemented');
}

export { exportSession, type ExportOptions, type ExportFormat };
```

### 5.4 Criterios de Aceptacion

- [ ] `kcode sessions` muestra lista de sesiones pasadas con fecha y resumen
- [ ] `kcode sessions search "deploy fix"` busca en transcripts
- [ ] `kcode sessions export <id> --format markdown` exporta sesion
- [ ] `/sessions` disponible como slash command interactivo
- [ ] Browser UI con scroll, filtros por fecha, y preview
- [ ] Transcripts indexados automaticamente en FTS5
- [ ] Formatos de export: markdown, json, html, txt

---

## Feature E6: Advanced Permission Policies

### 6.1 Contexto

Claude Code tiene un sistema de permisos mas granular que KCode en algunos aspectos:
- Permisos por herramienta individual (no solo bash)
- Permisos temporales ("permitir por esta sesion")
- Audit log de todas las acciones con permisos
- Permisos heredados de MDM

KCode tiene 5 modos de permiso y bash safety analysis, pero le falta granularidad.

### 6.2 Archivos Nuevos

```
src/
  core/
    permissions/
      audit-log.ts                 (~200 lineas) - Log de todas las acciones
      audit-log.test.ts            (~180 lineas) - Tests
      temporary-grants.ts          (~150 lineas) - Permisos temporales
      temporary-grants.test.ts     (~120 lineas) - Tests
      per-tool-policy.ts           (~250 lineas) - Politicas por herramienta
      per-tool-policy.test.ts      (~200 lineas) - Tests
```

**Archivos Existentes a Modificar:**
- `src/core/permissions.ts` — Integrar per-tool policies y temporary grants
- `src/core/config.ts` — Agregar settings de audit log
- `src/enterprise/mdm.ts` — Herencia de permisos desde MDM

### 6.3 Diseño

```typescript
// src/core/permissions/per-tool-policy.ts

interface ToolPolicy {
  /** Nombre del tool */
  toolName: string;
  /** Accion por defecto */
  defaultAction: 'ask' | 'allow' | 'deny';
  /** Reglas condicionales */
  rules: ToolPolicyRule[];
}

interface ToolPolicyRule {
  /** Condicion (glob pattern sobre los argumentos del tool) */
  condition: {
    /** Pattern sobre un campo especifico del input */
    field: string;
    pattern: string;       // Glob pattern
    operator: 'matches' | 'not_matches' | 'contains' | 'starts_with';
  };
  /** Accion si la condicion se cumple */
  action: 'allow' | 'deny' | 'ask';
  /** Razon (se muestra al usuario si se deniega) */
  reason?: string;
}

// Ejemplo de config:
// {
//   "toolPolicies": [
//     {
//       "toolName": "Bash",
//       "defaultAction": "ask",
//       "rules": [
//         { "condition": { "field": "command", "pattern": "rm -rf *", "operator": "matches" }, "action": "deny", "reason": "Comando destructivo bloqueado" },
//         { "condition": { "field": "command", "pattern": "git status", "operator": "matches" }, "action": "allow" },
//         { "condition": { "field": "command", "pattern": "bun test*", "operator": "matches" }, "action": "allow" }
//       ]
//     },
//     {
//       "toolName": "FileWrite",
//       "defaultAction": "ask",
//       "rules": [
//         { "condition": { "field": "file_path", "pattern": "*.env*", "operator": "matches" }, "action": "deny", "reason": "No se permite escribir archivos .env" }
//       ]
//     }
//   ]
// }

function evaluateToolPolicy(
  toolName: string,
  input: Record<string, unknown>,
  policies: ToolPolicy[],
): 'allow' | 'deny' | 'ask' {
  const policy = policies.find(p => p.toolName === toolName);
  if (!policy) return 'ask'; // Default si no hay policy

  for (const rule of policy.rules) {
    const fieldValue = String(input[rule.condition.field] ?? '');
    if (matchesCondition(fieldValue, rule.condition)) {
      return rule.action;
    }
  }

  return policy.defaultAction;
}

function matchesCondition(value: string, condition: ToolPolicyRule['condition']): boolean {
  switch (condition.operator) {
    case 'matches': return globMatch(value, condition.pattern);
    case 'not_matches': return !globMatch(value, condition.pattern);
    case 'contains': return value.includes(condition.pattern);
    case 'starts_with': return value.startsWith(condition.pattern);
  }
}

function globMatch(value: string, pattern: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(value);
}

export { evaluateToolPolicy, type ToolPolicy, type ToolPolicyRule };
```

```typescript
// src/core/permissions/audit-log.ts

interface AuditEntry {
  timestamp: number;
  toolName: string;
  action: 'allowed' | 'denied' | 'asked' | 'user_approved' | 'user_denied';
  input: Record<string, unknown>;
  reason?: string;
  sessionId: string;
}

class AuditLog {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.run(`CREATE TABLE IF NOT EXISTS permission_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      action TEXT NOT NULL,
      input_json TEXT,
      reason TEXT,
      session_id TEXT
    )`);
  }

  log(entry: AuditEntry): void {
    this.db.run(
      `INSERT INTO permission_audit (timestamp, tool_name, action, input_json, reason, session_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.timestamp, entry.toolName, entry.action, JSON.stringify(entry.input), entry.reason ?? null, entry.sessionId]
    );
  }

  /** Obtener historial de un tool */
  getHistory(toolName: string, limit = 50): AuditEntry[] {
    return this.db.query(
      `SELECT * FROM permission_audit WHERE tool_name = ? ORDER BY timestamp DESC LIMIT ?`
    ).all(toolName, limit) as AuditEntry[];
  }

  /** Obtener resumen de permisos (para /permissions report) */
  getSummary(): { toolName: string; allowed: number; denied: number; asked: number }[] {
    return this.db.query(`
      SELECT tool_name as toolName,
        SUM(CASE WHEN action IN ('allowed', 'user_approved') THEN 1 ELSE 0 END) as allowed,
        SUM(CASE WHEN action IN ('denied', 'user_denied') THEN 1 ELSE 0 END) as denied,
        SUM(CASE WHEN action = 'asked' THEN 1 ELSE 0 END) as asked
      FROM permission_audit
      GROUP BY tool_name
      ORDER BY (allowed + denied + asked) DESC
    `).all() as any[];
  }
}

export { AuditLog, type AuditEntry };
```

### 6.4 Criterios de Aceptacion

- [ ] Politicas por tool configurables en settings.json
- [ ] Permisos temporales: "permitir X por esta sesion" (no persiste)
- [ ] Audit log de todas las decisiones de permisos
- [ ] `kcode permissions report` muestra resumen de audit
- [ ] MDM puede forzar policies (override de user settings)
- [ ] Reglas con glob patterns sobre campos del input
- [ ] Tests cubren: allow, deny, ask, temporary, audit
