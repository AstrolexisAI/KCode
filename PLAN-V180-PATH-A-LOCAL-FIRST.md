# Plan v1.8.0 — Camino A: Diferenciacion Local-First

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~14,000-17,000 LoC nuevas
**Filosofia:** KCode funciona SIN internet, SIN cloud, SIN dependencias externas.
Claude Code NUNCA podra hacer esto. Esta es nuestra ventaja competitiva.

> NOTA: Cada feature tiene un flag para activar/desactivar. Todo debe ser
> backwards-compatible con v1.7.0. NO se copia codigo de ningun competidor.

---

## INDICE

1. [Feature A1: Offline Mode Completo](#feature-a1-offline-mode-completo)
2. [Feature A2: Local RAG Engine](#feature-a2-local-rag-engine)
3. [Feature A3: Hardware Auto-Optimizer](#feature-a3-hardware-auto-optimizer)
4. [Feature A4: Multi-Model Ensemble](#feature-a4-multi-model-ensemble)
5. [Feature A5: Model Distillation Pipeline](#feature-a5-model-distillation-pipeline)
6. [Feature A6: P2P Agent Mesh](#feature-a6-p2p-agent-mesh)

---

## Feature A1: Offline Mode Completo

### 1.1 Contexto

KCode ya soporta modelos locales (llama.cpp, Ollama, vLLM, MLX) pero todavia
depende de internet para:
- Plugin marketplace (CDN fetch)
- Web search/fetch tools
- MCP servers remotos
- Auto-update check
- Pro key validation (online)
- Voice transcription (Kulvex API como primer backend)

El objetivo es que `kcode --offline` funcione al 100% sin ninguna conexion de red.

### 1.2 Archivos Nuevos

```
src/
  core/
    offline/
      mode.ts                    (~200 lineas) - Controlador de modo offline
      mode.test.ts               (~180 lineas)
      network-guard.ts           (~150 lineas) - Interceptor de requests HTTP
      network-guard.test.ts      (~120 lineas)
      cache-warmer.ts            (~250 lineas) - Pre-cache de recursos mientras hay red
      cache-warmer.test.ts       (~200 lineas)
      local-search.ts            (~300 lineas) - Reemplazo offline de WebSearch
      local-search.test.ts       (~200 lineas)
      types.ts                   (~50 lineas)
```

**Archivos a Modificar:**
- `src/core/config.ts` — agregar `offlineMode` setting
- `src/core/conversation.ts` — verificar modo offline antes de API calls
- `src/tools/web-fetch.ts` — cache-first + offline fallback
- `src/tools/web-search.ts` — fallback a local-search
- `src/core/marketplace.ts` — usar cache local si offline
- `src/core/plugin-manager.ts` — bloquear installs remotos si offline
- `src/core/voice.ts` — saltar Kulvex API, ir directo a whisper local
- `src/index.ts` — detectar conectividad al startup

### 1.3 Controlador de Modo Offline

```typescript
// src/core/offline/mode.ts

interface OfflineState {
  /** true = modo offline forzado por usuario */
  forced: boolean;
  /** true = no hay red disponible (detectado automaticamente) */
  detected: boolean;
  /** true = cualquiera de los dos anteriores */
  active: boolean;
  /** Timestamp de ultima verificacion de red */
  lastNetworkCheck: number;
  /** Recursos disponibles localmente */
  localResources: {
    hasLocalModel: boolean;
    hasLocalWhisper: boolean;
    hasPluginCache: boolean;
    hasCachedDocs: boolean;
  };
}

class OfflineMode {
  private state: OfflineState;

  /** Activar modo offline manualmente */
  enable(): void {
    this.state.forced = true;
    this.state.active = true;
    this.notifySystemPrompt();
  }

  /** Desactivar modo offline manual */
  disable(): void {
    this.state.forced = false;
    this.state.active = this.state.detected;
  }

  /** Verificar si hay conectividad (non-blocking, con cache de 60s) */
  async checkConnectivity(): Promise<boolean> {
    if (Date.now() - this.state.lastNetworkCheck < 60_000) {
      return !this.state.detected;
    }
    try {
      // Intentar DNS resolve de un dominio confiable
      // NO hacer HTTP request completo (lento, innecesario)
      const result = await Bun.dns.resolve('dns.google', 'A');
      this.state.detected = false;
      this.state.lastNetworkCheck = Date.now();
      return true;
    } catch {
      this.state.detected = true;
      this.state.active = true;
      this.state.lastNetworkCheck = Date.now();
      return false;
    }
  }

  /** Inventario de recursos locales */
  async auditLocalResources(): Promise<OfflineState['localResources']> {
    return {
      hasLocalModel: await this.detectLocalModel(),
      hasLocalWhisper: await this.detectWhisper(),
      hasPluginCache: existsSync(join(homedir(), '.kcode/plugins/marketplace-cache')),
      hasCachedDocs: existsSync(join(homedir(), '.kcode/cache/docs')),
    };
  }

  /** Verificar si un modelo local esta disponible */
  private async detectLocalModel(): Promise<boolean> {
    // Intentar GET a localhost:10091/health (llama.cpp)
    // Intentar GET a localhost:11434/api/tags (Ollama)
    // Retornar true si alguno responde
    const endpoints = [
      'http://localhost:10091/health',
      'http://localhost:11434/api/tags',
    ];
    for (const url of endpoints) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return true;
      } catch { /* continue */ }
    }
    return false;
  }

  private async detectWhisper(): Promise<boolean> {
    // Verificar si faster-whisper o whisper.cpp existen en PATH
    try {
      const result = Bun.spawnSync(['which', 'whisper-cpp']);
      if (result.exitCode === 0) return true;
      const result2 = Bun.spawnSync(['which', 'faster-whisper']);
      return result2.exitCode === 0;
    } catch { return false; }
  }

  /** Inyectar en system prompt si estamos offline */
  notifySystemPrompt(): string {
    if (!this.state.active) return '';
    return [
      '## Modo Offline Activo',
      'No tienes acceso a internet. Las herramientas WebFetch y WebSearch no estan disponibles.',
      'Usa solo herramientas locales (Read, Write, Edit, Bash, Glob, Grep).',
      'Si necesitas informacion externa, indica al usuario que la busque manualmente.',
    ].join('\n');
  }
}
```

### 1.4 Network Guard (Interceptor de HTTP)

```typescript
// src/core/offline/network-guard.ts

/**
 * Intercepta todas las llamadas HTTP salientes cuando estamos en modo offline.
 * Permite: localhost, 127.0.0.1, ::1 (modelos locales)
 * Bloquea: todo lo demas
 */

const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]);

function isLocalHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_HOSTS.has(parsed.hostname) ||
           parsed.hostname.startsWith('192.168.') ||
           parsed.hostname.startsWith('10.');
  } catch {
    return false;
  }
}

/**
 * Wrapper de fetch que respeta modo offline.
 * Usar en vez de fetch() global en todo el codebase.
 */
async function offlineAwareFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const urlStr = url.toString();

  if (offlineMode.isActive() && !isLocalHost(urlStr)) {
    throw new OfflineError(
      `Blocked: ${urlStr} (offline mode active). Use a local resource or disable offline mode.`
    );
  }

  return fetch(url, init);
}

class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}
```

### 1.5 Cache Warmer (Pre-cache mientras hay red)

```typescript
// src/core/offline/cache-warmer.ts

/**
 * Cuando hay red disponible, pre-cachea recursos para uso offline futuro.
 * Se ejecuta en background al iniciar KCode si no estamos offline.
 */

interface CacheWarmerConfig {
  enabled: boolean;
  maxCacheSizeMb: number;       // default: 500
  cacheDirs: {
    docs: string;               // ~/.kcode/cache/docs/
    plugins: string;            // ~/.kcode/plugins/marketplace-cache/
    models: string;             // ~/.kcode/cache/models/ (metadatos, no pesos)
    search: string;             // ~/.kcode/cache/search/
  };
}

class CacheWarmer {
  /** Ejecutar warmup en background */
  async warmup(): Promise<WarmupReport> {
    const report: WarmupReport = { cached: [], errors: [], totalSizeMb: 0 };

    // 1. Cache plugin manifests del marketplace
    await this.cachePluginManifests(report);

    // 2. Cache documentacion de herramientas frecuentes
    await this.cacheFrequentDocs(report);

    // 3. Cache resultados de busquedas recientes
    await this.cacheRecentSearches(report);

    // 4. Verificar modelos locales disponibles
    await this.cacheModelMetadata(report);

    return report;
  }

  /** Cache manifests de todos los plugins del marketplace */
  private async cachePluginManifests(report: WarmupReport): Promise<void> {
    // Descargar catalogo del marketplace
    // Guardar en ~/.kcode/cache/marketplace-catalog.json
    // Incluir: nombre, version, descripcion, sha256, dependencias
    // NO descargar los plugins completos (solo metadatos)
  }

  /** Cache documentacion de lenguajes/frameworks usados en el proyecto */
  private async cacheFrequentDocs(report: WarmupReport): Promise<void> {
    // Detectar lenguajes del proyecto actual (package.json, Cargo.toml, go.mod, etc.)
    // Descargar cheatsheets/references relevantes
    // Guardar como markdown en ~/.kcode/cache/docs/{lang}/
    // Maximo 10MB total
  }

  /** Cache resultados de busquedas web recientes */
  private async cacheRecentSearches(report: WarmupReport): Promise<void> {
    // Leer historial de WebSearch de analytics (ultimas 50 queries)
    // Re-ejecutar las 10 mas frecuentes
    // Guardar resultados en ~/.kcode/cache/search/{query_hash}.json
    // TTL: 7 dias
  }

  /** Verificar y cachear metadatos de modelos disponibles */
  private async cacheModelMetadata(report: WarmupReport): Promise<void> {
    // GET localhost:11434/api/tags (Ollama)
    // GET localhost:10091/v1/models (llama.cpp)
    // Guardar lista de modelos disponibles localmente
    // Incluir: nombre, tamaño, cuantizacion, context window
  }
}
```

### 1.6 Local Search (Reemplazo offline de WebSearch)

```typescript
// src/core/offline/local-search.ts

/**
 * Cuando WebSearch no esta disponible (offline), buscar en:
 * 1. Cache de busquedas previas
 * 2. Documentacion cacheada
 * 3. Learnings de la base de datos
 * 4. Codebase index (simbolos y definiciones)
 * 5. Man pages del sistema
 */

interface LocalSearchResult {
  source: 'cache' | 'docs' | 'learnings' | 'codebase' | 'manpages';
  title: string;
  content: string;
  relevance: number;  // 0-1
}

async function localSearch(query: string, limit: number = 10): Promise<LocalSearchResult[]> {
  const results: LocalSearchResult[] = [];

  // 1. Buscar en cache de busquedas previas
  const cached = searchCache(query);
  results.push(...cached.map(r => ({ ...r, source: 'cache' as const })));

  // 2. Buscar en documentacion cacheada
  const docs = searchCachedDocs(query);
  results.push(...docs.map(r => ({ ...r, source: 'docs' as const })));

  // 3. Buscar en learnings (FTS5)
  const learnings = await searchLearnings(query);
  results.push(...learnings.map(r => ({ ...r, source: 'learnings' as const })));

  // 4. Buscar en codebase index
  const codeResults = await searchCodebaseIndex(query);
  results.push(...codeResults.map(r => ({ ...r, source: 'codebase' as const })));

  // 5. Buscar en man pages
  const manResults = await searchManPages(query);
  results.push(...manResults.map(r => ({ ...r, source: 'manpages' as const })));

  // Ordenar por relevancia y deduplicar
  return results
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

/** Buscar en man pages del sistema */
async function searchManPages(query: string): Promise<LocalSearchResult[]> {
  try {
    // apropos busca en descripciones de man pages
    const result = Bun.spawnSync(['apropos', query], { timeout: 5000 });
    if (result.exitCode !== 0) return [];

    const lines = result.stdout.toString().trim().split('\n').slice(0, 5);
    return lines.map(line => ({
      title: line.split(' - ')[0]?.trim() || line,
      content: line,
      relevance: 0.3,
      source: 'manpages' as const,
    }));
  } catch { return []; }
}
```

### 1.7 Integracion en Tools

**web-fetch.ts:** Agregar cache-first:
```
Si offline:
  1. Buscar en cache (~/.kcode/cache/fetch/{url_hash}.json)
  2. Si encontrado y TTL valido: retornar de cache
  3. Si no: throw OfflineError con sugerencia de usar --online
Si online:
  1. Fetch normal
  2. Guardar en cache para uso futuro offline
```

**web-search.ts:** Agregar fallback:
```
Si offline:
  1. Ejecutar localSearch(query)
  2. Formatear resultados como si vinieran de web
  3. Indicar "(resultado offline)" en cada resultado
Si online:
  Comportamiento actual (Brave -> SearXNG -> DuckDuckGo)
```

### 1.8 CLI Integration

```bash
# Forzar modo offline
kcode --offline

# Verificar estado
kcode doctor --offline-check

# Pre-cachear recursos
kcode cache warmup

# Limpiar cache
kcode cache clear

# Ver tamaño de cache
kcode cache stats
```

### 1.9 Configuracion

```json
{
  "offline": {
    "enabled": false,
    "autoDetect": true,
    "cacheWarmer": {
      "enabled": true,
      "maxCacheSizeMb": 500,
      "warmupOnStartup": true
    },
    "localSearch": {
      "enabled": true,
      "sources": ["cache", "docs", "learnings", "codebase", "manpages"]
    }
  }
}
```

### 1.10 Tests

1. **mode.ts:** Activar/desactivar, deteccion automatica, audit de recursos
2. **network-guard.ts:** Bloqueo correcto, permite localhost, OfflineError
3. **cache-warmer.ts:** Warmup en background, respeta maxSize, cache de plugins
4. **local-search.ts:** Busca en todas las fuentes, ordena por relevancia, man pages

### 1.11 Criterios de Aceptacion

- [ ] `kcode --offline` funciona sin ninguna conexion de red (con modelo local)
- [ ] Auto-deteccion de red funciona en menos de 2 segundos
- [ ] Cache warmer pre-cachea al menos plugins y documentacion
- [ ] WebSearch fallback a localSearch es transparente para el usuario
- [ ] WebFetch usa cache si el recurso fue previamente descargado
- [ ] `kcode doctor --offline-check` muestra inventario de recursos locales
- [ ] Voice funciona offline con whisper local

---

## Feature A2: Local RAG Engine

### 2.1 Contexto

KCode tiene un `codebase-index.ts` basico que extrae simbolos con regex y los guarda
en SQLite. Solo busca por nombre de archivo/export/extension (keyword match).

Un RAG Engine real necesita:
- **Embeddings locales** (sin API, sin internet)
- **Busqueda semantica** ("funciones que manejan autenticacion" en vez de "auth")
- **Chunking inteligente** (por funcion/clase, no por lineas arbitrarias)
- **Indice vectorial** en SQLite (sin depender de Pinecone/Weaviate)
- **Actualizacion incremental** (solo re-indexar archivos modificados)

### 2.2 Archivos Nuevos

```
src/
  core/
    rag/
      engine.ts                  (~400 lineas) - Motor RAG principal
      engine.test.ts             (~350 lineas)
      embedder.ts                (~300 lineas) - Generacion de embeddings locales
      embedder.test.ts           (~250 lineas)
      chunker.ts                 (~350 lineas) - Chunking inteligente por AST
      chunker.test.ts            (~300 lineas)
      vector-store.ts            (~250 lineas) - Indice vectorial en SQLite
      vector-store.test.ts       (~200 lineas)
      reranker.ts                (~150 lineas) - Re-ranking de resultados
      reranker.test.ts           (~120 lineas)
      types.ts                   (~80 lineas)
```

**Archivos a Modificar:**
- `src/core/db.ts` — agregar tablas de embeddings
- `src/core/codebase-index.ts` — integrar con RAG para enriquecer resultados
- `src/core/system-prompt.ts` — inyectar contexto RAG relevante
- `src/core/conversation.ts` — auto-RAG antes de cada turno

### 2.3 Generacion de Embeddings Locales

#### 2.3.1 Backends de Embeddings (sin internet)

```typescript
// src/core/rag/embedder.ts

type EmbeddingBackend = 'llama-cpp' | 'ollama' | 'bge-micro' | 'tfidf';

interface EmbeddingConfig {
  /** Backend a usar (default: auto-detect) */
  backend: EmbeddingBackend | 'auto';
  /** Modelo de embedding (default: depende del backend) */
  model: string;
  /** Dimension del vector (default: depende del modelo) */
  dimensions: number;
  /** Batch size para embedding masivo */
  batchSize: number;  // default: 32
}

const BACKEND_PRIORITY: EmbeddingBackend[] = [
  'ollama',       // Ollama con nomic-embed-text o mxbai-embed-large
  'llama-cpp',    // llama.cpp embedding endpoint
  'bge-micro',    // BGE-micro via ONNX runtime (bundled, 23MB)
  'tfidf',        // TF-IDF puro (fallback sin GPU, sin modelo)
];
```

#### 2.3.2 Backend: Ollama Embeddings

```typescript
async function embedWithOllama(texts: string[], model: string = 'nomic-embed-text'): Promise<number[][]> {
  // POST http://localhost:11434/api/embed
  // { model: "nomic-embed-text", input: texts }
  // Returns: { embeddings: number[][] }
  //
  // Modelos recomendados:
  // - nomic-embed-text (137M params, 768 dims, excelente calidad)
  // - mxbai-embed-large (335M params, 1024 dims, mejor calidad)
  // - all-minilm (22M params, 384 dims, mas rapido)
  //
  // Pre-requisito: usuario debe tener el modelo descargado
  // ollama pull nomic-embed-text
}
```

#### 2.3.3 Backend: llama.cpp Embeddings

```typescript
async function embedWithLlamaCpp(texts: string[], endpoint: string = 'http://localhost:10091'): Promise<number[][]> {
  // POST {endpoint}/v1/embeddings
  // { model: "embedding", input: texts }
  // Returns: { data: [{ embedding: number[] }] }
  //
  // Requiere que llama.cpp este corriendo con --embedding flag
  // y un modelo de embeddings cargado (ej: nomic-embed-text-v1.5.Q8_0.gguf)
}
```

#### 2.3.4 Backend: TF-IDF (Fallback sin modelo)

```typescript
/**
 * TF-IDF puro implementado en TypeScript.
 * NO requiere ningun modelo externo. Funciona en cualquier maquina.
 * Calidad inferior a embeddings neurales, pero mejor que keyword match.
 *
 * Genera vectores sparse que luego se comparan con cosine similarity.
 */
class TFIDFEmbedder {
  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  private dimensions: number = 0;

  /** Construir vocabulario desde corpus */
  fit(documents: string[]): void {
    // 1. Tokenizar todos los documentos
    // 2. Construir vocabulario (top 10,000 tokens por frecuencia)
    // 3. Calcular IDF para cada token: log(N / df(t))
    // 4. this.dimensions = vocabulary.size
  }

  /** Generar vector TF-IDF para un texto */
  embed(text: string): number[] {
    // 1. Tokenizar texto
    // 2. Calcular TF (frecuencia normalizada)
    // 3. Multiplicar por IDF
    // 4. Retornar vector sparse como dense array
  }

  /** Guardar/cargar vocabulario en disco */
  save(path: string): void;
  load(path: string): void;
}
```

#### 2.3.5 Auto-Deteccion de Backend

```typescript
async function detectBestBackend(): Promise<EmbeddingBackend> {
  // 1. Verificar Ollama con modelo de embeddings
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    const hasEmbedModel = data.models?.some(m =>
      m.name.includes('embed') || m.name.includes('nomic') || m.name.includes('minilm')
    );
    if (hasEmbedModel) return 'ollama';
  } catch { /* continue */ }

  // 2. Verificar llama.cpp con endpoint de embeddings
  try {
    const r = await fetch('http://localhost:10091/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ input: 'test', model: 'embedding' }),
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) return 'llama-cpp';
  } catch { /* continue */ }

  // 3. Verificar si ONNX runtime esta disponible para BGE-micro
  // (bundled con KCode si se instalo con --with-embeddings)
  if (existsSync(join(homedir(), '.kcode/models/bge-micro-v2.onnx'))) {
    return 'bge-micro';
  }

  // 4. Fallback: TF-IDF puro (siempre disponible)
  return 'tfidf';
}
```

### 2.4 Chunking Inteligente

```typescript
// src/core/rag/chunker.ts

interface CodeChunk {
  id: string;              // hash del contenido
  filePath: string;
  relativePath: string;
  language: string;
  type: 'function' | 'class' | 'method' | 'module' | 'block' | 'comment';
  name: string;            // nombre del simbolo
  content: string;         // codigo completo del chunk
  startLine: number;
  endLine: number;
  signature: string;       // firma del simbolo (para busqueda rapida)
  dependencies: string[];  // imports que usa este chunk
  tokenEstimate: number;   // estimacion de tokens
}

/**
 * Estrategia de chunking por lenguaje:
 *
 * TypeScript/JavaScript:
 *   - Cada funcion/metodo es un chunk
 *   - Cada clase es un chunk (con metodos como sub-chunks)
 *   - Imports agrupados como chunk de modulo
 *   - Archivos < 100 lineas: un solo chunk
 *
 * Python:
 *   - Cada def/async def es un chunk
 *   - Cada class es un chunk
 *   - Top-level code como chunk de modulo
 *
 * Go:
 *   - Cada func es un chunk
 *   - Cada type struct/interface es un chunk
 *
 * Rust:
 *   - Cada fn/pub fn es un chunk
 *   - Cada impl block es un chunk
 *   - Cada struct/enum es un chunk
 *
 * Otros lenguajes:
 *   - Sliding window de 50 lineas con 10 de overlap
 */

class CodeChunker {
  chunk(filePath: string, content: string, language: string): CodeChunk[] {
    switch (language) {
      case 'typescript':
      case 'javascript':
      case 'tsx':
      case 'jsx':
        return this.chunkTypeScript(filePath, content);
      case 'python':
        return this.chunkPython(filePath, content);
      case 'go':
        return this.chunkGo(filePath, content);
      case 'rust':
        return this.chunkRust(filePath, content);
      default:
        return this.chunkSlidingWindow(filePath, content, language);
    }
  }

  private chunkTypeScript(filePath: string, content: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split('\n');

    // Regex patterns para detectar boundaries:
    // - export (async)? function NAME
    // - export (default)? class NAME
    // - const NAME = (async)? (args) =>
    // - export const NAME = (async)? function
    // - interface NAME {
    // - type NAME =

    // Algoritmo:
    // 1. Detectar todas las boundaries (linea de inicio de cada simbolo)
    // 2. Para cada boundary, encontrar el cierre (matching braces)
    // 3. Crear chunk con contexto (imports al inicio del archivo)
    // 4. Si archivo < 100 lineas, un solo chunk

    if (lines.length < 100) {
      return [this.createWholeFileChunk(filePath, content, 'typescript')];
    }

    // ... pattern matching y brace counting para cada lenguaje
    return chunks;
  }

  private chunkSlidingWindow(
    filePath: string,
    content: string,
    language: string,
    windowSize: number = 50,
    overlap: number = 10,
  ): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];

    for (let i = 0; i < lines.length; i += windowSize - overlap) {
      const end = Math.min(i + windowSize, lines.length);
      const chunkContent = lines.slice(i, end).join('\n');

      chunks.push({
        id: this.hashContent(filePath + ':' + i),
        filePath,
        relativePath: this.getRelativePath(filePath),
        language,
        type: 'block',
        name: `${basename(filePath)}:${i + 1}-${end}`,
        content: chunkContent,
        startLine: i + 1,
        endLine: end,
        signature: '',
        dependencies: [],
        tokenEstimate: Math.ceil(chunkContent.length / 4),
      });
    }

    return chunks;
  }
}
```

### 2.5 Vector Store en SQLite

```typescript
// src/core/rag/vector-store.ts

/**
 * Almacena embeddings en SQLite usando BLOB para vectores.
 * Busqueda por cosine similarity con fuerza bruta optimizada.
 *
 * Para <100K chunks, brute-force es suficientemente rapido (<100ms).
 * Si el proyecto crece, se puede agregar un indice IVF mas adelante.
 */

// Schema SQL:
// CREATE TABLE IF NOT EXISTS rag_chunks (
//   id TEXT PRIMARY KEY,
//   file_path TEXT NOT NULL,
//   relative_path TEXT NOT NULL,
//   language TEXT NOT NULL,
//   type TEXT NOT NULL,
//   name TEXT NOT NULL,
//   content TEXT NOT NULL,
//   signature TEXT,
//   start_line INTEGER,
//   end_line INTEGER,
//   embedding BLOB,           -- Float32Array serializado
//   token_estimate INTEGER,
//   indexed_at TEXT DEFAULT (datetime('now')),
//   file_modified_at TEXT
// );
// CREATE INDEX idx_rag_file ON rag_chunks(file_path);
// CREATE INDEX idx_rag_type ON rag_chunks(type);

class VectorStore {
  private db: Database;
  private dimensions: number;

  constructor(db: Database, dimensions: number) {
    this.db = db;
    this.dimensions = dimensions;
    this.createSchema();
  }

  /** Insertar o actualizar chunks con embeddings */
  upsert(chunks: Array<CodeChunk & { embedding: number[] }>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO rag_chunks
      (id, file_path, relative_path, language, type, name, content, signature,
       start_line, end_line, embedding, token_estimate, file_modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const chunk of chunks) {
        stmt.run(
          chunk.id, chunk.filePath, chunk.relativePath, chunk.language,
          chunk.type, chunk.name, chunk.content, chunk.signature,
          chunk.startLine, chunk.endLine,
          Buffer.from(new Float32Array(chunk.embedding).buffer),
          chunk.tokenEstimate,
          new Date().toISOString(),
        );
      }
    });

    txn();
  }

  /** Busqueda semantica: top-K chunks mas similares al query embedding */
  search(queryEmbedding: number[], limit: number = 10, filters?: SearchFilters): SearchResult[] {
    // 1. Cargar todos los embeddings que coincidan con filters
    let sql = 'SELECT id, file_path, relative_path, name, type, content, start_line, end_line, embedding, token_estimate FROM rag_chunks';
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.language) {
      conditions.push('language = ?');
      params.push(filters.language);
    }
    if (filters?.type) {
      conditions.push('type = ?');
      params.push(filters.type);
    }
    if (filters?.filePaths) {
      conditions.push(`file_path IN (${filters.filePaths.map(() => '?').join(',')})`);
      params.push(...filters.filePaths);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const rows = this.db.prepare(sql).all(...params);

    // 2. Calcular cosine similarity para cada row
    const queryVec = new Float32Array(queryEmbedding);
    const scored: SearchResult[] = [];

    for (const row of rows) {
      const embedding = new Float32Array(row.embedding.buffer);
      const similarity = cosineSimilarity(queryVec, embedding);

      scored.push({
        chunkId: row.id,
        filePath: row.file_path,
        relativePath: row.relative_path,
        name: row.name,
        type: row.type,
        content: row.content,
        startLine: row.start_line,
        endLine: row.end_line,
        similarity,
        tokenEstimate: row.token_estimate,
      });
    }

    // 3. Ordenar por similarity descendente y retornar top-K
    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /** Eliminar chunks de archivos borrados o movidos */
  removeByFile(filePath: string): void {
    this.db.prepare('DELETE FROM rag_chunks WHERE file_path = ?').run(filePath);
  }

  /** Estadisticas del indice */
  stats(): VectorStoreStats {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total,
             COUNT(DISTINCT file_path) as files,
             SUM(token_estimate) as totalTokens
      FROM rag_chunks
    `).get();
    return row as VectorStoreStats;
  }
}

/** Cosine similarity optimizada para Float32Array */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

### 2.6 Re-Ranker

```typescript
// src/core/rag/reranker.ts

/**
 * Re-ranking de resultados RAG usando señales adicionales:
 * - Recencia del archivo (mas reciente = mas relevante)
 * - Frecuencia de acceso (archivos tocados frecuentemente en la sesion)
 * - Proximidad al archivo actual (mismo directorio > subdirectorio > otro)
 * - Tipo de chunk (function > class > block para queries de codigo)
 */

interface RerankerConfig {
  weights: {
    semantic: number;      // default: 0.5 (similitud de embedding)
    recency: number;       // default: 0.15
    frequency: number;     // default: 0.15
    proximity: number;     // default: 0.10
    typeBoost: number;     // default: 0.10
  };
}

function rerank(
  results: SearchResult[],
  context: {
    currentFile?: string;
    sessionFiles: string[];  // archivos tocados en la sesion
    queryType: 'code' | 'explanation' | 'search';
  },
  config: RerankerConfig,
): SearchResult[] {
  const now = Date.now();

  return results.map(r => {
    let score = r.similarity * config.weights.semantic;

    // Recencia: boost archivos modificados recientemente
    const fileAge = getFileAge(r.filePath);
    const recencyScore = Math.exp(-fileAge / (7 * 24 * 60 * 60 * 1000)); // decay en 7 dias
    score += recencyScore * config.weights.recency;

    // Frecuencia: boost archivos tocados en la sesion
    const freq = context.sessionFiles.filter(f => f === r.filePath).length;
    const freqScore = Math.min(freq / 5, 1.0); // cap en 5 accesos
    score += freqScore * config.weights.frequency;

    // Proximidad: boost archivos cercanos al archivo actual
    if (context.currentFile) {
      const proximity = pathProximity(context.currentFile, r.filePath);
      score += proximity * config.weights.proximity;
    }

    // Type boost: funciones > clases > bloques para queries de codigo
    if (context.queryType === 'code') {
      const typeScores: Record<string, number> = {
        function: 1.0, method: 0.9, class: 0.7, module: 0.5, block: 0.3, comment: 0.1,
      };
      score += (typeScores[r.type] || 0.3) * config.weights.typeBoost;
    }

    return { ...r, similarity: score };
  }).sort((a, b) => b.similarity - a.similarity);
}
```

### 2.7 Motor RAG Principal

```typescript
// src/core/rag/engine.ts

class RAGEngine {
  private embedder: Embedder;
  private chunker: CodeChunker;
  private vectorStore: VectorStore;
  private reranker: Reranker;
  private indexing: boolean = false;

  /** Indexar proyecto completo (primera vez o rebuild) */
  async indexProject(projectDir: string): Promise<IndexReport> {
    if (this.indexing) throw new Error('Indexing already in progress');
    this.indexing = true;

    try {
      const report: IndexReport = { filesProcessed: 0, chunksCreated: 0, errors: [], durationMs: 0 };
      const start = Date.now();

      // 1. Listar archivos elegibles
      const files = await this.listEligibleFiles(projectDir);

      // 2. Para cada archivo: chunk + embed
      for (const batch of this.batchFiles(files, 10)) {
        const allChunks: CodeChunk[] = [];

        for (const file of batch) {
          try {
            const content = readFileSync(file.path, 'utf-8');
            const language = this.detectLanguage(file.path);
            const chunks = this.chunker.chunk(file.path, content, language);
            allChunks.push(...chunks);
            report.filesProcessed++;
          } catch (e) {
            report.errors.push({ file: file.path, error: (e as Error).message });
          }
        }

        // 3. Generar embeddings en batch
        const texts = allChunks.map(c => this.prepareForEmbedding(c));
        const embeddings = await this.embedder.embedBatch(texts);

        // 4. Guardar en vector store
        const chunksWithEmbeddings = allChunks.map((c, i) => ({
          ...c,
          embedding: embeddings[i],
        }));
        this.vectorStore.upsert(chunksWithEmbeddings);
        report.chunksCreated += chunksWithEmbeddings.length;
      }

      report.durationMs = Date.now() - start;
      return report;
    } finally {
      this.indexing = false;
    }
  }

  /** Actualizacion incremental: solo archivos modificados */
  async updateIndex(projectDir: string): Promise<IndexReport> {
    // 1. Obtener archivos con mtime > ultima indexacion
    // 2. Eliminar chunks viejos de esos archivos
    // 3. Re-chunk + re-embed solo los archivos modificados
    // 4. Detectar archivos eliminados y purgar sus chunks
  }

  /** Busqueda semantica con RAG */
  async search(query: string, options?: RAGSearchOptions): Promise<RAGResult[]> {
    // 1. Generar embedding del query
    const queryEmbedding = await this.embedder.embed(query);

    // 2. Buscar en vector store
    const candidates = this.vectorStore.search(queryEmbedding, options?.limit || 20, options?.filters);

    // 3. Re-rank con señales contextuales
    const reranked = this.reranker.rerank(candidates, {
      currentFile: options?.currentFile,
      sessionFiles: options?.sessionFiles || [],
      queryType: options?.queryType || 'code',
    });

    // 4. Retornar top-K con contenido
    return reranked.slice(0, options?.limit || 10);
  }

  /** Preparar texto de un chunk para embedding */
  private prepareForEmbedding(chunk: CodeChunk): string {
    // Formato: "filepath: signature\n\ncontent"
    // Esto ayuda al embedding a capturar tanto el contexto como el codigo
    const header = `${chunk.relativePath}: ${chunk.signature || chunk.name}`;
    return `${header}\n\n${chunk.content}`;
  }

  /** Archivos elegibles para indexar */
  private async listEligibleFiles(dir: string): Promise<FileInfo[]> {
    // Mismas exclusiones que codebase-index.ts:
    // node_modules, dist, .git, __pycache__, venv, .next, target, vendor, .kcode
    // Max 5000 archivos, max 100KB por archivo
    // Solo archivos de codigo (.ts, .js, .py, .go, .rs, .java, .c, .cpp, .rb, .php, etc.)
  }
}
```

### 2.8 Integracion con System Prompt

Antes de cada turno del usuario, hacer auto-RAG:

```
Usuario escribe mensaje
    |
    v
[1] Extraer keywords del mensaje
    |
    v
[2] RAG search con el mensaje como query
    |
    v
[3] Si hay resultados con similarity > 0.6:
    |   Inyectar en system prompt como contexto:
    |   "## Contexto relevante del codebase"
    |   "### {filepath}:{startLine}-{endLine}"
    |   "{content}"
    |
    v
[4] Budget: max 3000 tokens de contexto RAG por turno
```

### 2.9 Configuracion

```json
{
  "rag": {
    "enabled": true,
    "embeddingBackend": "auto",
    "autoIndex": true,
    "autoSearch": true,
    "maxContextTokens": 3000,
    "reindexOnChange": true,
    "reranker": {
      "semantic": 0.5,
      "recency": 0.15,
      "frequency": 0.15,
      "proximity": 0.10,
      "typeBoost": 0.10
    }
  }
}
```

### 2.10 CLI

```bash
kcode rag index          # Indexar proyecto completo
kcode rag update         # Actualizacion incremental
kcode rag search "auth"  # Busqueda semantica manual
kcode rag stats          # Estadisticas del indice
kcode rag clear          # Limpiar indice
```

### 2.11 Tests

1. **embedder.ts:** Auto-detect backend, embed texto, embed batch, TF-IDF fallback
2. **chunker.ts:** TypeScript chunking, Python chunking, sliding window, archivos pequeños
3. **vector-store.ts:** Upsert, search, cosine similarity, filtros, stats
4. **reranker.ts:** Re-rank con todas las señales, weights configurables
5. **engine.ts:** Index completo, update incremental, search end-to-end

### 2.12 Criterios de Aceptacion

- [ ] `kcode rag index` indexa un proyecto de 1000 archivos en menos de 5 minutos (con Ollama)
- [ ] `kcode rag index` funciona con TF-IDF si no hay modelo de embeddings
- [ ] Busqueda semantica encuentra funciones relevantes por descripcion natural
- [ ] Update incremental solo procesa archivos modificados
- [ ] Auto-RAG inyecta contexto relevante sin exceder 3000 tokens
- [ ] El indice se almacena en SQLite (no archivos externos)

---

## Feature A3: Hardware Auto-Optimizer

### 3.1 Contexto

`setup.ts` actual es minimal. El usuario debe configurar manualmente que modelo usar,
cuanta VRAM dedicar, y que cuantizacion elegir. Esto es complejo para usuarios no-expertos.

El Hardware Auto-Optimizer:
1. Detecta hardware (CPU, RAM, GPU, VRAM)
2. Recomienda el mejor modelo/cuantizacion para ese hardware
3. Auto-configura parametros de inferencia (batch size, context window, threads)
4. Monitorea rendimiento y ajusta en runtime

### 3.2 Archivos Nuevos

```
src/
  core/
    hardware/
      detector.ts               (~350 lineas) - Deteccion de hardware
      detector.test.ts          (~250 lineas)
      optimizer.ts              (~400 lineas) - Recomendaciones y auto-config
      optimizer.test.ts         (~300 lineas)
      monitor.ts                (~200 lineas) - Monitor de rendimiento en runtime
      monitor.test.ts           (~150 lineas)
      profiles.ts               (~250 lineas) - Perfiles de hardware predefinidos
      types.ts                  (~80 lineas)
```

**Archivos a Modificar:**
- `src/cli/commands/setup.ts` — usar detector/optimizer
- `src/core/config.ts` — auto-config de parametros
- `src/core/models.ts` — enriquecer con recomendaciones

### 3.3 Detector de Hardware

```typescript
// src/core/hardware/detector.ts

interface HardwareProfile {
  cpu: {
    model: string;         // "AMD Ryzen 9 7950X"
    cores: number;         // 16
    threads: number;       // 32
    architecture: string;  // "x86_64" | "aarch64"
    features: string[];    // ["avx2", "avx512", "amx"]
  };
  memory: {
    totalGb: number;       // 64
    availableGb: number;   // 48
  };
  gpus: Array<{
    vendor: 'nvidia' | 'amd' | 'intel' | 'apple';
    model: string;         // "RTX 4090"
    vramGb: number;        // 24
    computeCapability?: string; // "8.9" (CUDA)
    driver?: string;       // "535.129.03"
  }>;
  storage: {
    availableGb: number;
    type: 'ssd' | 'hdd' | 'unknown';
  };
  os: {
    platform: string;      // "linux" | "darwin" | "win32"
    release: string;
    isWSL: boolean;
  };
}

class HardwareDetector {
  async detect(): Promise<HardwareProfile> {
    const [cpu, memory, gpus, storage, os] = await Promise.all([
      this.detectCPU(),
      this.detectMemory(),
      this.detectGPUs(),
      this.detectStorage(),
      this.detectOS(),
    ]);
    return { cpu, memory, gpus, storage, os };
  }

  private async detectCPU(): Promise<HardwareProfile['cpu']> {
    // Linux: /proc/cpuinfo
    // macOS: sysctl -n machdep.cpu.brand_string
    // Features: lscpu | grep Flags (Linux), sysctl -a | grep cpu.features (macOS)
  }

  private async detectMemory(): Promise<HardwareProfile['memory']> {
    // Linux: /proc/meminfo (MemTotal, MemAvailable)
    // macOS: sysctl -n hw.memsize + vm_stat
  }

  private async detectGPUs(): Promise<HardwareProfile['gpus']> {
    const gpus: HardwareProfile['gpus'] = [];

    // NVIDIA: nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
    try {
      const result = Bun.spawnSync(['nvidia-smi', '--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits']);
      if (result.exitCode === 0) {
        const lines = result.stdout.toString().trim().split('\n');
        for (const line of lines) {
          const [model, vram, driver, cc] = line.split(',').map(s => s.trim());
          gpus.push({
            vendor: 'nvidia',
            model,
            vramGb: Math.round(parseInt(vram) / 1024),
            driver,
            computeCapability: cc,
          });
        }
      }
    } catch { /* no nvidia GPU */ }

    // AMD: rocm-smi --showmeminfo vram
    try {
      const result = Bun.spawnSync(['rocm-smi', '--showproductname']);
      if (result.exitCode === 0) {
        // Parse AMD GPU info
      }
    } catch { /* no AMD GPU */ }

    // Apple Silicon: system_profiler SPDisplaysDataType
    if (process.platform === 'darwin') {
      try {
        const result = Bun.spawnSync(['system_profiler', 'SPDisplaysDataType', '-json']);
        if (result.exitCode === 0) {
          // Parse Apple GPU info (unified memory)
        }
      } catch { /* no Apple GPU info */ }
    }

    return gpus;
  }

  private async detectStorage(): Promise<HardwareProfile['storage']> {
    // df -h ~/.kcode | awk 'NR==2{print $4}'
    // Detectar SSD vs HDD: lsblk -d -o name,rota (rota=0 es SSD)
  }
}
```

### 3.4 Optimizer (Recomendador)

```typescript
// src/core/hardware/optimizer.ts

interface ModelRecommendation {
  model: string;           // "qwen2.5-coder:32b-instruct-q4_K_M"
  quantization: string;    // "Q4_K_M"
  contextWindow: number;   // 8192
  batchSize: number;       // 512
  threads: number;         // 8
  gpuLayers: number;       // -1 (all)
  estimatedTps: number;    // tokens/segundo estimado
  vramRequired: number;    // GB
  ramRequired: number;     // GB
  reason: string;          // "Best balance for 24GB VRAM + 32GB RAM"
}

class HardwareOptimizer {
  /** Generar recomendacion basada en hardware detectado */
  recommend(profile: HardwareProfile): ModelRecommendation[] {
    const totalVram = profile.gpus.reduce((sum, g) => sum + g.vramGb, 0);
    const totalRam = profile.memory.availableGb;
    const hasNvidia = profile.gpus.some(g => g.vendor === 'nvidia');
    const hasApple = profile.gpus.some(g => g.vendor === 'apple');

    const recommendations: ModelRecommendation[] = [];

    // === Tier 1: GPU con mucha VRAM (>= 24GB) ===
    if (totalVram >= 24) {
      recommendations.push({
        model: 'qwen2.5-coder:32b-instruct-q4_K_M',
        quantization: 'Q4_K_M',
        contextWindow: 16384,
        batchSize: 1024,
        threads: Math.min(profile.cpu.threads, 16),
        gpuLayers: -1,
        estimatedTps: 25,
        vramRequired: 20,
        ramRequired: 4,
        reason: 'Modelo 32B en GPU, excelente calidad de codigo',
      });
    }

    // === Tier 2: GPU media (12-23GB) ===
    if (totalVram >= 12 && totalVram < 24) {
      recommendations.push({
        model: 'qwen2.5-coder:14b-instruct-q4_K_M',
        quantization: 'Q4_K_M',
        contextWindow: 16384,
        batchSize: 512,
        threads: Math.min(profile.cpu.threads, 12),
        gpuLayers: -1,
        estimatedTps: 35,
        vramRequired: 10,
        ramRequired: 4,
        reason: 'Modelo 14B completo en GPU, buen balance calidad/velocidad',
      });
    }

    // === Tier 3: GPU pequeña (6-11GB) ===
    if (totalVram >= 6 && totalVram < 12) {
      recommendations.push({
        model: 'qwen2.5-coder:7b-instruct-q5_K_M',
        quantization: 'Q5_K_M',
        contextWindow: 8192,
        batchSize: 256,
        threads: Math.min(profile.cpu.threads, 8),
        gpuLayers: -1,
        estimatedTps: 50,
        vramRequired: 6,
        ramRequired: 2,
        reason: 'Modelo 7B con alta cuantizacion para GPU limitada',
      });
    }

    // === Tier 4: Solo CPU (sin GPU usable) ===
    if (totalVram < 6) {
      const availableRam = totalRam - 4; // reservar 4GB para OS

      if (availableRam >= 16) {
        recommendations.push({
          model: 'qwen2.5-coder:7b-instruct-q4_K_M',
          quantization: 'Q4_K_M',
          contextWindow: 4096,
          batchSize: 128,
          threads: Math.min(profile.cpu.threads, 8),
          gpuLayers: 0,
          estimatedTps: 8,
          vramRequired: 0,
          ramRequired: 6,
          reason: 'CPU-only, 7B modelo con contexto reducido',
        });
      } else {
        recommendations.push({
          model: 'qwen2.5-coder:3b-instruct-q4_K_M',
          quantization: 'Q4_K_M',
          contextWindow: 2048,
          batchSize: 64,
          threads: Math.min(profile.cpu.threads, 4),
          gpuLayers: 0,
          estimatedTps: 15,
          vramRequired: 0,
          ramRequired: 3,
          reason: 'Modelo compacto para hardware limitado',
        });
      }
    }

    // === Apple Silicon (unifed memory) ===
    if (hasApple) {
      const unifiedMem = totalRam; // Apple Silicon comparte RAM con GPU
      if (unifiedMem >= 32) {
        recommendations.unshift({
          model: 'qwen2.5-coder:32b-instruct-q4_K_M',
          quantization: 'Q4_K_M',
          contextWindow: 16384,
          batchSize: 512,
          threads: profile.cpu.cores,
          gpuLayers: -1,
          estimatedTps: 20,
          vramRequired: 0,
          ramRequired: 22,
          reason: 'Apple Silicon con MLX, memoria unificada',
        });
      }
    }

    return recommendations;
  }

  /** Generar configuracion de llama.cpp optimizada */
  generateLlamaCppConfig(recommendation: ModelRecommendation, profile: HardwareProfile): LlamaCppConfig {
    return {
      model: recommendation.model,
      contextSize: recommendation.contextWindow,
      batchSize: recommendation.batchSize,
      threads: recommendation.threads,
      gpuLayers: recommendation.gpuLayers,
      flashAttention: profile.gpus.some(g =>
        g.vendor === 'nvidia' && parseFloat(g.computeCapability || '0') >= 8.0
      ),
      mmap: true,
      mlock: recommendation.ramRequired < profile.memory.availableGb * 0.5,
      numa: profile.cpu.threads > 16 ? 'distribute' : 'disable',
    };
  }

  /** Generar configuracion de Ollama optimizada */
  generateOllamaConfig(recommendation: ModelRecommendation): Record<string, string> {
    return {
      OLLAMA_NUM_PARALLEL: '2',
      OLLAMA_MAX_LOADED_MODELS: '1',
      OLLAMA_NUM_GPU: String(recommendation.gpuLayers),
      OLLAMA_FLASH_ATTENTION: '1',
    };
  }
}
```

### 3.5 Monitor de Rendimiento

```typescript
// src/core/hardware/monitor.ts

interface PerformanceMetrics {
  tokensPerSecond: number;
  timeToFirstToken: number;  // ms
  gpuUtilization?: number;   // 0-100%
  gpuMemoryUsed?: number;    // GB
  ramUsed: number;           // GB
  cpuUtilization: number;    // 0-100%
}

class PerformanceMonitor {
  private history: PerformanceMetrics[] = [];
  private maxHistory: number = 100;

  /** Registrar metricas de una request completada */
  record(metrics: PerformanceMetrics): void {
    this.history.push(metrics);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /** Obtener metricas promedio */
  average(): PerformanceMetrics {
    // Promedio de todas las metricas en el historial
  }

  /** Detectar degradacion de rendimiento */
  detectDegradation(): DegradationAlert | null {
    // Comparar ultimas 10 metricas con las primeras 10
    // Si TPS cayo >30%, alertar
    // Si TTFT subio >50%, alertar
    // Si GPU mem esta >95%, alertar
    const recent = this.history.slice(-10);
    const baseline = this.history.slice(0, 10);
    // ...
  }

  /** Sugerir optimizaciones basadas en metricas */
  suggestOptimizations(): string[] {
    const avg = this.average();
    const suggestions: string[] = [];

    if (avg.gpuUtilization !== undefined && avg.gpuUtilization < 50) {
      suggestions.push('GPU subutilizada. Considera aumentar batch_size o usar modelo mas grande.');
    }
    if (avg.tokensPerSecond < 5) {
      suggestions.push('Velocidad muy baja. Considera usar cuantizacion mas agresiva (Q4_0) o modelo mas pequeño.');
    }
    if (avg.timeToFirstToken > 5000) {
      suggestions.push('TTFT alto. El contexto puede ser demasiado grande. Considera reducir context_window.');
    }

    return suggestions;
  }
}
```

### 3.6 CLI: Setup Wizard Mejorado

```bash
$ kcode setup --auto

🔍 Detectando hardware...

  CPU:  AMD Ryzen 9 7950X (16 cores, 32 threads, AVX-512)
  RAM:  64 GB (48 GB disponible)
  GPU:  NVIDIA RTX 4090 (24 GB VRAM, CUDA 8.9, driver 535.129)
  Disk: 450 GB SSD disponible

📊 Recomendaciones:

  #1 [RECOMENDADO] qwen2.5-coder:32b-instruct-q4_K_M
     VRAM: 20 GB | RAM: 4 GB | Context: 16K | ~25 tok/s
     "Modelo 32B en GPU, excelente calidad de codigo"

  #2 qwen2.5-coder:14b-instruct-q6_K
     VRAM: 14 GB | RAM: 3 GB | Context: 16K | ~40 tok/s
     "14B con alta cuantizacion, mas rapido"

  Selecciona [1-2] o Enter para #1: 1

⚙️ Configurando llama.cpp...
  ✓ context_size: 16384
  ✓ batch_size: 1024
  ✓ threads: 16
  ✓ gpu_layers: -1 (all)
  ✓ flash_attention: enabled
  ✓ mmap: enabled

✅ Configuracion guardada en ~/.kcode/settings.json
   Ejecuta `kcode server start` para iniciar el modelo.
```

### 3.7 Tests y Criterios

**Tests:**
1. Deteccion de CPU, RAM, GPU en Linux y macOS
2. Recomendaciones correctas para cada tier de hardware
3. Config generation para llama.cpp y Ollama
4. Monitor detecta degradacion
5. Setup wizard funciona end-to-end con mocks

**Criterios:**
- [ ] `kcode setup --auto` detecta hardware en <5 segundos
- [ ] Recomendaciones son correctas para al menos 5 perfiles de hardware
- [ ] Config generada es valida para llama.cpp y Ollama
- [ ] Monitor alerta cuando TPS cae >30%

---

## Feature A4: Multi-Model Ensemble

### 4.1 Contexto

KCode ya tiene un router (`router.ts`) que envia queries a diferentes modelos segun
el tipo de tarea. Pero siempre usa UN solo modelo por query.

Un ensemble usa 2+ modelos en paralelo y mergea/vota las respuestas para obtener
mejor calidad. Esto es especialmente util con modelos locales pequeños que
individualmente son mediocres pero en conjunto pueden ser mejores.

### 4.2 Archivos Nuevos

```
src/
  core/
    ensemble/
      orchestrator.ts           (~400 lineas) - Orquestador de ensemble
      orchestrator.test.ts      (~350 lineas)
      merger.ts                 (~300 lineas) - Merge de respuestas
      merger.test.ts            (~250 lineas)
      voter.ts                  (~200 lineas) - Voting system
      voter.test.ts             (~150 lineas)
      strategies.ts             (~250 lineas) - Estrategias de ensemble
      strategies.test.ts        (~200 lineas)
      types.ts                  (~60 lineas)
```

**Archivos a Modificar:**
- `src/core/conversation.ts` — opcion de ejecutar en modo ensemble
- `src/core/router.ts` — seleccionar modelos para ensemble
- `src/core/config.ts` — settings de ensemble

### 4.3 Estrategias de Ensemble

```typescript
// src/core/ensemble/types.ts

type EnsembleStrategy =
  | 'best-of-n'      // Generar N respuestas, seleccionar la mejor
  | 'majority-vote'  // Para decisiones discretas, la mayoria gana
  | 'merge'          // Combinar partes de multiples respuestas
  | 'verify'         // Un modelo genera, otro verifica/corrige
  | 'specialize';    // Diferentes modelos para diferentes partes

interface EnsembleConfig {
  strategy: EnsembleStrategy;
  models: string[];           // ["qwen2.5:7b", "codellama:7b", "deepseek-coder:6.7b"]
  judgeModel?: string;        // Modelo que evalua/selecciona (puede ser el mas grande)
  maxParallel: number;        // Cuantos modelos correr en paralelo
  timeout: number;            // Timeout por modelo (ms)
  minResponses: number;       // Minimo de respuestas antes de decidir
}

interface EnsembleResult {
  finalResponse: string;
  strategy: EnsembleStrategy;
  candidates: Array<{
    model: string;
    response: string;
    tokensUsed: number;
    durationMs: number;
    score?: number;
  }>;
  reasoning: string;          // Por que se eligio esta respuesta
}
```

### 4.4 Estrategia: Best-of-N

```typescript
// src/core/ensemble/strategies.ts

/**
 * Best-of-N: Generar N respuestas en paralelo, usar un juez para seleccionar la mejor.
 *
 * Flujo:
 * 1. Enviar la misma query a N modelos en paralelo
 * 2. Recoger todas las respuestas
 * 3. Si hay judgeModel: pedirle que elija la mejor
 * 4. Si no hay judgeModel: usar heuristicas (longitud, coherencia, tool calls validos)
 */
async function bestOfN(
  query: Message[],
  config: EnsembleConfig,
): Promise<EnsembleResult> {
  // 1. Ejecutar en paralelo
  const candidates = await Promise.allSettled(
    config.models.map(model =>
      executeWithTimeout(model, query, config.timeout)
    )
  );

  // 2. Filtrar respuestas exitosas
  const successful = candidates
    .filter((r): r is PromiseFulfilledResult<CandidateResponse> => r.status === 'fulfilled')
    .map(r => r.value);

  if (successful.length < config.minResponses) {
    throw new Error(`Only ${successful.length}/${config.minResponses} models responded`);
  }

  // 3. Seleccionar la mejor
  if (config.judgeModel) {
    return await judgeSelect(successful, config.judgeModel, query);
  } else {
    return heuristicSelect(successful);
  }
}

/** Seleccion heuristica (sin juez) */
function heuristicSelect(candidates: CandidateResponse[]): EnsembleResult {
  // Scoring:
  // +2 si tiene tool_calls validos (JSON parseable)
  // +1 por cada 100 chars de respuesta (hasta 500 chars)
  // -1 si tiene "I don't know" o equivalentes
  // -2 si tiene errores de JSON/syntax
  // -1 si es repetitivo (alta compresion ratio)
  //
  // Retornar el de mayor score
}

/** Seleccion con modelo juez */
async function judgeSelect(
  candidates: CandidateResponse[],
  judgeModel: string,
  originalQuery: Message[],
): Promise<EnsembleResult> {
  const judgePrompt = `
Eres un juez de calidad. Se te presentan ${candidates.length} respuestas a la misma pregunta.
Evalua cada una por: correccion, completitud, claridad, y utilidad.
Responde SOLO con el numero de la mejor respuesta (1-${candidates.length}) y una razon breve.

PREGUNTA ORIGINAL:
${originalQuery.map(m => m.content).join('\n')}

${candidates.map((c, i) => `RESPUESTA ${i + 1} (${c.model}):\n${c.response}\n`).join('\n---\n')}
  `.trim();

  const judgeResponse = await executeModelRequest({
    model: judgeModel,
    messages: [{ role: 'user', content: judgePrompt }],
    maxTokens: 200,
    stream: false,
    tools: [],
  });

  // Parse respuesta del juez para extraer numero
  const match = judgeResponse.content.match(/(\d+)/);
  const selectedIndex = match ? parseInt(match[1]) - 1 : 0;

  return {
    finalResponse: candidates[selectedIndex].response,
    strategy: 'best-of-n',
    candidates: candidates.map((c, i) => ({
      ...c,
      score: i === selectedIndex ? 1.0 : 0.0,
    })),
    reasoning: judgeResponse.content,
  };
}
```

### 4.5 Estrategia: Verify (Generar + Verificar)

```typescript
/**
 * Un modelo genera la respuesta, otro la verifica y corrige.
 * Util cuando tienes un modelo rapido (generador) y uno mas capaz (verificador).
 *
 * Flujo:
 * 1. Modelo A genera respuesta
 * 2. Modelo B recibe la respuesta + query original y verifica
 * 3. Si B detecta errores, corrige
 * 4. Output final es la version corregida de B
 */
async function verify(
  query: Message[],
  config: EnsembleConfig,
): Promise<EnsembleResult> {
  const [generatorModel, verifierModel] = config.models;

  // 1. Generar
  const generated = await executeModelRequest({
    model: generatorModel,
    messages: query,
    maxTokens: 4096,
    stream: false,
  });

  // 2. Verificar
  const verifyPrompt = `
Revisa esta respuesta a la pregunta del usuario. Si es correcta, responde "APPROVED" seguido
de la respuesta original sin cambios. Si tiene errores, responde "CORRECTED" seguido de la
version corregida.

PREGUNTA: ${query[query.length - 1].content}

RESPUESTA A REVISAR:
${generated.content}
  `.trim();

  const verified = await executeModelRequest({
    model: verifierModel,
    messages: [{ role: 'user', content: verifyPrompt }],
    maxTokens: 4096,
    stream: false,
  });

  const wasCorreted = verified.content.startsWith('CORRECTED');

  return {
    finalResponse: wasCorreted
      ? verified.content.replace(/^CORRECTED\s*/, '')
      : generated.content,
    strategy: 'verify',
    candidates: [
      { model: generatorModel, response: generated.content, ...generated.usage },
      { model: verifierModel, response: verified.content, ...verified.usage },
    ],
    reasoning: wasCorreted ? 'Verifier corrected the response' : 'Verifier approved the original',
  };
}
```

### 4.6 Estrategia: Specialize

```typescript
/**
 * Divide la tarea en sub-tareas y asigna cada una a un modelo especializado.
 *
 * Ejemplo:
 * - Modelo de codigo: genera el codigo
 * - Modelo de razonamiento: genera el plan/explicacion
 * - Modelo rapido: genera tests
 *
 * Flujo:
 * 1. Analizar la query y dividir en sub-tareas
 * 2. Asignar cada sub-tarea al modelo mas adecuado
 * 3. Ejecutar en paralelo
 * 4. Combinar resultados en respuesta final
 */
async function specialize(
  query: Message[],
  config: EnsembleConfig & {
    specializations: Record<string, { model: string; tasks: string[] }>;
  },
): Promise<EnsembleResult> {
  // Usar el router existente para clasificar la tarea
  // Luego asignar modelos especializados
}
```

### 4.7 Configuracion

```json
{
  "ensemble": {
    "enabled": false,
    "strategy": "best-of-n",
    "models": [],
    "judgeModel": null,
    "maxParallel": 3,
    "timeout": 60000,
    "minResponses": 2,
    "triggerOn": "complex"
  }
}
```

- `triggerOn`: "always" | "complex" | "manual"
  - `always`: Ensemble en cada query
  - `complex`: Solo cuando router detecta tarea compleja/reasoning
  - `manual`: Solo cuando usuario ejecuta `/ensemble`

### 4.8 Tests y Criterios

**Tests:**
1. Best-of-N selecciona correctamente con juez mock
2. Best-of-N heuristic funciona sin juez
3. Verify detecta y corrige errores
4. Specialize divide y recombina
5. Timeout maneja modelos lentos
6. Falla gracefully si < minResponses

**Criterios:**
- [ ] Ensemble best-of-3 produce mejor respuesta que modelo individual (medido en benchmark)
- [ ] Verify corrige al menos 50% de errores de modelos pequeños
- [ ] Timeout de 60s cancela modelos lentos sin afectar a los rapidos
- [ ] El usuario puede activar/desactivar ensemble en runtime

---

## Feature A5: Model Distillation Pipeline

### 5.1 Contexto

KCode ya tiene `distillation.ts` que hace RAG-based few-shot learning: extrae
examples exitosos de sesiones pasadas y los inyecta como contexto. NO hace fine-tuning.

El Model Distillation Pipeline va mas alla:
1. **Exportar dataset** de sesiones pasadas en formatos de fine-tuning (JSONL, ShareGPT)
2. **Curar automaticamente** el dataset (filtrar, limpiar, etiquetar)
3. **Lanzar fine-tuning** via Unsloth/Axolotl (local) o API (cloud)
4. **Evaluar** el modelo fine-tuned vs el base
5. **Deplegar** el modelo distilado como modelo principal

### 5.2 Archivos Nuevos

```
src/
  core/
    distillation/
      exporter.ts               (~350 lineas) - Exportar datasets
      exporter.test.ts          (~250 lineas)
      curator.ts                (~300 lineas) - Curar dataset automaticamente
      curator.test.ts           (~200 lineas)
      trainer.ts                (~400 lineas) - Lanzar fine-tuning
      trainer.test.ts           (~300 lineas)
      evaluator.ts              (~250 lineas) - Evaluar modelo distilado
      evaluator.test.ts         (~200 lineas)
      deployer.ts               (~150 lineas) - Deploy del modelo
      deployer.test.ts          (~100 lineas)
      types.ts                  (~80 lineas)
```

### 5.3 Exporter de Datasets

```typescript
// src/core/distillation/exporter.ts

type ExportFormat = 'jsonl-chat' | 'sharegpt' | 'alpaca' | 'openai';

interface ExportConfig {
  format: ExportFormat;
  minQuality: number;         // 0.0-2.0, default: 0.5
  maxExamples: number;        // default: 5000
  includeToolCalls: boolean;  // default: true
  includeThinking: boolean;   // default: false
  filterProjects?: string[];  // solo de estos proyectos
  filterTags?: string[];      // solo con estos tags
  outputPath: string;         // default: ~/.kcode/datasets/
}

class DatasetExporter {
  /** Exportar dataset desde distilled_examples */
  async export(config: ExportConfig): Promise<ExportReport> {
    // 1. Query examples desde SQLite con filtros
    const examples = this.queryExamples(config);

    // 2. Convertir al formato solicitado
    const formatted = examples.map(ex => this.formatExample(ex, config.format));

    // 3. Escribir archivo
    const outputFile = join(config.outputPath, `dataset_${Date.now()}.${this.getExtension(config.format)}`);
    await this.writeDataset(outputFile, formatted, config.format);

    return {
      outputFile,
      examplesExported: formatted.length,
      format: config.format,
      totalTokens: this.estimateTokens(formatted),
    };
  }

  /** Formato JSONL Chat (compatible con Unsloth/Axolotl) */
  private formatJsonlChat(example: DistilledExample): object {
    const messages: any[] = [];

    // System message (si hay instrucciones del proyecto)
    messages.push({
      role: 'system',
      content: 'You are KCode, an AI coding assistant.',
    });

    // User query
    messages.push({
      role: 'user',
      content: example.user_query,
    });

    // Assistant response (con tool calls si aplica)
    if (example.tool_chain && example.tool_chain.length > 0) {
      // Intercalar tool_calls y tool_results
      for (const tool of JSON.parse(example.tool_chain)) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }],
        });
        messages.push({
          role: 'tool',
          content: tool.output || 'Success',
          name: tool.name,
        });
      }
    }

    // Final assistant response
    messages.push({
      role: 'assistant',
      content: example.assistant_response,
    });

    return { messages };
  }

  /** Formato ShareGPT */
  private formatShareGPT(example: DistilledExample): object {
    return {
      conversations: [
        { from: 'human', value: example.user_query },
        { from: 'gpt', value: example.assistant_response },
      ],
    };
  }
}
```

### 5.4 Curador Automatico

```typescript
// src/core/distillation/curator.ts

class DatasetCurator {
  /** Curar dataset: filtrar, limpiar, deduplicar, balancear */
  async curate(inputFile: string, outputFile: string): Promise<CurationReport> {
    const examples = await this.loadDataset(inputFile);
    let curated = examples;

    // 1. Eliminar duplicados (cosine sim > 0.95 entre queries)
    curated = this.deduplicateByQuery(curated, 0.95);

    // 2. Filtrar ejemplos problematicos
    curated = curated.filter(ex => {
      // No muy cortos (< 20 chars respuesta)
      if (ex.assistant_response.length < 20) return false;
      // No errores sin resolucion
      if (ex.success === false && !ex.assistant_response.includes('fix')) return false;
      // No tool chains rotas (JSON invalido)
      try { if (ex.tool_chain) JSON.parse(ex.tool_chain); } catch { return false; }
      return true;
    });

    // 3. Balancear por tipo de tarea
    curated = this.balanceByTags(curated, {
      maxPerTag: Math.ceil(curated.length / 10),
      minPerTag: 5,
    });

    // 4. Limpiar contenido
    curated = curated.map(ex => ({
      ...ex,
      user_query: this.cleanText(ex.user_query),
      assistant_response: this.cleanText(ex.assistant_response),
    }));

    await this.writeDataset(outputFile, curated);

    return {
      inputCount: examples.length,
      outputCount: curated.length,
      removedDuplicates: examples.length - curated.length,
      // ...
    };
  }
}
```

### 5.5 Trainer (Lanzador de Fine-Tuning)

```typescript
// src/core/distillation/trainer.ts

type TrainingBackend = 'unsloth' | 'axolotl' | 'llamafactory' | 'mlx-lm';

interface TrainingConfig {
  backend: TrainingBackend;
  baseModel: string;           // "unsloth/Qwen2.5-Coder-7B-Instruct"
  datasetPath: string;
  outputDir: string;           // default: ~/.kcode/models/finetuned/
  epochs: number;              // default: 3
  batchSize: number;           // default: 4
  learningRate: number;        // default: 2e-5
  loraRank: number;            // default: 16
  loraAlpha: number;           // default: 32
  maxSeqLength: number;        // default: 4096
  quantization: '4bit' | '8bit' | 'none';  // default: '4bit'
}

class ModelTrainer {
  /** Lanzar fine-tuning (subprocess, puede tardar horas) */
  async train(config: TrainingConfig): Promise<TrainingHandle> {
    const script = this.generateTrainingScript(config);

    // Escribir script a disco
    const scriptPath = join(config.outputDir, 'train.py');
    writeFileSync(scriptPath, script);

    // Ejecutar en background
    const proc = Bun.spawn(['python3', scriptPath], {
      cwd: config.outputDir,
      stdout: Bun.file(join(config.outputDir, 'train.log')),
      stderr: Bun.file(join(config.outputDir, 'train.err')),
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: '0', // Configurable
      },
    });

    return {
      pid: proc.pid,
      logFile: join(config.outputDir, 'train.log'),
      outputDir: config.outputDir,
      status: 'running',
    };
  }

  /** Generar script de training segun backend */
  private generateTrainingScript(config: TrainingConfig): string {
    switch (config.backend) {
      case 'unsloth':
        return this.generateUnslothScript(config);
      case 'mlx-lm':
        return this.generateMLXScript(config);
      default:
        throw new Error(`Backend ${config.backend} not implemented`);
    }
  }

  private generateUnslothScript(config: TrainingConfig): string {
    // Genera Python script que usa Unsloth para fine-tuning:
    // - Carga modelo base con cuantizacion
    // - Aplica LoRA adapters
    // - Entrena con el dataset
    // - Exporta a GGUF para llama.cpp
    return `
from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments
from datasets import load_dataset

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="${config.baseModel}",
    max_seq_length=${config.maxSeqLength},
    load_in_4bit=${config.quantization === '4bit' ? 'True' : 'False'},
)

model = FastLanguageModel.get_peft_model(
    model,
    r=${config.loraRank},
    lora_alpha=${config.loraAlpha},
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"],
)

dataset = load_dataset("json", data_files="${config.datasetPath}", split="train")

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=TrainingArguments(
        per_device_train_batch_size=${config.batchSize},
        num_train_epochs=${config.epochs},
        learning_rate=${config.learningRate},
        output_dir="${config.outputDir}/checkpoints",
        logging_steps=10,
        save_strategy="epoch",
    ),
)

trainer.train()

# Export to GGUF
model.save_pretrained_gguf(
    "${config.outputDir}/gguf",
    tokenizer,
    quantization_method="q4_k_m",
)

print("TRAINING_COMPLETE")
`;
  }
}
```

### 5.6 CLI

```bash
kcode distill export --format jsonl-chat --output ./dataset.jsonl
kcode distill curate ./dataset.jsonl --output ./curated.jsonl
kcode distill train --backend unsloth --base unsloth/Qwen2.5-Coder-7B --dataset ./curated.jsonl
kcode distill eval --model ./finetuned.gguf --benchmark coding-tasks
kcode distill deploy --model ./finetuned.gguf --name "my-kcode-model"
```

### 5.7 Tests y Criterios

**Tests:**
1. Exporter genera JSONL valido con tool calls
2. Curator elimina duplicados y balancea
3. Trainer genera script de Python valido
4. Evaluator compara modelos correctamente

**Criterios:**
- [ ] Export de 500 examples en <10 segundos
- [ ] Dataset curado elimina al menos 10% de ruido
- [ ] Script de Unsloth generado ejecuta sin errores (con dataset mock)
- [ ] Deploy registra modelo en ~/.kcode/models.json automaticamente

---

## Feature A6: P2P Agent Mesh

### 6.1 Contexto

KCode tiene swarm local (procesos en la misma maquina). Pero en equipos de desarrollo,
cada persona tiene su propia maquina con hardware diferente.

El P2P Agent Mesh permite que multiples instancias de KCode en diferentes maquinas
colaboren sin un servidor central. Un agente en la maquina del usuario puede
delegar tareas a agentes en otras maquinas del equipo.

### 6.2 Archivos Nuevos

```
src/
  core/
    mesh/
      node.ts                   (~400 lineas) - Nodo P2P individual
      node.test.ts              (~350 lineas)
      discovery.ts              (~250 lineas) - Descubrimiento de peers
      discovery.test.ts         (~200 lineas)
      transport.ts              (~300 lineas) - Comunicacion entre nodos
      transport.test.ts         (~250 lineas)
      task-scheduler.ts         (~300 lineas) - Distribucion de tareas
      task-scheduler.test.ts    (~250 lineas)
      security.ts               (~200 lineas) - Autenticacion y cifrado
      security.test.ts          (~150 lineas)
      types.ts                  (~80 lineas)
```

### 6.3 Descubrimiento de Peers

```typescript
// src/core/mesh/discovery.ts

type DiscoveryMethod = 'mdns' | 'manual' | 'shared-file';

interface PeerInfo {
  nodeId: string;          // UUID unico del nodo
  hostname: string;
  ip: string;
  port: number;
  capabilities: {
    models: string[];      // Modelos disponibles
    gpuVram: number;       // VRAM total
    cpuCores: number;
    maxConcurrent: number; // Cuantas tareas puede manejar
  };
  status: 'online' | 'busy' | 'offline';
  lastSeen: number;
}

class PeerDiscovery {
  private peers: Map<string, PeerInfo> = new Map();

  /** Metodo 1: mDNS (automatico en LAN) */
  async startMDNS(): Promise<void> {
    // Publicar servicio: _kcode-mesh._tcp
    // Puerto: configurable (default: 19200)
    // TXT records: nodeId, models, vram, cores
    //
    // Implementacion:
    // - Usar Bun.udpSocket para multicast DNS
    // - Publicar en 224.0.0.251:5353
    // - Escuchar anuncios de otros nodos
    // - Refresh cada 30 segundos
  }

  /** Metodo 2: Configuracion manual */
  loadManualPeers(peers: Array<{ host: string; port: number }>): void {
    // Leer de ~/.kcode/settings.json > mesh.peers
    // Probe cada peer para obtener capabilities
  }

  /** Metodo 3: Archivo compartido (NFS/Dropbox/syncthing) */
  async startSharedFile(filePath: string): Promise<void> {
    // Cada nodo escribe su info en un directorio compartido:
    // {filePath}/{nodeId}.json
    // Leer todos los archivos para descubrir peers
    // Watch directory for changes
  }

  /** Obtener peers disponibles ordenados por capacidad */
  getAvailablePeers(): PeerInfo[] {
    return Array.from(this.peers.values())
      .filter(p => p.status === 'online')
      .sort((a, b) => b.capabilities.gpuVram - a.capabilities.gpuVram);
  }
}
```

### 6.4 Transporte Seguro

```typescript
// src/core/mesh/transport.ts

/**
 * Comunicacion entre nodos via TCP con TLS mutuo.
 * Cada nodo tiene un par de llaves generado al primer uso.
 * Los peers se autentican mutuamente con un shared secret (team token).
 */

interface TransportConfig {
  port: number;                 // default: 19200
  teamToken: string;            // Shared secret del equipo (generado una vez)
  tlsCert: string;              // Path al certificado (auto-generado)
  tlsKey: string;               // Path a la llave privada
  maxConnections: number;       // default: 10
  messageMaxSize: number;       // default: 10MB
}

class MeshTransport {
  private server: any; // Bun.serve con TLS

  /** Iniciar servidor TCP+TLS */
  async start(config: TransportConfig): Promise<void> {
    this.server = Bun.serve({
      port: config.port,
      tls: {
        cert: Bun.file(config.tlsCert),
        key: Bun.file(config.tlsKey),
      },
      fetch: async (req) => {
        // Verificar team token en header
        const token = req.headers.get('X-Team-Token');
        if (token !== config.teamToken) {
          return new Response('Unauthorized', { status: 401 });
        }

        const url = new URL(req.url);

        switch (url.pathname) {
          case '/api/v1/capabilities':
            return this.handleCapabilities();
          case '/api/v1/task':
            return this.handleTask(req);
          case '/api/v1/result':
            return this.handleResult(req);
          case '/api/v1/health':
            return new Response('OK');
          default:
            return new Response('Not Found', { status: 404 });
        }
      },
    });
  }

  /** Enviar tarea a un peer */
  async sendTask(peer: PeerInfo, task: MeshTask): Promise<MeshTaskHandle> {
    const response = await fetch(`https://${peer.ip}:${peer.port}/api/v1/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Team-Token': this.config.teamToken,
      },
      body: JSON.stringify(task),
      tls: { rejectUnauthorized: false }, // Self-signed certs
    });

    if (!response.ok) throw new Error(`Peer ${peer.nodeId} rejected task: ${response.status}`);
    return response.json();
  }
}
```

### 6.5 Task Scheduler

```typescript
// src/core/mesh/task-scheduler.ts

interface MeshTask {
  id: string;
  type: 'query' | 'embed' | 'index' | 'test' | 'build';
  prompt?: string;
  files?: string[];           // Archivos necesarios (se sincronizan)
  model?: string;             // Modelo preferido
  priority: 'low' | 'normal' | 'high';
  timeout: number;
}

class TaskScheduler {
  /** Distribuir tarea al mejor peer disponible */
  async schedule(task: MeshTask): Promise<PeerInfo> {
    const peers = this.discovery.getAvailablePeers();

    if (peers.length === 0) {
      throw new Error('No peers available. Running locally.');
    }

    // Scoring de peers:
    // +3 si tiene el modelo solicitado
    // +2 por GB de VRAM disponible
    // +1 por cores de CPU
    // -1 si esta busy
    // -2 si latencia > 100ms

    const scored = await Promise.all(peers.map(async (peer) => {
      let score = 0;
      if (task.model && peer.capabilities.models.includes(task.model)) score += 3;
      score += peer.capabilities.gpuVram * 0.2;
      score += peer.capabilities.cpuCores * 0.1;
      if (peer.status === 'busy') score -= 1;

      // Ping para medir latencia
      const latency = await this.measureLatency(peer);
      if (latency > 100) score -= 2;

      return { peer, score, latency };
    }));

    // Seleccionar el mejor peer
    scored.sort((a, b) => b.score - a.score);
    return scored[0].peer;
  }

  /** Ejecutar tarea distribuida (divide en sub-tareas si necesario) */
  async executeDistributed(task: MeshTask, files: string[]): Promise<MeshResult> {
    const peers = this.discovery.getAvailablePeers();
    const chunkSize = Math.ceil(files.length / (peers.length + 1)); // +1 para local

    const tasks: Array<{ peer: PeerInfo | null; files: string[] }> = [];

    // Distribuir archivos entre peers + local
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      const peerIndex = Math.floor(i / chunkSize);

      if (peerIndex < peers.length) {
        tasks.push({ peer: peers[peerIndex], files: chunk });
      } else {
        tasks.push({ peer: null, files: chunk }); // Local
      }
    }

    // Ejecutar todas las tareas en paralelo
    const results = await Promise.allSettled(
      tasks.map(t => t.peer
        ? this.transport.sendTask(t.peer, { ...task, files: t.files })
        : this.executeLocal({ ...task, files: t.files })
      )
    );

    // Merge resultados
    return this.mergeResults(results);
  }
}
```

### 6.6 Seguridad

```typescript
// src/core/mesh/security.ts

class MeshSecurity {
  /** Generar par de llaves TLS al primer uso */
  async generateKeys(): Promise<{ cert: string; key: string }> {
    // Generar key pair usando Bun crypto
    // Guardar en ~/.kcode/mesh/tls/
    // Self-signed cert con CN=kcode-mesh-{nodeId}
    // Validez: 365 dias
  }

  /** Generar team token (shared secret) */
  generateTeamToken(): string {
    // 32 bytes random, hex encoded
    // Guardar en ~/.kcode/mesh/team-token
    // Compartir manualmente entre miembros del equipo
    // (o via `kcode mesh invite` que genera un token temporal)
  }

  /** Verificar que un request viene de un peer autorizado */
  verifyPeer(request: Request, teamToken: string): boolean {
    return request.headers.get('X-Team-Token') === teamToken;
  }

  /** Cifrar archivos antes de enviar a peers */
  async encryptFile(path: string, key: string): Promise<Buffer> {
    // AES-256-GCM con key derivada del team token
  }
}
```

### 6.7 CLI

```bash
# Iniciar nodo mesh
kcode mesh start

# Generar team token
kcode mesh init-team

# Unirse a un equipo
kcode mesh join <team-token>

# Ver peers
kcode mesh peers

# Enviar tarea a mesh
kcode mesh run "indexa estos 5000 archivos" --distribute

# Estado
kcode mesh status
```

### 6.8 Configuracion

```json
{
  "mesh": {
    "enabled": false,
    "port": 19200,
    "discovery": "mdns",
    "teamToken": null,
    "autoStart": false,
    "maxConcurrentTasks": 2,
    "sharableModels": true,
    "peers": []
  }
}
```

### 6.9 Tests y Criterios

**Tests:**
1. Discovery encuentra peers en LAN (mock mDNS)
2. Transport envia/recibe mensajes con TLS
3. Scheduler selecciona el mejor peer
4. Security genera y verifica tokens
5. Distribucion de tareas funciona end-to-end

**Criterios:**
- [ ] `kcode mesh start` inicia nodo y publica en mDNS
- [ ] Peers se descubren automaticamente en <5 segundos en LAN
- [ ] Team token previene acceso no autorizado
- [ ] Distribucion de indexacion es al menos 2x mas rapida con 2 peers
- [ ] Si un peer falla, la tarea se reasigna a otro o ejecuta local

---

## RESUMEN PATH A

| Feature | Archivos | LoC | Tests |
|---------|:--------:|:---:|:-----:|
| A1. Offline Mode | 8 | ~1,350 | ~700 |
| A2. Local RAG Engine | 10 | ~2,430 | ~1,670 |
| A3. Hardware Auto-Optimizer | 8 | ~1,630 | ~700 |
| A4. Multi-Model Ensemble | 8 | ~1,460 | ~950 |
| A5. Model Distillation Pipeline | 10 | ~1,730 | ~1,000 |
| A6. P2P Agent Mesh | 10 | ~1,930 | ~1,200 |
| **TOTAL PATH A** | **54** | **~10,530** | **~6,220** |

## ORDEN DE IMPLEMENTACION

```
Semana 1-2:  A1 (Offline) ──── Base para todo, habilita testing sin red
    │
Semana 2-4:  A3 (Hardware) ─── Necesario para recomendaciones de A2 y A4
    │
Semana 4-7:  A2 (RAG) ──────── Mas complejo, necesita embeddings locales
    │
Semana 7-9:  A4 (Ensemble) ─── Usa multiples modelos detectados por A3
    │
Semana 9-11: A5 (Distill) ──── Construye sobre examples existentes
    │
Semana 11-14: A6 (P2P Mesh) ── Mas complejo, requiere todo lo anterior estable
```
