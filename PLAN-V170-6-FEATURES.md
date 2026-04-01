# Plan de Implementacion: 6 Features para KCode v1.7.0

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~8,000-10,000 LoC nuevas
**Base:** Ingenieria inversa conceptual de Claude Code, rediseñado para la arquitectura KCode (Bun + SQLite + React/Ink)

> IMPORTANTE: Este documento NO copia codigo. Se reimplementan conceptos adaptados
> al stack existente de KCode. Cada feature incluye: contexto, archivos, diseño,
> interfaces, flujo, tests y criterios de aceptacion.

---

## INDICE

1. [Feature 1: Auto-Memory con Forked Agent Pattern](#feature-1-auto-memory-con-forked-agent-pattern)
2. [Feature 2: Compactacion Multi-Estrategia](#feature-2-compactacion-multi-estrategia)
3. [Feature 3: Plugin Marketplace con CDN](#feature-3-plugin-marketplace-con-cdn)
4. [Feature 4: Sistema de Migraciones Formal](#feature-4-sistema-de-migraciones-formal)
5. [Feature 5: Keybindings Avanzados con Chords](#feature-5-keybindings-avanzados-con-chords)
6. [Feature 6: Coordinator Mode con Scratchpad](#feature-6-coordinator-mode-con-scratchpad)

---

## Feature 1: Auto-Memory con Forked Agent Pattern

### 1.1 Contexto

KCode ya tiene un sistema de memoria maduro (`src/core/memory.ts` y `memory-store.ts`)
con tipos (user, feedback, project, reference), MEMORY.md como indice, y SQLite-backed
store con FTS5. Sin embargo, la captura de memorias es **100% manual**: el usuario
debe invocar explicitamente `/remember` o el modelo debe decidir guardar.

Claude Code resuelve esto con un **Forked Agent Pattern**: al final de cada turno,
fork invisible del contexto de conversacion que:
1. Analiza el turno actual
2. Decide si hay algo memorable (correcciones, preferencias, decisiones)
3. Extrae y guarda automaticamente sin interrumpir al usuario

Este patron es reutilizable para otras tareas background (sugerencias, clasificacion,
narrativa de sesion).

### 1.2 Archivos Nuevos a Crear

```
src/
  core/
    forked-agent.ts              (~250 lineas) - Infraestructura generica de fork
    forked-agent.test.ts         (~200 lineas) - Tests
    auto-memory/
      extractor.ts               (~350 lineas) - Logica de extraccion de memorias
      extractor.test.ts          (~300 lineas) - Tests
      relevance-filter.ts        (~200 lineas) - Filtro de relevancia con LLM
      relevance-filter.test.ts   (~150 lineas) - Tests
      types.ts                   (~60 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/conversation.ts` - Agregar hook post-turno para auto-memory
- `src/core/memory.ts` - Exponer API para escritura programatica desde extractor
- `src/core/memory-store.ts` - Agregar source='auto-extract' para memorias automaticas
- `src/core/config.ts` - Agregar settings de auto-memory
- `src/core/system-prompt.ts` - Agregar instrucciones de auto-memory al Layer 1

### 1.3 Forked Agent Pattern (Infraestructura Base)

#### 1.3.1 Concepto

Un "forked agent" es una ejecucion lightweight del modelo que:
- Recibe un snapshot del contexto actual (mensajes recientes, no todo el historial)
- Ejecuta un prompt especifico (ej: "extrae memorias de este turno")
- Corre en background sin bloquear la UI del usuario
- No tiene acceso a tools (solo analisis de texto)
- Usa un modelo mas barato/rapido si es posible (mnemo:mark5 o haiku)

#### 1.3.2 Diseño de la API

```typescript
// src/core/forked-agent.ts

interface ForkedAgentConfig {
  /** Nombre para logging/telemetria */
  name: string;
  /** Prompt del sistema para el fork */
  systemPrompt: string;
  /** Mensajes de contexto (subset del historial) */
  contextMessages: Message[];
  /** Prompt del usuario (la tarea especifica) */
  userPrompt: string;
  /** Modelo a usar (default: modelo terciario/barato) */
  model?: string;
  /** Timeout en ms (default: 30000) */
  timeoutMs?: number;
  /** Max tokens de respuesta (default: 2000) */
  maxTokens?: number;
  /** Callback al completar */
  onComplete: (result: string) => Promise<void>;
  /** Callback en error (silencioso por defecto) */
  onError?: (error: Error) => void;
}

interface ForkedAgentResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

#### 1.3.3 Flujo de Ejecucion

```
Turno del usuario completa (modelo responde sin tool_calls)
    |
    v
[1] conversation.ts detecta fin de turno (stop_reason === 'end_turn')
    |
    v
[2] Verifica config: autoMemory.enabled === true
    |
    v
[3] Prepara snapshot:
    - Ultimos 6 mensajes (3 pares user/assistant)
    - System prompt reducido (solo Layer 1: identidad)
    - No incluir tool results largos (truncar a 500 chars)
    |
    v
[4] Spawn forkedAgent({
      name: 'auto-memory-extractor',
      systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
      contextMessages: snapshot,
      userPrompt: EXTRACTOR_USER_PROMPT,
      model: config.autoMemory.model || tertiaryModel,
      timeoutMs: 15000,
      maxTokens: 1500,
      onComplete: handleExtractedMemories,
      onError: (e) => log.debug('auto-memory failed silently', e)
    })
    |
    v
[5] Fork ejecuta request HTTP al proveedor (NO subprocess, solo API call)
    |
    v
[6] onComplete parsea la respuesta JSON y guarda memorias
```

#### 1.3.4 Implementacion del Fork

**IMPORTANTE:** A diferencia de Claude Code que puede usar prompt cache compartido
(porque controlan el backend), KCode debe ser eficiente de otra manera:

- **NO** spawner un subprocess (demasiado overhead para ~101MB binario)
- **SI** hacer una API call directa usando el mismo HTTP client de `conversation.ts`
- Usar `executeModelRequest()` existente con un request minimo
- Timeout agresivo (15s) para no retrasar la sesion
- Si el modelo terciario falla, skip silencioso (no retry)

```typescript
// Pseudocodigo del fork
async function runForkedAgent(config: ForkedAgentConfig): Promise<void> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), config.timeoutMs);

  try {
    const messages = [
      { role: 'system', content: config.systemPrompt },
      ...config.contextMessages.map(simplifyMessage),
      { role: 'user', content: config.userPrompt }
    ];

    const result = await executeModelRequest({
      model: config.model || getConfiguredModel('tertiary'),
      messages,
      maxTokens: config.maxTokens,
      signal: abortController.signal,
      // Sin tools, sin streaming (rapido)
      tools: [],
      stream: false,
    });

    await config.onComplete(result.content);
  } catch (error) {
    config.onError?.(error as Error);
  } finally {
    clearTimeout(timer);
  }
}
```

### 1.4 Auto-Memory Extractor

#### 1.4.1 Prompt del Extractor

El extractor recibe el contexto reciente y debe decidir si hay memorias valiosas.
Responde en JSON estructurado:

```typescript
// src/core/auto-memory/types.ts

interface ExtractedMemory {
  /** Tipo de memoria: user | feedback | project | reference */
  type: 'user' | 'feedback' | 'project' | 'reference';
  /** Titulo corto (max 80 chars) */
  title: string;
  /** Descripcion de una linea (para MEMORY.md index) */
  description: string;
  /** Contenido completo de la memoria */
  content: string;
  /** Confianza 0-1 (solo guardar si >= 0.7) */
  confidence: number;
}

interface ExtractionResult {
  /** Lista de memorias extraidas (puede ser vacia) */
  memories: ExtractedMemory[];
  /** Razonamiento breve del extractor */
  reasoning: string;
}
```

#### 1.4.2 System Prompt del Extractor

```
Eres un extractor de memorias. Analizas conversaciones y decides si hay
informacion que vale la pena recordar para futuras conversaciones.

TIPOS DE MEMORIA:
- user: Rol, preferencias, conocimiento del usuario
- feedback: Correcciones o validaciones del enfoque ("no hagas X", "si, asi esta bien")
- project: Decisiones, plazos, estados de trabajo en curso
- reference: Punteros a sistemas externos (URLs, nombres de proyectos, canales)

REGLAS:
1. Solo extrae lo que NO se puede derivar del codigo o git
2. No guardes patrones de codigo, convenciones de archivos, ni estructura de proyecto
3. Convierte fechas relativas a absolutas (ej: "el jueves" -> "2026-04-02")
4. Para feedback, incluye el POR QUE (razon que dio el usuario)
5. Confianza >= 0.7 para guardar. Si dudas, no extraigas.
6. Maximo 3 memorias por turno (evitar spam)
7. Responde SIEMPRE en JSON valido

Si no hay nada memorable, responde: {"memories": [], "reasoning": "Nada memorable"}
```

#### 1.4.3 User Prompt del Extractor

```
Analiza esta conversacion reciente y extrae memorias si las hay.
Fecha actual: {currentDate}

CONVERSACION:
{contextMessages formateados como texto plano}

MEMORIAS EXISTENTES (para evitar duplicados):
{lista de titulos de memorias actuales}

Responde en JSON:
```

#### 1.4.4 Flujo de Guardado

```
ExtractionResult recibido
    |
    v
[1] Filtrar memorias con confidence < 0.7
    |
    v
[2] Para cada memoria restante:
    |
    +-> [2a] Verificar que no es duplicada:
    |     - Comparar titulo con memorias existentes (fuzzy match, umbral 0.85)
    |     - Si duplicada, verificar si el contenido es mas reciente/completo
    |     - Si es actualizacion, EDITAR archivo existente en vez de crear nuevo
    |
    +-> [2b] Generar nombre de archivo:
    |     - Formato: {type}_{slug_del_titulo}.md
    |     - Ejemplo: feedback_no_mocks_en_tests.md
    |
    +-> [2c] Escribir archivo con frontmatter YAML:
    |     ---
    |     name: {title}
    |     description: {description}
    |     type: {type}
    |     auto_extracted: true
    |     date: {ISO date}
    |     confidence: {0-1}
    |     ---
    |     {content}
    |
    +-> [2d] Actualizar MEMORY.md:
    |     - Leer archivo actual
    |     - Agregar linea: "- [{title}]({filename}) -- {description}"
    |     - Verificar limite de 200 lineas
    |     - Si excede, eliminar entrada mas antigua de tipo auto_extracted
    |
    +-> [2e] Registrar en SQLite (memory_store):
          INSERT INTO memories (category, content, source, confidence)
          VALUES ('{type}', '{content}', 'auto-extract', {confidence})
```

### 1.5 Configuracion

Agregar a `~/.kcode/settings.json`:

```json
{
  "autoMemory": {
    "enabled": true,
    "model": null,
    "minConfidence": 0.7,
    "maxPerTurn": 3,
    "cooldownTurns": 3,
    "excludeTypes": []
  }
}
```

- `enabled`: Activar/desactivar (default: true)
- `model`: Modelo especifico para extraction (default: null = usa tertiaryModel)
- `minConfidence`: Umbral minimo de confianza (default: 0.7)
- `maxPerTurn`: Maximo de memorias por turno (default: 3)
- `cooldownTurns`: Saltar N turnos entre extracciones para no saturar (default: 3)
- `excludeTypes`: Tipos a excluir (ej: ["project"] si no quieren project memories)

### 1.6 Integracion en conversation.ts

Punto de insercion: Despues de que el modelo responde sin tool_calls (fin de turno).

```typescript
// En el loop principal de conversation.ts, despues de procesar la respuesta:

if (response.stopReason === 'end_turn' && !hasToolCalls(response)) {
  // Turno completado - trigger auto-memory en background
  this.turnsSinceLastExtraction++;

  if (
    config.autoMemory?.enabled !== false &&
    this.turnsSinceLastExtraction >= (config.autoMemory?.cooldownTurns ?? 3)
  ) {
    this.turnsSinceLastExtraction = 0;

    // Fire-and-forget: no await, no bloquea UI
    runAutoMemoryExtraction({
      recentMessages: this.messages.slice(-6),
      existingMemories: await getMemoryTitles(),
      config: config.autoMemory,
    }).catch(err => log.debug('auto-memory:', err.message));
  }
}
```

### 1.7 Tests Requeridos

1. **forked-agent.test.ts:**
   - Fork ejecuta correctamente con modelo mock
   - Timeout cancela la ejecucion
   - Error en onComplete no propaga
   - Mensajes se simplifican correctamente (tool results truncados)

2. **extractor.test.ts:**
   - Extrae memoria tipo `user` cuando el usuario dice su rol
   - Extrae memoria tipo `feedback` cuando el usuario corrige
   - NO extrae cuando no hay nada memorable
   - Respeta minConfidence
   - Respeta maxPerTurn
   - Detecta duplicados y actualiza en vez de crear
   - Convierte fechas relativas a absolutas

3. **relevance-filter.test.ts:**
   - Filtra memorias ya existentes
   - Fuzzy match funciona con umbrales
   - Maneja MEMORY.md vacio

4. **Integracion:**
   - cooldownTurns se respeta
   - autoMemory.enabled=false desactiva completamente
   - No bloquea la UI (fire-and-forget verificado con timing)

### 1.8 Criterios de Aceptacion

- [ ] Auto-memory extrae al menos 1 memoria en una conversacion de 10 turnos donde el usuario menciona su rol
- [ ] Las memorias auto-extraidas tienen `auto_extracted: true` en frontmatter
- [ ] El cooldown de 3 turnos se respeta (no spam)
- [ ] Si el modelo terciario no esta disponible, falla silenciosamente
- [ ] El tiempo de extraccion no excede 15 segundos
- [ ] Las memorias duplicadas se actualizan, no se duplican
- [ ] MEMORY.md no excede 200 lineas
- [ ] El forked-agent pattern es reutilizable para otros usos futuros

---

## Feature 2: Compactacion Multi-Estrategia

### 2.1 Contexto

KCode tiene compactacion en 3 fases:
1. Comprimir tool results largos (>500 chars) en mensajes viejos
2. LLM-based summarization de N mensajes antiguos
3. Emergency pruning (drop 30% de mensajes si >95% contexto)

Claude Code tiene un sistema mucho mas sofisticado con **4 estrategias** especializadas,
**image stripping** pre-compactacion, **post-compact file restoration**, y **circuit breakers**
con contadores de intentos.

### 2.2 Archivos Nuevos a Crear

```
src/
  core/
    compaction/
      index.ts                    (~80 lineas)  - Re-exports y orquestador
      strategies/
        full-compact.ts           (~300 lineas) - Compactacion completa con LLM
        micro-compact.ts          (~200 lineas) - Resumen JSON por turno individual
        session-memory-compact.ts (~150 lineas) - Compactacion de session memories
        image-stripper.ts         (~100 lineas) - Pre-procesador de imagenes
        file-restorer.ts          (~200 lineas) - Post-compact file restoration
      circuit-breaker.ts          (~120 lineas) - Control de fallos consecutivos
      types.ts                    (~80 lineas)  - Interfaces compartidas
      compaction.test.ts          (~400 lineas) - Tests del orquestador
      strategies.test.ts          (~500 lineas) - Tests de cada estrategia
```

**Archivos Existentes a Modificar:**
- `src/core/compaction.ts` - Refactorizar a usar el nuevo orquestador (o deprecar)
- `src/core/context-manager.ts` - Integrar nuevas estrategias
- `src/core/config.ts` - Agregar settings de compactacion avanzada

### 2.3 Estrategias de Compactacion

#### 2.3.1 Estrategia: Image Stripper (Pre-procesador)

**Cuando:** Antes de cualquier otra estrategia de compactacion.
**Que hace:** Reemplaza bloques de imagen/documento en mensajes con marcadores de texto.
**Por que:** Las imagenes consumen muchos tokens y no se pueden resumir por LLM.

```typescript
interface ImageStripResult {
  messages: Message[];        // Mensajes con imagenes reemplazadas
  strippedCount: number;      // Cuantas imagenes se removieron
  tokensRecovered: number;    // Tokens estimados liberados
}

function stripImages(messages: Message[]): ImageStripResult {
  // Para cada mensaje:
  //   - Buscar content blocks de tipo 'image' o 'document'
  //   - Reemplazar con: { type: 'text', text: '[imagen removida por compactacion]' }
  //   - Preservar el texto que acompañaba la imagen
  //   - NO tocar los ultimos 4 mensajes (pueden ser relevantes)
}
```

**Reglas:**
- Solo strippear mensajes con indice < (total - 4)
- Preservar alt-text si existe
- Contar tokens estimados recuperados (1 imagen ≈ 1000-2000 tokens)

#### 2.3.2 Estrategia: Micro-Compact

**Cuando:** Context usage entre 60%-75% (antes de necesitar full compact).
**Que hace:** Resumen JSON de turnos individuales sin usar LLM.
**Por que:** Es instantaneo, no cuesta tokens, y libera espacio significativo.

```typescript
interface MicroCompactConfig {
  /** Mensajes a preservar intactos al final */
  preserveRecent: number;      // default: 10
  /** Umbral de longitud para comprimir un tool result */
  toolResultThreshold: number; // default: 300 chars
  /** Umbral de longitud para comprimir un assistant message */
  assistantThreshold: number;  // default: 500 chars
}
```

**Algoritmo:**
```
Para cada par de mensajes (user + assistant) fuera de los 10 recientes:
  |
  +-> Si assistant tiene tool_use + tool_result:
  |     Reemplazar con resumen JSON:
  |     { "summary": "Ejecuto {tool} en {target}", "result": "exito|error", "output_preview": "primeras 100 chars" }
  |
  +-> Si assistant es texto largo (>500 chars):
  |     Truncar a primeras 200 chars + "... [compactado, {N} chars originales]"
  |
  +-> Si user es texto largo (>300 chars):
        Truncar a primeras 150 chars + "... [compactado]"
```

**Ventajas sobre la Fase 1 actual de KCode:**
- Tambien comprime mensajes de texto, no solo tool results
- Genera resumenes JSON estructurados (mas utiles para el modelo)
- Preserva metadata sobre que se hizo (tool name, target)

#### 2.3.3 Estrategia: Full Compact (LLM-based)

**Cuando:** Context usage entre 75%-90%.
**Que hace:** Envia mensajes antiguos al LLM para generar un resumen narrativo.
**Por que:** Maxima compresion con retencion de informacion semantica.

Esto ya existe parcialmente en `compaction.ts`. La mejora es:

```typescript
interface FullCompactConfig {
  /** Modelo a usar (default: tertiaryModel o mnemo:mark5) */
  model: string;
  /** Max tokens para el resumen */
  maxSummaryTokens: number;  // default: 2000
  /** Mensajes a agrupar por "ronda API" */
  groupByRounds: boolean;    // default: true
  /** Budget de tokens para restauracion de archivos post-compact */
  fileRestoreBudget: number; // default: 50000
}
```

**Mejoras sobre la implementacion actual:**

1. **Agrupacion por rondas API:** En vez de mandar todos los mensajes raw,
   agruparlos logicamente: "Ronda 1: usuario pidio X, asistente hizo Y con tool Z"

2. **Post-compact file restoration:** Despues de compactar, restaurar los archivos
   mas recientes que el modelo habia leido, para que no pierda contexto de archivos:

```
Post-compact restoration:
  |
  [1] Escanear mensajes compactados buscando Read/Glob/Grep calls
  |
  [2] Extraer paths de archivos leidos
  |
  [3] De los archivos, seleccionar los 5 mas recientes
  |
  [4] Re-leer cada archivo (max 5KB por archivo)
  |
  [5] Inyectar como mensajes de contexto despues del resumen:
      { role: 'user', content: '[Contexto restaurado] Contenido actual de {path}:' }
      { role: 'assistant', content: 'Entendido, tengo el contexto actualizado.' }
  |
  [6] Budget total: 50K tokens (5 archivos x 5K + 25K para skills)
```

3. **Prompt mejorado para el resumidor:**

```
Resume esta conversacion preservando:
- Decisiones tomadas y su razon
- Archivos creados o modificados (paths exactos)
- Errores encontrados y como se resolvieron
- Estado actual del trabajo (que falta por hacer)
- Preferencias del usuario expresadas

NO incluyas:
- Contenido literal de archivos (se restaurara por separado)
- Outputs completos de herramientas
- Detalles de implementacion que estan en el codigo

Formato: Narrativa concisa en primera persona, max 2000 tokens.
```

#### 2.3.4 Estrategia: Session Memory Compact

**Cuando:** Al hacer `/resume` de una sesion anterior.
**Que hace:** Genera un micro-resumen de la sesion anterior optimizado para continuacion.
**Por que:** Cuando se resume una sesion, no necesitas TODO el historial, solo el estado.

```typescript
interface SessionMemoryCompactResult {
  summary: string;           // Resumen de la sesion anterior
  filesModified: string[];   // Archivos tocados
  pendingTasks: string[];    // Lo que quedaba por hacer
  userPreferences: string[]; // Preferencias expresadas durante la sesion
}
```

**Flujo:**
```
Usuario ejecuta `kcode -c` (continue/resume)
    |
    v
[1] Cargar transcript JSONL de la sesion anterior
    |
    v
[2] Si transcript > 50 mensajes:
    |   Ejecutar session-memory-compact con LLM
    |   Generar resumen estructurado (max 3000 tokens)
    |
    v
[3] Si transcript <= 50 mensajes:
    |   Cargar completo (comportamiento actual)
    |
    v
[4] Inyectar resumen como primer mensaje de sistema:
    "[Sesion anterior resumida] {summary}"
```

### 2.4 Circuit Breaker

```typescript
// src/core/compaction/circuit-breaker.ts

interface CircuitBreakerState {
  consecutiveFailures: number;  // Fallos seguidos
  maxFailures: number;          // Limite (default: 3)
  isOpen: boolean;              // true = no intentar mas compact LLM
  lastFailure: Date | null;
  resetAfterMs: number;         // Auto-reset despues de N ms (default: 300000 = 5min)
}

class CompactionCircuitBreaker {
  /** Registrar un fallo. Si consecutiveFailures >= max, abre el circuito */
  recordFailure(error: Error): void;

  /** Registrar exito. Resetea contador */
  recordSuccess(): void;

  /** Verificar si se puede intentar compactacion LLM */
  canAttempt(): boolean;
  // true si: isOpen === false
  //          OR (isOpen === true AND han pasado resetAfterMs desde lastFailure)

  /** Resetear manualmente */
  reset(): void;
}
```

**Comportamiento cuando el circuito esta abierto:**
- Full compact y session-memory-compact se saltan
- Se cae directamente a micro-compact + emergency pruning
- Log warning: "Compaction circuit breaker open, using fallback"

### 2.5 Orquestador de Compactacion

```typescript
// src/core/compaction/index.ts

async function compact(
  messages: Message[],
  contextUsage: number,  // 0.0 - 1.0
  config: CompactionConfig
): Promise<CompactionResult> {

  // Fase 0: Image stripping (siempre, si hay imagenes)
  if (hasImages(messages)) {
    messages = stripImages(messages, { preserveRecent: 4 });
  }

  // Fase 1: Micro-compact (60%-75%)
  if (contextUsage >= 0.60) {
    messages = microCompact(messages, config.micro);
  }

  // Fase 2: Full compact con LLM (75%-90%)
  if (contextUsage >= 0.75 && circuitBreaker.canAttempt()) {
    try {
      const result = await fullCompact(messages, config.full);
      messages = result.messages;
      circuitBreaker.recordSuccess();

      // Post-compact: restaurar archivos recientes
      if (config.full.fileRestoreBudget > 0) {
        messages = await restoreRecentFiles(messages, result.compactedMessages, config.full.fileRestoreBudget);
      }
    } catch (error) {
      circuitBreaker.recordFailure(error);
      log.warn('Full compact failed, falling back to pruning');
    }
  }

  // Fase 3: Emergency pruning (>90%)
  if (contextUsage >= 0.90) {
    messages = emergencyPrune(messages, {
      preserveRecent: 10,
      dropRatio: 0.30,
      keepFirstUserMessage: true,
    });
  }

  return { messages, strategy: getStrategyUsed() };
}
```

### 2.6 Configuracion

Agregar a settings:

```json
{
  "compaction": {
    "microCompact": {
      "enabled": true,
      "preserveRecent": 10,
      "toolResultThreshold": 300,
      "assistantThreshold": 500
    },
    "fullCompact": {
      "model": null,
      "maxSummaryTokens": 2000,
      "groupByRounds": true,
      "fileRestoreBudget": 50000,
      "maxFilesToRestore": 5,
      "maxBytesPerFile": 5120
    },
    "sessionMemoryCompact": {
      "enabled": true,
      "thresholdMessages": 50
    },
    "circuitBreaker": {
      "maxFailures": 3,
      "resetAfterMs": 300000
    },
    "imageStripping": {
      "enabled": true,
      "preserveRecent": 4
    }
  }
}
```

### 2.7 Tests Requeridos

1. **Image stripper:**
   - Reemplaza imagenes en mensajes antiguos
   - Preserva imagenes en los ultimos 4 mensajes
   - Cuenta tokens recuperados correctamente

2. **Micro-compact:**
   - Comprime tool results sobre umbral
   - Genera JSON estructurado correcto
   - No toca los 10 mensajes recientes
   - Comprime mensajes de texto largos

3. **Full compact:**
   - Genera resumen coherente (con mock LLM)
   - Restaura archivos post-compact
   - Respeta budget de tokens
   - Falla gracefully si LLM no disponible

4. **Session memory compact:**
   - Genera resumen estructurado de sesion
   - Skip si < 50 mensajes
   - Captura archivos modificados y tareas pendientes

5. **Circuit breaker:**
   - Abre despues de 3 fallos consecutivos
   - Auto-reset despues de 5 minutos
   - Record success resetea contador

6. **Orquestador:**
   - Ejecuta estrategias en orden correcto
   - Escala progresivamente segun usage
   - No rompe si todas las estrategias fallan

### 2.8 Criterios de Aceptacion

- [ ] Micro-compact reduce context usage en al menos 15% en sesiones con muchos tool calls
- [ ] Full compact genera resumenes coherentes que preservan decisiones clave
- [ ] Image stripping libera tokens sin perder contexto textual
- [ ] Post-compact file restoration restaura los 5 archivos mas relevantes
- [ ] Circuit breaker previene loops infinitos de compactacion fallida
- [ ] Session memory compact permite resumir sesiones de 200+ mensajes en <3000 tokens
- [ ] La compactacion antigua (`compaction.ts`) se reemplaza completamente

---

## Feature 3: Plugin Marketplace con CDN

### 3.1 Contexto

KCode ya tiene un plugin system funcional (`plugin-manager.ts`, `marketplace.ts`) con
instalacion desde paths locales o git URLs, un marketplace registry en `plugins.kulvex.ai`,
y plugins bundled (git-hooks, docker, database, etc.).

Claude Code tiene un sistema mas robusto con:
- CDN oficial via GCS (Google Cloud Storage) con descarga atomica
- SHA sentinel files para skip de re-descarga
- Marketplace con verificacion de plugins
- Auto-update al startup configurable por marketplace
- Output style plugins
- Plugin components: skills + hooks + MCP servers + agents + output styles

### 3.2 Archivos Nuevos a Crear

```
src/
  core/
    marketplace/
      cdn-fetcher.ts            (~250 lineas) - Descarga atomica desde CDN
      cdn-fetcher.test.ts       (~200 lineas) - Tests
      sha-tracker.ts            (~100 lineas) - Sentinel SHA para cache
      sha-tracker.test.ts       (~80 lineas)  - Tests
      verifier.ts               (~200 lineas) - Verificacion de integridad
      verifier.test.ts          (~150 lineas) - Tests
      auto-updater.ts           (~200 lineas) - Auto-update en startup
      auto-updater.test.ts      (~150 lineas) - Tests
      output-style-loader.ts    (~150 lineas) - Carga de output styles desde plugins
      output-style-loader.test.ts (~100 lineas) - Tests
      types.ts                  (~80 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/marketplace.ts` - Integrar CDN fetcher como source adicional
- `src/core/plugin-manager.ts` - Agregar soporte para output-style plugins y agent plugins
- `src/core/plugin-registry.ts` - Registrar nuevos tipos de componentes
- `src/core/output-styles.ts` - Cargar styles desde plugins
- `src/core/config.ts` - Settings de marketplace

### 3.3 CDN Fetcher (Descarga Atomica)

#### 3.3.1 Concepto

En vez de `git clone` (lento, requiere git), descargar un tarball/zip desde CDN.
La descarga es **atomica**: download a temp dir, rename al completar.

```typescript
// src/core/marketplace/cdn-fetcher.ts

interface CDNFetcherConfig {
  /** URL base del CDN (default: cdn.kulvex.ai/plugins) */
  cdnBaseUrl: string;
  /** Directorio local de cache */
  cacheDir: string;   // default: ~/.kcode/plugins/marketplace-cache/
  /** Timeout de descarga en ms */
  timeoutMs: number;  // default: 30000
}

interface FetchResult {
  pluginDir: string;    // Path al plugin descargado
  version: string;      // Version descargada
  sha256: string;       // Hash del contenido
  fromCache: boolean;   // Si se uso cache
}
```

#### 3.3.2 Flujo de Descarga Atomica

```
fetchPlugin(pluginName, version?)
    |
    v
[1] Verificar SHA sentinel: ~/.kcode/plugins/marketplace-cache/{name}/.sha256
    |
    +-> Si existe y version === current: return { fromCache: true }
    |
    v
[2] Download tarball:
    GET {cdnBaseUrl}/{name}/{version || 'latest'}.tar.gz
    -> Guardar en {cacheDir}/{name}/.download-tmp/
    |
    v
[3] Verificar integridad:
    - Calcular SHA256 del tarball
    - Comparar con header X-Content-SHA256 del response
    - Si no coincide: eliminar tmp, throw IntegrityError
    |
    v
[4] Extraer tarball en directorio temporal:
    {cacheDir}/{name}/.extract-tmp/
    |
    v
[5] Validar manifest:
    - Verificar que plugin.json existe
    - Parsear y validar contra PluginManifestSchema
    - Verificar que name en manifest === pluginName
    |
    v
[6] Atomic swap:
    - Si existe {cacheDir}/{name}/current/ -> rename a {name}/.prev/
    - Rename {name}/.extract-tmp/ -> {name}/current/
    - Escribir SHA sentinel: {name}/.sha256
    - Eliminar {name}/.prev/ y {name}/.download-tmp/
    |
    v
[7] Return { pluginDir: '{cacheDir}/{name}/current/', fromCache: false }
```

**Manejo de errores:**
- Si falla en paso 2-4: limpiar tmp, usar `.prev/` si existe (graceful fallback)
- Si falla en paso 5: limpiar, no instalar, log error
- Si falla en paso 6 (rename): mantener estado anterior, log warning

#### 3.3.3 SHA Sentinel

```typescript
// src/core/marketplace/sha-tracker.ts

class SHATracker {
  /** Leer SHA guardado para un plugin */
  getStoredSHA(pluginName: string): string | null;

  /** Guardar SHA despues de descarga exitosa */
  setSHA(pluginName: string, sha256: string): void;

  /** Verificar si el plugin necesita actualizacion */
  needsUpdate(pluginName: string, remoteSHA: string): boolean;

  /** Invalidar cache (forzar re-descarga) */
  invalidate(pluginName: string): void;
}

// Formato del archivo sentinel: ~/.kcode/plugins/marketplace-cache/{name}/.sha256
// Contenido: {sha256hash}\n{version}\n{timestamp}
```

### 3.4 Verificacion de Plugins

```typescript
// src/core/marketplace/verifier.ts

interface VerificationResult {
  valid: boolean;
  issues: VerificationIssue[];
}

interface VerificationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

function verifyPlugin(pluginDir: string): VerificationResult {
  const issues: VerificationIssue[] = [];

  // 1. Manifest valido
  if (!existsSync(join(pluginDir, 'plugin.json'))) {
    issues.push({ severity: 'error', code: 'NO_MANIFEST', message: 'Missing plugin.json' });
  }

  // 2. Skills son .md validos con frontmatter
  for (const skill of manifest.skills || []) {
    const skillPath = join(pluginDir, skill);
    if (!existsSync(skillPath)) {
      issues.push({ severity: 'error', code: 'MISSING_SKILL', message: `Skill file not found: ${skill}` });
    }
    // Verificar que el frontmatter tiene name y description
  }

  // 3. Hooks referencian comandos existentes
  for (const [event, hooks] of Object.entries(manifest.hooks || {})) {
    // Validar que el evento es un hook event conocido
    // Validar que el comando/script existe
  }

  // 4. MCP servers tienen configuracion valida
  for (const [name, config] of Object.entries(manifest.mcpServers || {})) {
    if (!config.command) {
      issues.push({ severity: 'error', code: 'MCP_NO_CMD', message: `MCP server ${name} missing command` });
    }
  }

  // 5. Path traversal check
  // Verificar que ningun archivo referenciado sale del pluginDir

  // 6. Tamaño razonable (warn si > 10MB)
  const totalSize = calculateDirSize(pluginDir);
  if (totalSize > 10_000_000) {
    issues.push({ severity: 'warning', code: 'LARGE_PLUGIN', message: `Plugin is ${formatBytes(totalSize)}` });
  }

  return { valid: issues.filter(i => i.severity === 'error').length === 0, issues };
}
```

### 3.5 Auto-Update en Startup

```typescript
// src/core/marketplace/auto-updater.ts

interface AutoUpdateConfig {
  /** Activar auto-update (default: true) */
  enabled: boolean;
  /** Intervalo minimo entre checks en ms (default: 86400000 = 24h) */
  checkIntervalMs: number;
  /** Marketplaces a verificar */
  marketplaces: string[];
}

async function autoUpdatePlugins(config: AutoUpdateConfig): Promise<UpdateReport> {
  // [1] Verificar si ha pasado suficiente tiempo desde ultimo check
  const lastCheck = readLastCheckTimestamp();
  if (Date.now() - lastCheck < config.checkIntervalMs) return { skipped: true };

  // [2] Para cada marketplace configurado:
  for (const marketplace of config.marketplaces) {
    // [2a] Fetch manifest del marketplace (lista de plugins con versiones)
    const catalog = await fetchCatalog(marketplace);

    // [2b] Para cada plugin instalado de este marketplace:
    for (const installed of getInstalledPlugins(marketplace)) {
      const remote = catalog.find(p => p.name === installed.name);
      if (!remote) continue;

      // [2c] Comparar version (semver)
      if (semver.gt(remote.version, installed.version)) {
        // [2d] Descargar nueva version via CDN fetcher
        await cdnFetcher.fetchPlugin(installed.name, remote.version);
        report.updated.push({ name: installed.name, from: installed.version, to: remote.version });
      }
    }
  }

  // [3] Guardar timestamp
  writeLastCheckTimestamp(Date.now());

  return report;
}
```

### 3.6 Output Style Plugins

Permitir que plugins incluyan output styles personalizados.

```typescript
// src/core/marketplace/output-style-loader.ts

interface PluginOutputStyle {
  name: string;          // Nombre del estilo
  description: string;   // Descripcion para el usuario
  instructions: string;  // Instrucciones para el system prompt
  priority: number;      // Orden de aplicacion (default: 100)
}

function loadPluginOutputStyles(): PluginOutputStyle[] {
  const styles: PluginOutputStyle[] = [];

  for (const plugin of getEnabledPlugins()) {
    const stylesDir = join(plugin.dir, 'output-styles');
    if (!existsSync(stylesDir)) continue;

    for (const file of readdirSync(stylesDir).filter(f => f.endsWith('.md'))) {
      const { frontmatter, content } = parseFrontmatter(readFileSync(join(stylesDir, file), 'utf-8'));
      styles.push({
        name: `${plugin.name}:${frontmatter.name || basename(file, '.md')}`,
        description: frontmatter.description || '',
        instructions: content,
        priority: frontmatter.priority || 100,
      });
    }
  }

  return styles.sort((a, b) => a.priority - b.priority);
}
```

**Integracion con output-styles.ts existente:**
- Los styles de plugins se agregan al final de la lista de styles disponibles
- Se seleccionan igual que los built-in: por nombre en config o CLI flag
- Namespace con prefijo del plugin: `my-plugin:concise-code`

### 3.7 Plugin Manifest Extendido

Agregar campos al plugin.json existente:

```json
{
  "name": "my-plugin",
  "version": "1.2.0",
  "description": "Plugin de ejemplo",
  "author": "Developer Name",
  "license": "MIT",
  "kcode": ">=1.6.0",
  "skills": ["skills/*.md"],
  "hooks": { ... },
  "mcpServers": { ... },
  "agents": ["agents/*.md"],
  "outputStyles": ["output-styles/*.md"],
  "marketplace": "official",
  "sha256": "abc123...",
  "verified": true,
  "downloads": 1523,
  "rating": 4.7
}
```

**Campos nuevos:**
- `agents`: Agentes personalizados incluidos en el plugin
- `outputStyles`: Estilos de output incluidos
- `marketplace`: De que marketplace viene (para auto-update)
- `sha256`: Hash de verificacion
- `verified`: Si paso verificacion del marketplace
- `downloads`, `rating`: Metadata para UI de marketplace

### 3.8 Configuracion

```json
{
  "marketplace": {
    "sources": [
      {
        "name": "official",
        "type": "cdn",
        "url": "https://cdn.kulvex.ai/plugins",
        "autoUpdate": true,
        "checkIntervalMs": 86400000
      },
      {
        "name": "community",
        "type": "git",
        "url": "https://github.com/kulvex/kcode-plugins",
        "autoUpdate": false
      }
    ],
    "allowedPlugins": [],
    "blockedPlugins": [],
    "verifyIntegrity": true
  }
}
```

### 3.9 Tests Requeridos

1. **CDN fetcher:**
   - Descarga atomica completa sin errores
   - Rollback a version anterior si descarga falla
   - SHA mismatch rechaza la descarga
   - Skip si SHA sentinel coincide

2. **SHA tracker:**
   - Lee/escribe sentinel files correctamente
   - needsUpdate detecta cambios
   - invalidate fuerza re-descarga

3. **Verifier:**
   - Detecta manifest faltante
   - Detecta skills faltantes
   - Detecta path traversal
   - Warn en plugins grandes

4. **Auto-updater:**
   - Respeta intervalo de check
   - Detecta versiones nuevas con semver
   - No rompe plugins existentes si update falla

5. **Output style loader:**
   - Carga styles de plugins habilitados
   - Ignora plugins deshabilitados
   - Namespace correcto con prefijo

### 3.10 Criterios de Aceptacion

- [ ] `kcode plugin install my-plugin` descarga desde CDN con atomic swap
- [ ] Si la descarga se interrumpe, el plugin anterior sigue funcionando
- [ ] SHA sentinel evita re-descargas innecesarias
- [ ] Auto-update detecta nuevas versiones al startup (cada 24h)
- [ ] Plugins con `verified: false` muestran warning al instalar
- [ ] Output styles de plugins aparecen en `kcode --list-styles`
- [ ] Path traversal en plugins es bloqueado

---

## Feature 4: Sistema de Migraciones Formal

### 4.1 Contexto

KCode no tiene un sistema de migraciones. Los cambios de schema SQL se aplican
en `db.ts` al crear tablas (CREATE IF NOT EXISTS), pero no hay forma de:
- Alterar tablas existentes
- Migrar configuraciones de versiones anteriores
- Actualizar nombres de modelos cuando cambian (ej: `claude-3-opus` -> `claude-opus-4`)
- Ejecutar one-time fixes al actualizar KCode

Claude Code tiene migraciones versionadas que corren al startup y actualizan
settings, modelos, y feature flags.

### 4.2 Archivos Nuevos a Crear

```
src/
  migrations/
    runner.ts                    (~200 lineas) - Motor de migraciones
    runner.test.ts               (~250 lineas) - Tests
    registry.ts                  (~80 lineas)  - Registro de todas las migraciones
    types.ts                     (~50 lineas)  - Interfaces
    migrations/
      001_add_schema_version.ts  (~60 lineas)  - Bootstrap: agregar tabla de versiones
      002_migrate_model_names.ts (~80 lineas)  - Actualizar nombres de modelos
      003_add_compaction_config.ts (~50 lineas) - Agregar config de compactacion
      004_migrate_legacy_memory.ts (~100 lineas) - Migrar memorias al nuevo formato
```

**Archivos Existentes a Modificar:**
- `src/core/db.ts` - Agregar tabla `schema_migrations`, llamar runner al init
- `src/index.ts` - Ejecutar migraciones antes de iniciar la app

### 4.3 Diseño del Motor de Migraciones

#### 4.3.1 Tabla de Control

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,         -- "001", "002", etc.
  name TEXT NOT NULL,                   -- "add_schema_version"
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  checksum TEXT NOT NULL,               -- SHA256 del contenido de la migracion
  duration_ms INTEGER,                  -- Tiempo de ejecucion
  status TEXT NOT NULL DEFAULT 'applied' -- 'applied' | 'failed' | 'rolled_back'
);
```

#### 4.3.2 Interfaz de Migracion

```typescript
// src/migrations/types.ts

interface Migration {
  /** Version unica ordenable: "001", "002", etc. */
  version: string;
  /** Nombre descriptivo */
  name: string;
  /** Tipo: 'sql' para cambios de schema, 'config' para settings, 'data' para datos */
  type: 'sql' | 'config' | 'data';
  /** Funcion que ejecuta la migracion */
  up: (context: MigrationContext) => Promise<void>;
  /** Funcion que revierte (opcional, best-effort) */
  down?: (context: MigrationContext) => Promise<void>;
}

interface MigrationContext {
  /** Conexion a SQLite */
  db: Database;
  /** Leer/escribir settings */
  settings: {
    getUserSettings(): Record<string, any>;
    setUserSettings(settings: Record<string, any>): void;
    getProjectSettings(dir: string): Record<string, any>;
    setProjectSettings(dir: string, settings: Record<string, any>): void;
  };
  /** Logger */
  log: Logger;
  /** Version actual de KCode */
  kcodeVersion: string;
  /** Plataforma */
  platform: 'linux' | 'darwin' | 'win32';
}
```

#### 4.3.3 Runner de Migraciones

```typescript
// src/migrations/runner.ts

class MigrationRunner {
  constructor(private db: Database, private migrations: Migration[]) {}

  /** Ejecutar todas las migraciones pendientes */
  async run(): Promise<MigrationReport> {
    const applied = this.getAppliedVersions();
    const pending = this.migrations.filter(m => !applied.has(m.version));

    // Ordenar por version
    pending.sort((a, b) => a.version.localeCompare(b.version));

    const report: MigrationReport = { applied: [], failed: null };

    for (const migration of pending) {
      const start = Date.now();
      try {
        // Ejecutar dentro de transaccion (solo para SQL)
        if (migration.type === 'sql') {
          this.db.exec('BEGIN');
        }

        await migration.up(this.buildContext());

        if (migration.type === 'sql') {
          this.db.exec('COMMIT');
        }

        // Registrar exito
        this.recordApplied(migration, Date.now() - start);
        report.applied.push(migration.version);

      } catch (error) {
        if (migration.type === 'sql') {
          this.db.exec('ROLLBACK');
        }

        // Registrar fallo
        this.recordFailed(migration, Date.now() - start);
        report.failed = { version: migration.version, error: error.message };

        // DETENER: no ejecutar migraciones posteriores
        break;
      }
    }

    return report;
  }

  /** Obtener versiones ya aplicadas */
  private getAppliedVersions(): Set<string> {
    try {
      const rows = this.db.prepare(
        "SELECT version FROM schema_migrations WHERE status = 'applied'"
      ).all();
      return new Set(rows.map(r => r.version));
    } catch {
      // Tabla no existe aun (primera vez)
      return new Set();
    }
  }

  /** Registrar migracion aplicada */
  private recordApplied(migration: Migration, durationMs: number): void {
    this.db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, duration_ms, status) VALUES (?, ?, ?, ?, 'applied')"
    ).run(migration.version, migration.name, this.checksum(migration), durationMs);
  }

  /** Checksum de la migracion (para detectar cambios accidentales) */
  private checksum(migration: Migration): string {
    const hash = new Bun.CryptoHasher('sha256');
    hash.update(migration.up.toString());
    return hash.digest('hex');
  }
}
```

### 4.4 Migraciones Iniciales

#### 4.4.1 Migration 001: Bootstrap

```typescript
// 001_add_schema_version.ts
export const migration: Migration = {
  version: '001',
  name: 'add_schema_version',
  type: 'sql',
  up: async ({ db }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        checksum TEXT NOT NULL,
        duration_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'applied'
      )
    `);
  },
  down: async ({ db }) => {
    db.exec('DROP TABLE IF EXISTS schema_migrations');
  },
};
```

#### 4.4.2 Migration 002: Migrar Nombres de Modelos

```typescript
// 002_migrate_model_names.ts

const MODEL_RENAMES: Record<string, string> = {
  'claude-3-opus': 'claude-opus-4',
  'claude-3-sonnet': 'claude-sonnet-4',
  'claude-3-haiku': 'claude-haiku-4',
  'gpt-4-turbo': 'gpt-4o',
  // Agregar mas segun sea necesario
};

export const migration: Migration = {
  version: '002',
  name: 'migrate_model_names',
  type: 'config',
  up: async ({ settings, log }) => {
    const userSettings = settings.getUserSettings();

    for (const [oldName, newName] of Object.entries(MODEL_RENAMES)) {
      // Migrar modelo por defecto
      if (userSettings.defaultModel === oldName) {
        userSettings.defaultModel = newName;
        log.info(`Migrated default model: ${oldName} -> ${newName}`);
      }
      // Migrar modelo de compactacion
      if (userSettings.compactionModel === oldName) {
        userSettings.compactionModel = newName;
      }
      // Migrar modelos en router
      if (userSettings.modelRouter) {
        for (const [task, model] of Object.entries(userSettings.modelRouter)) {
          if (model === oldName) {
            userSettings.modelRouter[task] = newName;
          }
        }
      }
    }

    settings.setUserSettings(userSettings);
  },
};
```

#### 4.4.3 Migration 003: Config de Compactacion

```typescript
// 003_add_compaction_config.ts
export const migration: Migration = {
  version: '003',
  name: 'add_compaction_config',
  type: 'config',
  up: async ({ settings }) => {
    const userSettings = settings.getUserSettings();

    // Solo agregar si no existe (no sobreescribir custom config)
    if (!userSettings.compaction) {
      userSettings.compaction = {
        microCompact: { enabled: true },
        fullCompact: { groupByRounds: true, fileRestoreBudget: 50000 },
        circuitBreaker: { maxFailures: 3 },
        imageStripping: { enabled: true },
      };
      settings.setUserSettings(userSettings);
    }
  },
};
```

#### 4.4.4 Migration 004: Migrar Memorias Legacy

```typescript
// 004_migrate_legacy_memory.ts
export const migration: Migration = {
  version: '004',
  name: 'migrate_legacy_memory',
  type: 'data',
  up: async ({ db, log }) => {
    // Verificar si hay memorias sin el campo auto_extracted
    // y agregar auto_extracted: false a las existentes
    const memories = db.prepare(
      "SELECT id, content FROM memories WHERE source IS NULL"
    ).all();

    if (memories.length > 0) {
      const stmt = db.prepare("UPDATE memories SET source = 'user' WHERE id = ?");
      for (const mem of memories) {
        stmt.run(mem.id);
      }
      log.info(`Migrated ${memories.length} legacy memories with source='user'`);
    }
  },
};
```

### 4.5 Registro de Migraciones

```typescript
// src/migrations/registry.ts

import { migration as m001 } from './migrations/001_add_schema_version';
import { migration as m002 } from './migrations/002_migrate_model_names';
import { migration as m003 } from './migrations/003_add_compaction_config';
import { migration as m004 } from './migrations/004_migrate_legacy_memory';

export const ALL_MIGRATIONS: Migration[] = [m001, m002, m003, m004];
```

### 4.6 Integracion en Startup

En `src/index.ts` o `src/core/db.ts`:

```typescript
// Antes de iniciar la app:
import { MigrationRunner } from './migrations/runner';
import { ALL_MIGRATIONS } from './migrations/registry';

async function initDatabase(): Promise<void> {
  const db = getDatabase();

  const runner = new MigrationRunner(db, ALL_MIGRATIONS);
  const report = await runner.run();

  if (report.applied.length > 0) {
    log.info(`Applied ${report.applied.length} migrations: ${report.applied.join(', ')}`);
  }

  if (report.failed) {
    log.error(`Migration ${report.failed.version} failed: ${report.failed.error}`);
    log.error('KCode may not work correctly. Run `kcode doctor` for diagnostics.');
  }
}
```

### 4.7 Comando Doctor

Agregar a `kcode doctor` una verificacion de migraciones:

```
> kcode doctor
  ...
  [OK] Database migrations: 4/4 applied
  [OK] Last migration: 004_migrate_legacy_memory (2026-03-31)
  ...
```

Si hay migraciones fallidas:
```
  [FAIL] Migration 003 failed: SQLITE_ERROR: table already exists
         Run `kcode migrate --retry` to re-attempt
```

### 4.8 Tests Requeridos

1. **Runner:**
   - Ejecuta migraciones pendientes en orden
   - Salta migraciones ya aplicadas
   - Se detiene en primera migracion fallida
   - Rollback de SQL en error
   - Checksum detecta cambios en migraciones

2. **Migration 001:**
   - Crea tabla schema_migrations

3. **Migration 002:**
   - Renombra modelos en settings
   - No toca modelos que no estan en la lista
   - Maneja settings vacios

4. **Migration 003:**
   - Agrega config de compactacion
   - No sobreescribe config existente

5. **Migration 004:**
   - Actualiza memorias sin source
   - No toca memorias que ya tienen source

### 4.9 Criterios de Aceptacion

- [ ] Primera ejecucion de KCode 1.7.0 aplica las 4 migraciones automaticamente
- [ ] Ejecuciones posteriores no re-aplican migraciones
- [ ] Si una migracion falla, las posteriores no se ejecutan
- [ ] `kcode doctor` muestra estado de migraciones
- [ ] Agregar nueva migracion es trivial: crear archivo + agregar a registry
- [ ] Migraciones de config no pierden settings custom del usuario

---

## Feature 5: Keybindings Avanzados con Chords

### 5.1 Contexto

KCode tiene soporte basico de keybindings en `src/core/keybindings.ts` con
`~/.kcode/keybindings.json`, toggle de vim mode, y un mapa simple de action->key.

Claude Code tiene un sistema completo con:
- Parser de chords (ctrl+k ctrl+c = dos pulsaciones secuenciales)
- Reserved keys que no se pueden reasignar
- Display platform-aware (Cmd en macOS, Ctrl en Linux/Windows)
- Validacion de conflictos
- React context para queries de keybindings en componentes
- Hook `useKeybinding` para binding programatico

### 5.2 Archivos Nuevos a Crear

```
src/
  core/
    keybindings/
      parser.ts                 (~180 lineas) - Parser de key combos y chords
      parser.test.ts            (~200 lineas) - Tests
      resolver.ts               (~150 lineas) - Resolucion de precedencia
      resolver.test.ts          (~120 lineas) - Tests
      validator.ts              (~130 lineas) - Validacion de conflictos
      validator.test.ts         (~100 lineas) - Tests
      defaults.ts               (~100 lineas) - Bindings por defecto
      types.ts                  (~60 lineas)  - Interfaces
      index.ts                  (~40 lineas)  - Re-exports
  ui/
    hooks/
      useKeybinding.ts          (~80 lineas)  - Hook de React para keybindings
    components/
      KeybindingContext.tsx      (~60 lineas)  - React context provider
      ShortcutDisplay.tsx        (~50 lineas)  - Renderizado platform-aware
```

**Archivos Existentes a Modificar:**
- `src/core/keybindings.ts` - Refactorizar a usar el nuevo sistema (o deprecar)
- `src/ui/App.tsx` - Envolver en KeybindingContext
- `src/ui/components/InputPrompt.tsx` - Usar useKeybinding para procesar input

### 5.3 Parser de Key Combos y Chords

#### 5.3.1 Formato de Keybindings

```
Combo simple:  "ctrl+c"
Con shift:     "ctrl+shift+a"
Chord:         "ctrl+k ctrl+c"     (dos combos secuenciales)
Chord triple:  "ctrl+k ctrl+k ctrl+d"  (tres combos secuenciales)
Tecla sola:    "escape"
F-keys:        "f5"
Con alt:       "alt+enter"
```

#### 5.3.2 Interfaces del Parser

```typescript
// src/core/keybindings/types.ts

interface KeyCombo {
  key: string;        // Tecla base: 'a', 'enter', 'escape', 'f5', etc.
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;      // Cmd en macOS, Win en Windows
}

interface KeyChord {
  /** Secuencia de combos (1 = combo simple, 2+ = chord) */
  sequence: KeyCombo[];
}

interface KeyBinding {
  /** Accion que ejecuta */
  action: string;
  /** Chord completo */
  chord: KeyChord;
  /** Source: 'default' | 'user' | 'plugin' */
  source: 'default' | 'user' | 'plugin';
  /** Descripcion para help */
  description?: string;
  /** Contexto donde aplica: 'global' | 'input' | 'vim-normal' | 'vim-insert' */
  context?: string;
}
```

#### 5.3.3 Implementacion del Parser

```typescript
// src/core/keybindings/parser.ts

/**
 * Parsea un string de keybinding a KeyChord.
 *
 * Ejemplos:
 *   "ctrl+c"           -> { sequence: [{ key: 'c', ctrl: true, ... }] }
 *   "ctrl+k ctrl+c"    -> { sequence: [{ key: 'k', ctrl: true }, { key: 'c', ctrl: true }] }
 *   "escape"            -> { sequence: [{ key: 'escape', ctrl: false, ... }] }
 */
function parseKeyChord(input: string): KeyChord {
  // Separar por espacios para detectar chords
  const parts = input.trim().toLowerCase().split(/\s+/);

  return {
    sequence: parts.map(parseKeyCombo),
  };
}

function parseKeyCombo(input: string): KeyCombo {
  const parts = input.split('+');
  const modifiers = new Set(parts.slice(0, -1));
  const key = parts[parts.length - 1];

  return {
    key,
    ctrl: modifiers.has('ctrl'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
    meta: modifiers.has('meta') || modifiers.has('cmd'),
  };
}

/**
 * Serializa un KeyChord a string legible.
 * Platform-aware: usa Cmd en macOS, Ctrl en Linux/Windows.
 */
function formatKeyChord(chord: KeyChord, platform: 'darwin' | 'linux' | 'win32'): string {
  return chord.sequence.map(combo => {
    const parts: string[] = [];
    if (combo.ctrl) parts.push(platform === 'darwin' ? '⌃' : 'Ctrl');
    if (combo.alt) parts.push(platform === 'darwin' ? '⌥' : 'Alt');
    if (combo.shift) parts.push(platform === 'darwin' ? '⇧' : 'Shift');
    if (combo.meta) parts.push(platform === 'darwin' ? '⌘' : 'Win');
    parts.push(combo.key.toUpperCase());
    return parts.join(platform === 'darwin' ? '' : '+');
  }).join(' ');
}
```

### 5.4 Reserved Keys

```typescript
// src/core/keybindings/defaults.ts

/** Teclas reservadas que NO se pueden reasignar */
const RESERVED_KEYS: Record<string, string> = {
  'ctrl+c': 'Interrupt/Cancel (system)',
  'ctrl+d': 'Exit/EOF (system)',
  'ctrl+z': 'Suspend (system)',
};

/** Bindings por defecto */
const DEFAULT_BINDINGS: KeyBinding[] = [
  // Navegacion
  { action: 'history.prev', chord: parseKeyChord('up'), source: 'default', description: 'Previous command' },
  { action: 'history.next', chord: parseKeyChord('down'), source: 'default', description: 'Next command' },
  { action: 'submit', chord: parseKeyChord('enter'), source: 'default', description: 'Submit prompt' },
  { action: 'newline', chord: parseKeyChord('shift+enter'), source: 'default', description: 'New line' },

  // Edicion
  { action: 'clear', chord: parseKeyChord('ctrl+l'), source: 'default', description: 'Clear screen' },
  { action: 'undo', chord: parseKeyChord('ctrl+z'), source: 'default', context: 'input' },

  // Chords
  { action: 'toggle.theme', chord: parseKeyChord('ctrl+k ctrl+t'), source: 'default', description: 'Toggle theme' },
  { action: 'toggle.vim', chord: parseKeyChord('ctrl+k ctrl+v'), source: 'default', description: 'Toggle vim mode' },
  { action: 'toggle.verbose', chord: parseKeyChord('ctrl+k ctrl+d'), source: 'default', description: 'Toggle verbose' },
  { action: 'search.messages', chord: parseKeyChord('ctrl+k ctrl+f'), source: 'default', description: 'Search messages' },
  { action: 'pin.file', chord: parseKeyChord('ctrl+k ctrl+p'), source: 'default', description: 'Pin file' },
  { action: 'show.cost', chord: parseKeyChord('ctrl+k ctrl+c'), source: 'default', description: 'Show cost summary' },
  { action: 'model.switch', chord: parseKeyChord('ctrl+k ctrl+m'), source: 'default', description: 'Switch model' },

  // Function keys
  { action: 'help', chord: parseKeyChord('f1'), source: 'default', description: 'Help' },
  { action: 'compact', chord: parseKeyChord('f2'), source: 'default', description: 'Force compact' },
];
```

### 5.5 Resolver de Precedencia

```typescript
// src/core/keybindings/resolver.ts

class KeybindingResolver {
  private bindings: KeyBinding[] = [];
  private pendingChord: KeyCombo[] = [];
  private chordTimeout: Timer | null = null;

  constructor(defaults: KeyBinding[], userOverrides: KeyBinding[]) {
    // User overrides tienen precedencia sobre defaults
    // Si un user binding tiene la misma accion, reemplaza el default
    // Si un user binding tiene el mismo chord, el user gana
    this.bindings = this.merge(defaults, userOverrides);
  }

  /**
   * Procesa una pulsacion de tecla.
   * Returns: accion a ejecutar, o null si es parte de un chord pendiente.
   */
  processKeyPress(combo: KeyCombo): string | null {
    // Agregar al chord pendiente
    this.pendingChord.push(combo);

    // Buscar match exacto
    const exactMatch = this.findExactMatch(this.pendingChord);
    if (exactMatch) {
      this.resetChord();
      return exactMatch.action;
    }

    // Verificar si hay chords que empiezan con este prefijo
    const hasPrefix = this.hasPrefixMatch(this.pendingChord);
    if (hasPrefix) {
      // Esperar mas teclas (chord en progreso)
      this.startChordTimeout();
      return null;  // UI debe mostrar indicador de chord pendiente
    }

    // No match: resetear y procesar como tecla normal
    this.resetChord();
    return null;
  }

  private startChordTimeout(): void {
    // Si no se completa el chord en 1.5s, cancelar
    this.chordTimeout = setTimeout(() => {
      this.resetChord();
      // Emitir evento 'chord-cancelled' para que UI limpie indicador
    }, 1500);
  }

  private resetChord(): void {
    this.pendingChord = [];
    if (this.chordTimeout) {
      clearTimeout(this.chordTimeout);
      this.chordTimeout = null;
    }
  }
}
```

### 5.6 Validacion de Conflictos

```typescript
// src/core/keybindings/validator.ts

interface ValidationResult {
  valid: boolean;
  conflicts: ConflictInfo[];
  reservedViolations: ReservedViolation[];
}

function validateBindings(bindings: KeyBinding[]): ValidationResult {
  const conflicts: ConflictInfo[] = [];
  const reservedViolations: ReservedViolation[] = [];

  // 1. Verificar reserved keys
  for (const binding of bindings) {
    if (binding.source !== 'default') {
      const serialized = serializeChord(binding.chord);
      if (RESERVED_KEYS[serialized]) {
        reservedViolations.push({
          binding,
          reason: `${serialized} is reserved: ${RESERVED_KEYS[serialized]}`,
        });
      }
    }
  }

  // 2. Verificar conflictos (mismo chord, diferente accion)
  const chordMap = new Map<string, KeyBinding[]>();
  for (const binding of bindings) {
    const key = serializeChord(binding.chord) + ':' + (binding.context || 'global');
    if (!chordMap.has(key)) chordMap.set(key, []);
    chordMap.get(key)!.push(binding);
  }

  for (const [chord, bindingsForChord] of chordMap) {
    if (bindingsForChord.length > 1) {
      conflicts.push({
        chord,
        bindings: bindingsForChord,
        resolution: `${bindingsForChord[bindingsForChord.length - 1].source} wins (last loaded)`,
      });
    }
  }

  // 3. Verificar prefix conflicts (chord "ctrl+k" conflicta con combo "ctrl+k ctrl+c")
  // Si existe binding para "ctrl+k" sola, nunca se llegaria al chord "ctrl+k ctrl+c"
  for (const binding of bindings) {
    if (binding.chord.sequence.length === 1) {
      const prefix = serializeCombo(binding.chord.sequence[0]);
      for (const other of bindings) {
        if (other.chord.sequence.length > 1 && serializeCombo(other.chord.sequence[0]) === prefix) {
          conflicts.push({
            chord: prefix,
            bindings: [binding, other],
            resolution: `Simple binding "${binding.action}" blocks chord "${other.action}"`,
          });
        }
      }
    }
  }

  return {
    valid: reservedViolations.length === 0 && conflicts.filter(c => c.bindings.some(b => b.source === 'user')).length === 0,
    conflicts,
    reservedViolations,
  };
}
```

### 5.7 React Integration

```typescript
// src/ui/hooks/useKeybinding.ts

function useKeybinding(action: string, callback: () => void, deps: any[] = []): void {
  const { resolver } = useContext(KeybindingContext);

  useEffect(() => {
    const handler = (resolvedAction: string) => {
      if (resolvedAction === action) callback();
    };
    resolver.on('action', handler);
    return () => resolver.off('action', handler);
  }, [action, ...deps]);
}

// Uso en componentes:
function MyComponent() {
  useKeybinding('toggle.theme', () => {
    cycleTheme();
  });

  useKeybinding('search.messages', () => {
    setSearchOpen(true);
  });
}
```

```typescript
// src/ui/components/ShortcutDisplay.tsx

function ShortcutDisplay({ action }: { action: string }) {
  const { resolver } = useContext(KeybindingContext);
  const platform = process.platform;

  const binding = resolver.getBindingForAction(action);
  if (!binding) return null;

  return <Text dimColor>{formatKeyChord(binding.chord, platform)}</Text>;
}

// Uso: <ShortcutDisplay action="toggle.theme" />
// Renderiza: "Ctrl+K Ctrl+T" en Linux, "⌃K ⌃T" en macOS
```

### 5.8 Formato de ~/.kcode/keybindings.json

```json
{
  "bindings": [
    {
      "action": "submit",
      "key": "ctrl+enter",
      "context": "input"
    },
    {
      "action": "toggle.theme",
      "key": "ctrl+k ctrl+t"
    },
    {
      "action": "custom.deploy",
      "key": "ctrl+k ctrl+d",
      "description": "Deploy to staging"
    }
  ],
  "vimMode": false
}
```

### 5.9 Tests Requeridos

1. **Parser:**
   - Parsea combos simples correctamente
   - Parsea chords de 2 y 3 combos
   - Maneja mayusculas/minusculas
   - Formatea correctamente por plataforma

2. **Resolver:**
   - Match exacto funciona
   - Chord parcial espera mas teclas
   - Timeout cancela chord pendiente
   - User bindings tienen precedencia sobre defaults

3. **Validator:**
   - Detecta reserved key violations
   - Detecta conflictos de chord/combo
   - Detecta prefix conflicts

### 5.10 Criterios de Aceptacion

- [ ] `ctrl+k ctrl+t` ejecuta toggle.theme en dos pulsaciones
- [ ] Usuario puede reasignar acciones en keybindings.json
- [ ] Reserved keys (ctrl+c, ctrl+d) no se pueden reasignar
- [ ] ShortcutDisplay muestra simbolos correctos en macOS vs Linux
- [ ] Chord timeout de 1.5s cancela chords incompletos
- [ ] `kcode doctor` reporta conflictos de keybindings
- [ ] Vim mode sigue funcionando con el nuevo sistema

---

## Feature 6: Coordinator Mode con Scratchpad

### 6.1 Contexto

KCode tiene un sistema de swarm basico (`swarm.ts`) que spawna hasta 8 agentes
en paralelo con distribucion de archivos y merge de resultados. Tambien tiene
un agent tool sofisticado con tipos, background mode, y team coordination.

Lo que NO tiene es un **Coordinator Mode** dedicado donde:
- Un agente coordinador orquesta multiples workers con restricciones de tools
- Los workers comparten un **scratchpad** (espacio de trabajo compartido)
- El coordinador puede ver el progreso en tiempo real
- Los workers tienen tool access restringido segun el modo
- El modo se preserva al resumir sesiones

### 6.2 Archivos Nuevos a Crear

```
src/
  core/
    coordinator/
      coordinator.ts            (~400 lineas) - Modo coordinador principal
      coordinator.test.ts       (~350 lineas) - Tests
      worker.ts                 (~250 lineas) - Logica de worker con restricciones
      worker.test.ts            (~200 lineas) - Tests
      scratchpad.ts             (~200 lineas) - Espacio compartido en filesystem
      scratchpad.test.ts        (~150 lineas) - Tests
      message-bus.ts            (~180 lineas) - Comunicacion coordinador<->workers
      message-bus.test.ts       (~150 lineas) - Tests
      types.ts                  (~80 lineas)  - Interfaces
```

**Archivos Existentes a Modificar:**
- `src/core/swarm.ts` - Integrar coordinator mode como opcion avanzada
- `src/tools/agent.ts` - Agregar soporte para worker restrictions y scratchpad
- `src/core/conversation.ts` - Detectar y restaurar coordinator mode al resumir
- `src/core/config.ts` - Settings de coordinator
- `src/core/system-prompt.ts` - Layer especial para coordinador

### 6.3 Arquitectura del Coordinator Mode

```
                    ┌──────────────────────┐
                    │   COORDINATOR AGENT  │
                    │   (modelo principal) │
                    │                      │
                    │  - Planifica tareas   │
                    │  - Asigna a workers   │
                    │  - Lee scratchpad     │
                    │  - Merge resultados   │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴───────────┐
                    │    MESSAGE BUS       │
                    │  (filesystem-based)  │
                    └──┬────────┬────────┬─┘
                       │        │        │
              ┌────────┴─┐ ┌───┴────┐ ┌─┴────────┐
              │ WORKER 1 │ │ WORKER 2│ │ WORKER 3 │
              │ (simple) │ │(complex)│ │ (simple) │
              │          │ │         │ │          │
              │ Tools:   │ │ Tools:  │ │ Tools:   │
              │ bash     │ │ ALL*    │ │ bash     │
              │ read     │ │         │ │ read     │
              │ edit     │ │         │ │ edit     │
              └────┬─────┘ └────┬────┘ └────┬─────┘
                   │            │            │
              ┌────┴────────────┴────────────┴────┐
              │          SCRATCHPAD               │
              │   ~/.kcode/scratchpad/{sessionId}/ │
              │                                    │
              │   plan.md         (plan compartido)│
              │   progress.md     (progreso)       │
              │   worker-1.md     (output worker 1)│
              │   worker-2.md     (output worker 2)│
              │   notes.md        (notas generales)│
              └────────────────────────────────────┘
```

### 6.4 Tipos e Interfaces

```typescript
// src/core/coordinator/types.ts

interface CoordinatorConfig {
  /** Activar coordinator mode */
  enabled: boolean;
  /** Maximo de workers simultaneos */
  maxWorkers: number;          // default: 4
  /** Modo de worker por defecto */
  defaultWorkerMode: 'simple' | 'complex';  // default: 'simple'
  /** Timeout por worker en ms */
  workerTimeoutMs: number;     // default: 120000 (2 min)
  /** Habilitar scratchpad */
  scratchpadEnabled: boolean;  // default: true
}

type WorkerMode = 'simple' | 'complex';

interface WorkerConfig {
  /** ID unico del worker */
  id: string;
  /** Modo: determina tools disponibles */
  mode: WorkerMode;
  /** Prompt/tarea asignada */
  task: string;
  /** Archivos relevantes (opcionales) */
  files?: string[];
  /** Tools adicionales permitidos (ademas de los del modo) */
  extraTools?: string[];
  /** Tools explicitamente bloqueados */
  blockedTools?: string[];
  /** Modelo (hereda del coordinador por defecto) */
  model?: string;
}

interface WorkerResult {
  id: string;
  status: 'completed' | 'failed' | 'timeout';
  output: string;
  filesModified: string[];
  durationMs: number;
  tokensUsed: { input: number; output: number };
  error?: string;
}

interface ScratchpadEntry {
  file: string;          // Nombre del archivo en scratchpad
  content: string;       // Contenido
  author: string;        // 'coordinator' | 'worker-{id}'
  timestamp: number;     // Unix timestamp
}

interface CoordinatorMessage {
  type: 'task' | 'progress' | 'result' | 'cancel' | 'query';
  from: string;          // 'coordinator' | 'worker-{id}'
  to: string;            // Destinatario
  payload: any;
  timestamp: number;
}
```

### 6.5 Worker Tool Restrictions

```typescript
// src/core/coordinator/worker.ts

/** Tools permitidos segun modo */
const WORKER_TOOLS: Record<WorkerMode, string[]> = {
  simple: [
    'Bash',
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
  ],
  complex: [
    'Bash',
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'GrepReplace',
    'Rename',
    'WebFetch',
    'WebSearch',
    'GitStatus',
    'GitCommit',
    'GitLog',
    'TestRunner',
    'DiffViewer',
    // MCP tools (si hay servidores configurados)
  ],
};

/** Tools NUNCA permitidos para workers (reservados al coordinador) */
const COORDINATOR_ONLY_TOOLS: string[] = [
  'Agent',          // Solo el coordinador puede spawnar workers
  'SendMessage',    // Solo entre coordinador y workers via message bus
  'Skill',          // Skills son del coordinador
  'Plan',           // El coordinador planifica
];

function getWorkerTools(config: WorkerConfig, mcpTools: string[]): string[] {
  let tools = [...WORKER_TOOLS[config.mode]];

  // Agregar tools extra permitidos
  if (config.extraTools) {
    tools.push(...config.extraTools.filter(t => !COORDINATOR_ONLY_TOOLS.includes(t)));
  }

  // En modo complex, agregar MCP tools
  if (config.mode === 'complex') {
    tools.push(...mcpTools);
  }

  // Remover bloqueados
  if (config.blockedTools) {
    tools = tools.filter(t => !config.blockedTools!.includes(t));
  }

  return [...new Set(tools)];
}
```

### 6.6 Scratchpad (Espacio Compartido)

```typescript
// src/core/coordinator/scratchpad.ts

class Scratchpad {
  private dir: string;

  constructor(sessionId: string) {
    // ~/.kcode/scratchpad/{sessionId}/
    this.dir = join(homedir(), '.kcode', 'scratchpad', sessionId);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Escribir un archivo en el scratchpad */
  write(file: string, content: string, author: string): void {
    // Validar que file no tiene path traversal
    if (file.includes('..') || file.startsWith('/')) {
      throw new Error('Invalid scratchpad file name');
    }

    const fullPath = join(this.dir, file);
    writeFileSync(fullPath, content, 'utf-8');

    // Registrar en log
    this.appendLog({ file, author, action: 'write', timestamp: Date.now() });
  }

  /** Leer un archivo del scratchpad */
  read(file: string): string | null {
    const fullPath = join(this.dir, file);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, 'utf-8');
  }

  /** Listar todos los archivos */
  list(): ScratchpadEntry[] {
    return readdirSync(this.dir)
      .filter(f => !f.startsWith('.'))
      .map(file => ({
        file,
        content: readFileSync(join(this.dir, file), 'utf-8'),
        author: this.getAuthor(file),
        timestamp: statSync(join(this.dir, file)).mtimeMs,
      }));
  }

  /** Limpiar scratchpad al finalizar sesion */
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Obtener path del scratchpad (para workers) */
  getPath(): string {
    return this.dir;
  }
}
```

### 6.7 Message Bus (Filesystem-based)

```typescript
// src/core/coordinator/message-bus.ts

/**
 * Message bus basado en filesystem para comunicacion entre coordinador y workers.
 * Usa archivos JSON en un directorio compartido con polling.
 *
 * Estructura:
 *   ~/.kcode/scratchpad/{sessionId}/.messages/
 *     inbox-coordinator.jsonl
 *     inbox-worker-1.jsonl
 *     inbox-worker-2.jsonl
 */
class MessageBus {
  private messagesDir: string;
  private pollingInterval: Timer | null = null;

  constructor(scratchpadDir: string) {
    this.messagesDir = join(scratchpadDir, '.messages');
    mkdirSync(this.messagesDir, { recursive: true });
  }

  /** Enviar mensaje a un destinatario */
  send(message: CoordinatorMessage): void {
    const inbox = join(this.messagesDir, `inbox-${message.to}.jsonl`);
    appendFileSync(inbox, JSON.stringify(message) + '\n');
  }

  /** Leer mensajes pendientes para un destinatario */
  receive(recipient: string): CoordinatorMessage[] {
    const inbox = join(this.messagesDir, `inbox-${recipient}.jsonl`);
    if (!existsSync(inbox)) return [];

    const content = readFileSync(inbox, 'utf-8');
    const messages = content.trim().split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as CoordinatorMessage);

    // Limpiar inbox despues de leer
    writeFileSync(inbox, '');

    return messages;
  }

  /** Polling periodico para nuevos mensajes */
  startPolling(recipient: string, callback: (messages: CoordinatorMessage[]) => void, intervalMs: number = 1000): void {
    this.pollingInterval = setInterval(() => {
      const messages = this.receive(recipient);
      if (messages.length > 0) callback(messages);
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
}
```

### 6.8 Coordinator Principal

```typescript
// src/core/coordinator/coordinator.ts

class Coordinator {
  private scratchpad: Scratchpad;
  private messageBus: MessageBus;
  private workers: Map<string, WorkerHandle> = new Map();
  private config: CoordinatorConfig;

  constructor(sessionId: string, config: CoordinatorConfig) {
    this.config = config;
    this.scratchpad = new Scratchpad(sessionId);
    this.messageBus = new MessageBus(this.scratchpad.getPath());
  }

  /** Iniciar modo coordinador */
  async start(): Promise<void> {
    // 1. Escribir plan inicial en scratchpad
    this.scratchpad.write('plan.md', '# Plan\n\n(Pendiente de definir)', 'coordinator');
    this.scratchpad.write('progress.md', '# Progreso\n\n- Coordinador iniciado', 'coordinator');

    // 2. Iniciar polling de mensajes
    this.messageBus.startPolling('coordinator', this.handleWorkerMessages.bind(this));
  }

  /** Asignar tarea a un worker */
  async assignTask(workerConfig: WorkerConfig): Promise<string> {
    if (this.workers.size >= this.config.maxWorkers) {
      throw new Error(`Max workers (${this.config.maxWorkers}) reached`);
    }

    // 1. Determinar tools del worker
    const tools = getWorkerTools(workerConfig, this.getMcpTools());

    // 2. Spawnar proceso KCode como worker
    const handle = await spawnWorker({
      ...workerConfig,
      allowedTools: tools,
      scratchpadDir: this.scratchpad.getPath(),
      messageBusDir: join(this.scratchpad.getPath(), '.messages'),
      coordinatorId: 'coordinator',
    });

    this.workers.set(workerConfig.id, handle);

    // 3. Actualizar progreso
    this.updateProgress(`Worker ${workerConfig.id} asignado: ${workerConfig.task}`);

    // 4. Enviar tarea via message bus
    this.messageBus.send({
      type: 'task',
      from: 'coordinator',
      to: workerConfig.id,
      payload: { task: workerConfig.task, files: workerConfig.files },
      timestamp: Date.now(),
    });

    return workerConfig.id;
  }

  /** Leer resultados de workers completados */
  async collectResults(): Promise<WorkerResult[]> {
    const results: WorkerResult[] = [];

    for (const [id, handle] of this.workers) {
      if (handle.status === 'completed' || handle.status === 'failed') {
        const output = this.scratchpad.read(`worker-${id}.md`);
        results.push({
          id,
          status: handle.status,
          output: output || handle.output || '',
          filesModified: handle.filesModified || [],
          durationMs: handle.durationMs || 0,
          tokensUsed: handle.tokensUsed || { input: 0, output: 0 },
          error: handle.error,
        });
      }
    }

    return results;
  }

  /** Actualizar progreso en scratchpad */
  private updateProgress(entry: string): void {
    const current = this.scratchpad.read('progress.md') || '# Progreso\n';
    const timestamp = new Date().toISOString().slice(11, 19);
    this.scratchpad.write('progress.md', `${current}\n- [${timestamp}] ${entry}`, 'coordinator');
  }

  /** Manejar mensajes de workers */
  private handleWorkerMessages(messages: CoordinatorMessage[]): void {
    for (const msg of messages) {
      switch (msg.type) {
        case 'progress':
          this.updateProgress(`[${msg.from}] ${msg.payload.message}`);
          break;
        case 'result':
          const handle = this.workers.get(msg.from);
          if (handle) {
            handle.status = 'completed';
            handle.output = msg.payload.output;
            handle.filesModified = msg.payload.filesModified;
          }
          break;
        case 'query':
          // Worker pregunta algo al coordinador
          // El coordinador puede responder o delegar al usuario
          break;
      }
    }
  }

  /** Cancelar todos los workers */
  async cancelAll(): Promise<void> {
    for (const [id, handle] of this.workers) {
      if (handle.status === 'running') {
        this.messageBus.send({
          type: 'cancel',
          from: 'coordinator',
          to: id,
          payload: {},
          timestamp: Date.now(),
        });
        handle.process?.kill();
      }
    }
  }

  /** Limpiar al finalizar */
  async cleanup(): Promise<void> {
    this.messageBus.stopPolling();
    await this.cancelAll();
    // NO limpiar scratchpad automaticamente (puede necesitarse para resume)
  }
}
```

### 6.9 Worker Spawn

```typescript
// Modificar en src/tools/agent.ts la funcion de spawn para workers coordinados

async function spawnWorker(config: WorkerSpawnConfig): Promise<WorkerHandle> {
  const args = [
    '--print',                                    // Non-interactive
    '--permission', 'deny',                       // Workers no piden permisos
    '--allowed-tools', config.allowedTools.join(','), // Tools restringidos
  ];

  if (config.model) {
    args.push('--model', config.model);
  }

  // Prompt del worker incluye instrucciones de scratchpad
  const workerPrompt = [
    config.task,
    '',
    `## Scratchpad`,
    `Tienes acceso a un espacio compartido en: ${config.scratchpadDir}`,
    `- Lee plan.md para entender el plan general`,
    `- Escribe tu output en worker-${config.id}.md`,
    `- Puedes leer archivos de otros workers para contexto`,
    '',
    `## Restricciones`,
    `- Solo puedes usar estas herramientas: ${config.allowedTools.join(', ')}`,
    `- No intentes usar herramientas no listadas`,
    `- Cuando termines, escribe tu resultado en el scratchpad y termina`,
  ].join('\n');

  args.push('--prompt', workerPrompt);

  // Spawnar como subprocess
  const proc = Bun.spawn(['kcode', ...args], {
    env: {
      ...process.env,
      KCODE_WORKER_ID: config.id,
      KCODE_COORDINATOR_MODE: 'worker',
      KCODE_SCRATCHPAD_DIR: config.scratchpadDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    id: config.id,
    process: proc,
    status: 'running',
    startedAt: Date.now(),
  };
}
```

### 6.10 Session Resume con Coordinator Mode

```typescript
// Agregar en conversation.ts la deteccion de coordinator mode al resumir

function detectCoordinatorMode(transcript: TranscriptEntry[]): boolean {
  // Verificar si la sesion anterior era coordinator mode
  return transcript.some(entry =>
    entry.env?.KCODE_COORDINATOR_MODE === 'coordinator'
  );
}

// Al resumir:
if (detectCoordinatorMode(previousTranscript)) {
  // Restaurar env vars
  process.env.KCODE_COORDINATOR_MODE = 'coordinator';

  // Restaurar scratchpad si existe
  const scratchpadDir = join(homedir(), '.kcode', 'scratchpad', sessionId);
  if (existsSync(scratchpadDir)) {
    coordinator = new Coordinator(sessionId, config.coordinator);
    // Leer progreso anterior
    const progress = readFileSync(join(scratchpadDir, 'progress.md'), 'utf-8');
    // Inyectar como contexto
    messages.unshift({
      role: 'system',
      content: `[Sesion coordinador restaurada]\n\nProgreso anterior:\n${progress}`,
    });
  }
}
```

### 6.11 CLI Integration

```bash
# Iniciar en coordinator mode
kcode --coordinator

# Con workers pre-configurados
kcode --coordinator --workers 3

# Con modo especifico
kcode --coordinator --worker-mode complex
```

### 6.12 Configuracion

```json
{
  "coordinator": {
    "enabled": false,
    "maxWorkers": 4,
    "defaultWorkerMode": "simple",
    "workerTimeoutMs": 120000,
    "scratchpadEnabled": true,
    "preserveScratchpadOnExit": true
  }
}
```

### 6.13 Tests Requeridos

1. **Coordinator:**
   - Inicia correctamente con scratchpad
   - Asigna tareas a workers
   - Respeta maxWorkers
   - Cancela workers correctamente
   - Resume desde sesion anterior

2. **Worker:**
   - Recibe tools correctos segun modo simple/complex
   - COORDINATOR_ONLY_TOOLS nunca se asignan
   - Extra tools y blocked tools funcionan

3. **Scratchpad:**
   - Escribe y lee archivos correctamente
   - Bloquea path traversal
   - Cleanup elimina directorio
   - Multiples writers no corrompen datos (append-only logs)

4. **Message Bus:**
   - Envio y recepcion funciona
   - Polling detecta nuevos mensajes
   - Inbox se limpia despues de leer
   - Multiples writers concurrentes no pierden mensajes (JSONL append)

5. **Integracion:**
   - `kcode --coordinator` inicia coordinator mode
   - Session resume restaura coordinator state
   - Workers se detienen al cancelar sesion

### 6.14 Criterios de Aceptacion

- [ ] `kcode --coordinator` inicia modo coordinador con scratchpad
- [ ] Workers simple solo tienen acceso a Bash, Read, Edit, Write, Glob, Grep
- [ ] Workers complex tienen acceso a todos los tools excepto Agent, Skill, Plan
- [ ] Scratchpad persiste entre workers y es legible por el coordinador
- [ ] Message bus permite comunicacion bidireccional
- [ ] Al resumir sesion coordinadora, se restaura el estado
- [ ] Workers respetan timeout de 2 minutos
- [ ] Maximo 4 workers simultaneos (configurable)

---

## RESUMEN DE ESTIMACIONES

| Feature | Archivos Nuevos | LoC Nuevas | Tests | Archivos Modificados |
|---------|:-:|:-:|:-:|:-:|
| 1. Auto-Memory + Forked Agent | 7 | ~1,510 | ~650 | 5 |
| 2. Compactacion Multi-Estrategia | 10 | ~1,780 | ~900 | 3 |
| 3. Plugin Marketplace CDN | 11 | ~1,360 | ~680 | 5 |
| 4. Sistema de Migraciones | 8 | ~870 | ~250 | 2 |
| 5. Keybindings con Chords | 10 | ~1,170 | ~420 | 3 |
| 6. Coordinator Mode | 9 | ~1,940 | ~700 | 5 |
| **TOTAL** | **55** | **~8,630** | **~3,600** | **23** |

## ORDEN DE IMPLEMENTACION SUGERIDO

```
Semana 1-2:  Feature 4 (Migraciones) ─── Base para todo lo demas
    │
Semana 2-3:  Feature 2 (Compactacion) ── No depende de otros
    │
Semana 3-4:  Feature 5 (Keybindings) ─── No depende de otros
    │
Semana 4-5:  Feature 1 (Auto-Memory) ─── Usa forked-agent, necesita migracion 004
    │
Semana 5-7:  Feature 3 (Marketplace) ─── Mas complejo, puede hacerse en paralelo
    │
Semana 7-9:  Feature 6 (Coordinator) ─── El mas complejo, necesita agent.ts estable
```

**Dependencias:**
- Feature 1 depende de Feature 4 (migracion 004 para memorias legacy)
- Feature 6 depende de que agent.ts este estable
- Features 2, 3, 5 son independientes entre si

## NOTAS PARA EL DESARROLLADOR

1. **NO copiar codigo de Claude Code.** Este plan describe conceptos y diseños propios.
   La implementacion debe ser original, usando el stack de KCode (Bun, SQLite, React/Ink).

2. **Tests primero.** Cada feature tiene tests definidos. Escribir al menos los tests
   unitarios antes de la implementacion.

3. **Feature flags.** Cada feature debe tener un flag en config para activar/desactivar.
   Esto permite releases incrementales.

4. **Backwards compatible.** Las migraciones y nuevos configs deben tener defaults
   que preserven el comportamiento actual de KCode 1.6.0.

5. **Documentacion.** Actualizar `docs/ARCHITECTURE.md` con cada feature nueva.
   Actualizar `README.md` con las nuevas capacidades.
