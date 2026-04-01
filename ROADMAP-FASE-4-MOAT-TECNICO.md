# Fase 4: Moat Tecnico — Semanas 11-16

**Prioridad:** COMPETITIVO
**Objetivo:** Construir ventajas tecnicas dificiles de replicar.
**Version target:** v2.5.0

**Prerequisito:** Fases 1-3 completadas (estabilidad, diferenciacion, monetizacion)

---

## 4.1 RAG sobre Codebase (Vector Search Local)

**Tiempo estimado:** 7-10 dias
**Impacto:** Alto — transforma KCode de "chat con tools" a "motor de conocimiento de codigo"

### Problema actual
- `codebase-index.ts` usa SQLite FTS5 (text search)
- FTS5 es bueno para busquedas exactas pero malo para busquedas semanticas
- Ejemplo: buscar "funcion que maneja autenticacion" no encuentra `validateToken()` con FTS5

### Arquitectura propuesta

```
Archivos del proyecto
    |
    v
Tree-sitter parsing (extraer funciones, clases, imports)
    |
    v
Chunking inteligente (por funcion/clase, no por lineas)
    |
    v
Embedding local (nomic-embed-text via llama.cpp o Ollama)
    |
    v
SQLite vec0 extension (vector storage sin dependencias externas)
    |
    v
Query: embedding del prompt -> cosine similarity -> top-K chunks -> contexto del LLM
```

### Tareas

#### Parsing y chunking
- [ ] Crear `src/core/rag/code-chunker.ts`:
  - Usar tree-sitter para parsear archivos (ya hay tree-sitter-bash bundled)
  - Agregar parsers: TypeScript, Python, Go, Rust, Java, C/C++
  - Chunking por unidad semantica: funcion, clase, metodo, bloque de imports
  - Cada chunk incluye: filepath, line range, tipo (function/class/import), contenido
  - Chunks de max 512 tokens (optimo para embedding models)
  - Overlap de 50 tokens entre chunks contiguos

#### Embedding local
- [ ] Crear `src/core/rag/embedder.ts`:
  - Modelo: `nomic-embed-text-v1.5` (GGUF, ~260MB)
    - 768 dimensiones, 8K context
    - Descargable via `kcode models download nomic-embed`
  - Alternativa: Ollama embeddings API (`/api/embeddings`)
  - Fallback cloud: OpenAI `text-embedding-3-small` ($0.02/1M tokens)
  - Batch processing: embeddear hasta 32 chunks simultaneamente
  - Cache: no re-embeddear archivos sin cambios (checksum en DB)

#### Vector storage
- [ ] Crear `src/core/rag/vector-store.ts`:
  - Usar `sqlite-vec` (extension de SQLite para vectores)
    - No requiere servidor externo (Chroma, Pinecone, etc.)
    - Se integra con el SQLite existente (`awareness.db`)
  - Tabla: `code_vectors(id, filepath, line_start, line_end, chunk_type, content, embedding vec(768))`
  - Indices: por filepath, por chunk_type
  - Operaciones: insert, search (cosine similarity), delete by filepath

#### RAG pipeline
- [ ] Crear `src/core/rag/rag-engine.ts`:
  - **Indexacion**: En background al abrir sesion
    - Indexar archivos modificados desde ultima sesion
    - Priorizar: archivos abiertos recientemente > archivos en git diff > todo lo demas
    - Respetar .gitignore y .kcodeignore
    - Progress indicator: "Indexando proyecto... 45/230 archivos"
  - **Query**: Cuando el LLM necesita contexto
    - Embeddear la pregunta del usuario
    - Top-10 chunks por cosine similarity
    - Re-rank: ponderar por recencia de modificacion y proximidad al archivo actual
    - Inyectar chunks relevantes como contexto adicional en el system prompt
  - **Incremental**: Solo re-indexar archivos modificados
    - Watch filesystem changes (via `kcode watch` o fs.watch)
    - Invalidar embeddings de archivos cambiados

#### Integracion con conversation loop
- [ ] Modificar `conversation.ts` (o el modulo extraido en Fase 1):
  - Antes de enviar prompt al LLM, ejecutar RAG query
  - Agregar contexto relevante como mensaje de sistema
  - Formato: "Relevant code context:\n```filepath:L10-L45\n{code}\n```"
  - Budget: max 20% del context window para RAG context
  - Deduplicar: si el usuario ya pego el codigo, no duplicar via RAG

#### CLI y slash commands
- [ ] `kcode search --semantic "funcion de autenticacion"` — Busqueda semantica
- [ ] `/rag status` — Estado del indice (archivos indexados, size, ultima actualizacion)
- [ ] `/rag rebuild` — Forzar re-indexacion completa
- [ ] `/rag toggle` — Activar/desactivar RAG auto-context

### Criterio de aceptacion
- Busqueda semantica retorna resultados relevantes para queries en lenguaje natural
- Indexacion de proyecto de 1000 archivos en < 5 minutos
- Indexacion incremental de 1 archivo en < 2 segundos
- Funciona 100% offline con embedding model local
- No degrada performance del conversation loop (query < 500ms)

---

## 4.2 Multi-GPU Orchestration

**Tiempo estimado:** 4-5 dias
**Impacto:** Medio-Alto — diferenciador para power users con hardware potente

### Estado actual
- Deteccion de GPU basica en `model-manager.ts`
- llama.cpp soporta `--tensor-split` para distribuir entre GPUs

### Tareas

- [ ] Crear `src/core/gpu-orchestrator.ts`:
  - Deteccion completa de todas las GPUs:
    ```typescript
    interface GpuInfo {
      index: number;
      name: string;          // "NVIDIA GeForce RTX 5090"
      vram_total: number;    // En MB
      vram_free: number;
      compute_capability: string; // "9.0"
      driver_version: string;
      temperature: number;
      utilization: number;   // 0-100%
      power_draw: number;    // En watts
    }
    ```
  - Soporte: NVIDIA (nvidia-smi), AMD (rocm-smi), Apple (system_profiler)
  - Monitoreo en tiempo real (polling cada 5 segundos)

- [ ] **Auto-configuracion de tensor split**:
  - Calcular distribucion optima basada en VRAM libre de cada GPU
  - Ejemplo para 4090 (24GB) + 5090 (32GB):
    ```
    --tensor-split 0.43,0.57  (proporcional a VRAM)
    ```
  - Ajustar si una GPU tiene otros procesos usando VRAM

- [ ] **Modos de multi-GPU**:
  - **Split mode**: Un modelo grande distribuido entre GPUs (default)
  - **Parallel mode**: Modelos diferentes en cada GPU (main + embedding)
  - **Failover mode**: GPU secundaria como backup si la primaria se satura

- [ ] **Dashboard de GPU**:
  - En el web dashboard: graficas de VRAM, temperatura, utilizacion
  - En el TUI: status bar con GPU stats
  - Alerts: temperatura > 85C, VRAM > 95%

- [ ] **Benchmark multi-GPU**:
  - `kcode benchmark --multi-gpu` — Medir tokens/s en cada configuracion
  - Comparar: single GPU vs split vs parallel
  - Guardar resultados para auto-config futuro

### Criterio de aceptacion
- Setup multi-GPU automatico sin configuracion manual
- Distribucion optima de layers calculada en base a VRAM disponible
- Monitoreo de GPU visible en TUI y web dashboard

---

## 4.3 Model Fine-tuning Workflow

**Tiempo estimado:** 7-10 dias
**Impacto:** Alto — moat tecnico profundo, muy dificil de replicar

### Concepto
KCode aprende del feedback del usuario para mejorar sus respuestas con el tiempo.

### Tareas

#### Data collection
- [ ] Crear `src/core/training/data-collector.ts`:
  - Recolectar pares (prompt, response) donde el usuario acepto el resultado
  - Recolectar correcciones: cuando el usuario edita manualmente despues de una respuesta
  - Formato: JSONL compatible con fine-tuning de llama.cpp / Unsloth
  - Almacenar en `~/.kcode/training-data/` con rotacion (max 100MB)
  - **Privacy**: Solo recolectar si opt-in explicito
  - Anonimizar: reemplazar paths absolutos, usernames, API keys

#### Fine-tuning pipeline
- [ ] Crear `src/core/training/fine-tuner.ts`:
  - **Metodo 1: LoRA via Unsloth** (recomendado):
    - Requiere: Python + Unsloth instalado
    - KCode genera el script de training
    - Ejecutar como subprocess
    - Output: adapter LoRA (.gguf)
  - **Metodo 2: llama.cpp native fine-tune**:
    - Usar `llama-finetune` directamente
    - Mas simple, menos flexible
  - **Metodo 3: Ollama Modelfile**:
    - Crear Modelfile con system prompt + examples
    - No es fine-tuning real pero es facil

#### CLI integration
- [ ] `kcode teach collect` — Empezar a recolectar training data
- [ ] `kcode teach review` — Revisar datos recolectados, eliminar malos
- [ ] `kcode teach train` — Lanzar fine-tuning
- [ ] `kcode teach apply` — Cargar adapter LoRA en el modelo base
- [ ] `kcode teach benchmark` — Comparar modelo base vs fine-tuned

#### Guardrails
- [ ] Minimo 100 ejemplos antes de permitir fine-tuning
- [ ] Validacion de datos: rechazar duplicados, ejemplos muy cortos, datos corruptos
- [ ] Backup del modelo base antes de aplicar adapter
- [ ] Rollback facil si el fine-tuning empeora el modelo

### Criterio de aceptacion
- Pipeline completo: collect -> review -> train -> apply -> benchmark
- Fine-tuning de LoRA en < 2 horas con GPU consumer
- Mejora medible en benchmark despues de fine-tuning con 500+ ejemplos

---

## 4.4 Plugin Marketplace

**Tiempo estimado:** 5-7 dias
**Impacto:** Alto — ecosystem moat (mas plugins = mas usuarios = mas plugins)

### Tareas

#### Registry backend
- [ ] API en `https://kulvex.ai/api/plugins/`:
  - `GET /plugins` — Listar plugins publicados (filtro por categoria, search)
  - `GET /plugins/:id` — Detalle de plugin
  - `POST /plugins` — Publicar plugin (requiere cuenta)
  - `GET /plugins/:id/download` — Descargar plugin
  - `POST /plugins/:id/review` — Dejar review (1-5 estrellas)
- [ ] Plugin manifest validation:
  - Verificar `plugin.json` es valido
  - Escanear por patterns peligrosos (eval, exec, network calls no declarados)
  - Verificar licencia es compatible con AGPL
- [ ] Categorias: Tools, Themes, Skills, MCP Servers, Integrations

#### CLI integration
- [ ] `kcode plugin search <query>` — Buscar en marketplace
- [ ] `kcode plugin install <name>` — Instalar desde marketplace
- [ ] `kcode plugin publish` — Publicar plugin actual
- [ ] `kcode plugin update` — Actualizar plugins instalados
- [ ] `kcode plugin list --remote` — Ver plugins disponibles
- [ ] `/plugins` slash command con UI interactiva

#### Plugin SDK
- [ ] Crear `kcode-plugin-sdk` (paquete npm separado):
  - Template para nuevo plugin: `bunx create-kcode-plugin my-plugin`
  - Types para plugin.json manifest
  - Helpers para crear tools, skills, hooks
  - Testing utilities (mock conversation, mock tools)
  - Documentacion completa

#### Plugins seed (crear 5-10 plugins iniciales)
- [ ] **kcode-plugin-docker**: Tools para Docker (build, run, compose, logs)
- [ ] **kcode-plugin-aws**: Tools para AWS CLI (S3, EC2, Lambda)
- [ ] **kcode-plugin-kubernetes**: Tools para kubectl
- [ ] **kcode-plugin-database**: Tools para SQL (PostgreSQL, MySQL, SQLite)
- [ ] **kcode-plugin-api-testing**: Tools para HTTP testing (como Postman)

### Criterio de aceptacion
- Marketplace funcional con busqueda y categorias
- Al menos 5 plugins publicados y funcionando
- Plugin SDK permite crear un plugin nuevo en < 30 minutos

---

## 4.5 Enterprise Features

**Tiempo estimado:** 5-7 dias
**Impacto:** Alto para revenue — enterprise = contratos grandes

### Tareas

- [ ] **SSO (Single Sign-On)**:
  - SAML 2.0 support (para Okta, Azure AD, etc.)
  - OIDC support (para Google Workspace, Auth0)
  - Configuracion via `~/.kcode/enterprise.json`
  - Admin puede forzar SSO para todo el team

- [ ] **Audit log exportable**:
  - Exportar todos los tool calls en formato CSV/JSON
  - Campos: timestamp, user, tool, parameters, result_status, duration
  - Rango de fechas configurable
  - `kcode audit export --from 2026-03-01 --to 2026-04-01 --format json`

- [ ] **Compliance reports**:
  - Reporte de herramientas usadas y archivos modificados
  - Reporte de modelos usados (local vs cloud, cual API)
  - Reporte de datos enviados a cloud APIs (para compliance)
  - Formato PDF generado automaticamente

- [ ] **Admin console** (web):
  - Gestionar usuarios del team
  - Ver analytics agregados del team
  - Configurar politicas: tools permitidos, modelos permitidos
  - Forzar configuraciones (modelo default, permissions mode)

- [ ] **Policy enforcement**:
  - Admin puede bloquear tools especificos para el team
  - Admin puede forzar permission mode "ask" para operaciones destructivas
  - Admin puede requerir que ciertos archivos nunca se envien a cloud APIs
  - Politicas se distribuyen via settings centralizados

### Criterio de aceptacion
- SSO funciona con Okta y Google Workspace
- Audit log exportable en CSV y JSON
- Admin console muestra metricas del team

---

## 4.6 Benchmarks Publicos

**Tiempo estimado:** 3-4 dias
**Impacto:** Medio-Alto — prueba concreta de que KCode + local compite con cloud

### Tareas

- [ ] Crear benchmark suite en `benchmarks/`:
  - **Coding tasks**: Fix bugs, add features, refactor
  - **Tool usage**: File operations, search, git operations
  - **Context handling**: Large projects, many files
  - **Speed**: Time to first token, tokens/second, total time
  - **Cost**: Tokens used, API cost per task

- [ ] Ejecutar benchmarks con:
  - KCode + Qwen 2.5 Coder 32B (local, RTX 4090)
  - KCode + Qwen 2.5 Coder 32B (local, RTX 5090)
  - KCode + Qwen 2.5 Coder 32B (local, 4090 + 5090)
  - KCode + Claude 3.5 Sonnet (cloud)
  - KCode + GPT-4o (cloud)
  - KCode + DeepSeek Coder V2 (cloud)

- [ ] Publicar resultados en:
  - kulvex.ai/benchmarks (pagina dedicada con graficas)
  - GitHub README (tabla resumen)
  - Blog post con analisis detallado

- [ ] Automatizar: benchmark corre en CI con cada release

### Criterio de aceptacion
- Benchmark reproducible (instrucciones paso a paso)
- Resultados publicados con graficas comparativas
- Al menos 10 tasks de benchmark cubriendo diferentes categorias

---

## Entregables Fase 4

| Entregable | Version | Estado |
|---|---|---|
| RAG con vector search local | v2.2.0 | [ ] |
| Multi-GPU orchestration | v2.3.0 | [ ] |
| Fine-tuning workflow | v2.3.0 | [ ] |
| Plugin marketplace | v2.4.0 | [ ] |
| Enterprise features (SSO, audit, admin) | v2.4.0 | [ ] |
| Benchmarks publicos | v2.5.0 | [ ] |

**Al final de Fase 4:** KCode tiene ventajas tecnicas dificiles de replicar: RAG local, fine-tuning personalizado, ecosystem de plugins, y enterprise-ready.
