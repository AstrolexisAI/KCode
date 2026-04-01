# Fase 1: Estabilizacion — Semanas 1-2

**Prioridad:** CRITICA
**Objetivo:** Convertir el prototipo funcional en una base de codigo mantenible, segura y contribuible.
**Version target:** v1.9.0

---

## 1.1 Configurar Linter y Formatter

**Tiempo estimado:** 2-3 dias
**Impacto:** Alto — sin esto, ningun contribuidor externo puede mantener calidad

### Tareas

- [ ] Instalar Biome como linter + formatter (mas rapido que ESLint + Prettier, compatible con Bun)
  ```bash
  bun add -d @biomejs/biome
  bunx biome init
  ```
- [ ] Configurar `biome.json` con reglas strict:
  - `recommended: true` para linting
  - Formatter: tabs o spaces (elegir uno y aplicar)
  - Organizar imports automaticamente
  - Prohibir `any` explicito en codigo nuevo
  - Prohibir `console.log` (usar logger estructurado)
- [ ] Agregar scripts a `package.json`:
  ```json
  {
    "lint": "biome check src/",
    "lint:fix": "biome check --write src/",
    "format": "biome format --write src/"
  }
  ```
- [ ] Ejecutar `biome check --write src/` para fix masivo inicial
- [ ] Agregar al CI pipeline (`.github/workflows/build.yml`):
  ```yaml
  - name: Lint
    run: bun run lint
  ```
- [ ] Crear pre-commit hook (via `.kcode/hooks/` o husky) que corra `biome check --write` en archivos staged

### Criterio de aceptacion
- `bun run lint` pasa sin errores en CI
- Todo PR nuevo falla si no cumple las reglas

---

## 1.2 Auditoria de Seguridad del Sistema Pro

**Tiempo estimado:** 3-4 dias
**Impacto:** CRITICO — el sistema de licencias es el revenue gate

### Analisis de vulnerabilidades actuales

El sistema actual en `src/core/pro.ts` tiene:
- HMAC cache en `~/.kcode/pro-cache.json` — si alguien descubre el secret, genera caches validos infinitos
- Grace period offline — puede ser abusado desconectando la red
- Key format predecible (`kcode_pro_*` / `klx_lic_*`) — facilita brute force
- Sin certificate pinning en la validacion contra `kulvex.ai`

### Tareas

- [ ] **Ofuscar el HMAC secret** — No debe estar en plaintext en el source. Opciones:
  - Derivar del hardware ID + timestamp
  - Usar key rotation (secret cambia por version)
- [ ] **Certificate pinning** para `https://kulvex.ai/api/pro/validate`:
  - Verificar fingerprint del cert del servidor
  - Rechazar conexiones si el cert no coincide (previene MITM)
- [ ] **Rate limiting client-side** en validacion:
  - Max 1 validacion cada 5 minutos
  - Backoff exponencial si falla
- [ ] **Expirar cache agresivamente**:
  - Cache valido max 24h (no 7 dias)
  - Invalidar cache si cambia el hardware ID
  - Firmar cache con hardware fingerprint
- [ ] **Anti-tampering del binario**:
  - Checksum del binario en runtime
  - Detectar si `pro.ts` fue patcheado
- [ ] **Key format mas robusto**:
  - Incluir checksum en la key (como numeros de tarjeta de credito)
  - Agregar version de key para poder rotar
- [ ] **Logging de intentos fallidos**:
  - Log local de validaciones fallidas
  - Telemetria anonima de intentos de pirateria (opt-in)
- [ ] **Tests de seguridad**:
  - Test: cache expirado no da acceso
  - Test: cache con HMAC invalido es rechazado
  - Test: key con checksum incorrecto falla
  - Test: validacion con cert incorrecto falla
  - Test: grace period no excede 24h

### Criterio de aceptacion
- No es posible generar un cache Pro valido sin contactar el servidor
- Grace period maximo de 24h
- Key format incluye checksum de validacion

---

## 1.3 Split de Archivos Grandes

**Tiempo estimado:** 3-4 dias
**Impacto:** Alto — archivos >1000 lineas son inmantenibles y diff-hostiles

### Archivos a dividir

#### `conversation.ts` (1,937 lineas) -> 5 modulos

| Nuevo modulo | Responsabilidad | Lineas estimadas |
|---|---|---|
| `conversation.ts` | Loop principal y orquestacion | ~400 |
| `conversation-streaming.ts` | SSE streaming, delta accumulation, provider dispatch | ~350 |
| `conversation-tools.ts` | Tool call extraction (nativo + text patterns), validation, parallel exec | ~350 |
| `conversation-context.ts` | Context window management, pruning, compaction trigger | ~300 |
| `conversation-retry.ts` | Retry logic, exponential backoff, model fallback chain, loop detector | ~250 |

- [ ] Extraer streaming logic (SSE, chunks, provider-specific parsing)
- [ ] Extraer tool call extraction y validation
- [ ] Extraer context window management y pruning
- [ ] Extraer retry/fallback logic
- [ ] Mantener `conversation.ts` como orchestrator que importa los modulos
- [ ] Actualizar todos los imports en el proyecto
- [ ] Verificar que todos los tests siguen pasando

#### `system-prompt.ts` (1,202 lineas) -> 3 modulos

| Nuevo modulo | Responsabilidad |
|---|---|
| `system-prompt.ts` | Orchestrator: ensambla las 10 capas |
| `system-prompt-layers.ts` | Definicion de cada capa individual |
| `system-prompt-loaders.ts` | Carga de archivos externos (identity.md, awareness/*.md, KCODE.md, rules/*.md) |

- [ ] Extraer definiciones de capas a modulo propio
- [ ] Extraer logica de carga de archivos
- [ ] Tests para cada capa individualmente

#### `builtin-skills.ts` (1,355 lineas) -> Por categoria

| Nuevo modulo | Skills |
|---|---|
| `skills/code-skills.ts` | /commit, /review-pr, /diff, /lint, /build, /test |
| `skills/search-skills.ts` | /search, /find-bug, /security-review, /explain |
| `skills/session-skills.ts` | /plan, /compact, /rewind, /resume, /export, /stats |
| `skills/config-skills.ts` | /cloud, /toggle, /theme, /vim, /style, /doctor |
| `skills/index.ts` | Re-exporta todo como array unificado |

- [ ] Agrupar skills por categoria funcional
- [ ] Crear indice que las re-exporte
- [ ] Verificar que slash commands siguen funcionando

#### `model-manager.ts` (1,283 lineas) -> 3 modulos

| Nuevo modulo | Responsabilidad |
|---|---|
| `model-manager.ts` | Orchestrator del wizard |
| `model-hardware.ts` | Deteccion de CPU/GPU/RAM, recomendaciones |
| `model-download.ts` | Descarga, verificacion, instalacion de modelos |

- [ ] Extraer deteccion de hardware
- [ ] Extraer logica de descarga
- [ ] Tests para cada plataforma (Linux, macOS, Windows)

### Criterio de aceptacion
- Ningun archivo .ts supera 800 lineas
- Todos los tests existentes siguen pasando
- `bun run build` genera binario funcional

---

## 1.4 Arreglar Tests Fallando

**Tiempo estimado:** 1 dia
**Impacto:** Medio — 12 tests en plugin SDK publish

### Tareas

- [ ] Diagnosticar los 12 tests fallando (race condition en tarball creation)
- [ ] Fix: agregar `await` correcto o mutex en la creacion del tarball
- [ ] Si el fix es complejo, marcar como `test.skip()` con TODO y crear issue
- [ ] Verificar: `bun test` reporta 0 failures
- [ ] Agregar al CI: fallar el build si hay tests fallando (strict mode)

### Criterio de aceptacion
- `bun test` = 0 failures
- CI falla si cualquier test falla

---

## 1.5 E2E Test Suite

**Tiempo estimado:** 4-5 dias
**Impacto:** Alto — solo 1 archivo E2E actual (http-server)

### Tests E2E a crear

#### `src/core/conversation-e2e.test.ts`
- [ ] Test: conversation loop completa (prompt -> response -> tool call -> response)
- [ ] Test: streaming funciona con mock server OpenAI-compatible
- [ ] Test: context pruning se activa al 80% de capacidad
- [ ] Test: retry logic funciona con server intermitente
- [ ] Test: max 25 tool turns se respeta
- [ ] Test: parallel tool execution funciona correctamente

#### `src/core/tool-executor-e2e.test.ts`
- [ ] Test: Read tool lee archivo real del filesystem
- [ ] Test: Write tool crea archivo y Undo lo revierte
- [ ] Test: Edit tool aplica diff correctamente
- [ ] Test: Bash tool ejecuta comando y retorna output
- [ ] Test: Glob tool encuentra archivos por patron
- [ ] Test: Grep tool busca contenido correctamente
- [ ] Test: tool con timeout se cancela correctamente
- [ ] Test: tool con permisos denegados no ejecuta

#### `src/core/session-e2e.test.ts`
- [ ] Test: sesion se guarda y se puede resumir
- [ ] Test: compaction preserva informacion critica
- [ ] Test: plan mode crea/actualiza/completa plan
- [ ] Test: checkpoint y rewind funcionan

#### `src/core/pro-e2e.test.ts`
- [ ] Test: usuario free no puede usar features Pro
- [ ] Test: usuario Pro con key valida accede a features
- [ ] Test: key expirada bloquea acceso
- [ ] Test: cache offline funciona dentro del grace period
- [ ] Test: cache expirado bloquea acceso

#### `src/core/mcp-e2e.test.ts`
- [ ] Test: MCP server se conecta y registra tools
- [ ] Test: MCP tool se ejecuta correctamente
- [ ] Test: MCP server desconectado se maneja gracefully

### Infraestructura de testing

- [ ] Crear `src/test-harness/mock-llm-server.ts`:
  - Servidor HTTP que simula `/v1/chat/completions` con SSE
  - Respuestas configurables (text, tool_calls, errors)
  - Simular latencia y desconexiones
- [ ] Crear `src/test-harness/test-workspace.ts`:
  - Crea directorio temporal con archivos de prueba
  - Cleanup automatico despues de cada test
  - Git repo inicializado para tests de git tools
- [ ] Agregar al CI con timeout de 5 minutos para E2E

### Criterio de aceptacion
- 30+ tests E2E cubriendo los 5 subsistemas criticos
- Todos pasan en CI en < 5 minutos
- Mock LLM server reutilizable para futuros tests

---

## 1.6 Code Review y Limpieza

**Tiempo estimado:** 3-4 dias (paralelo con otras tareas)
**Impacto:** Alto — 295K lineas en 20 dias requiere inspeccion

### Areas prioritarias

- [ ] **Codigo muerto**: Buscar funciones exportadas que no se importan en ningun otro archivo
  ```bash
  # Para cada export, verificar si tiene al menos 1 import
  ```
- [ ] **Duplicacion**: Buscar bloques de codigo repetidos (>10 lineas identicas)
- [ ] **Patrones inseguros generados por IA**:
  - `eval()` o `Function()` — eliminar completamente
  - `child_process.exec()` sin sanitizar — usar `execFile()` con array de args
  - SQL sin parametrizar — verificar todo acceso a SQLite
  - `JSON.parse()` sin try/catch en input externo
  - `fs.readFileSync` / `fs.writeFileSync` — migrar a `Bun.file()`
- [ ] **Error handling inconsistente**:
  - Buscar `catch (e) {}` vacios (swallow errors)
  - Buscar `catch (e) { console.log(e) }` — debe usar logger
  - Verificar que errores criticos llegan al usuario
- [ ] **Dependencias fantasma**: Verificar que no hay imports de paquetes no declarados en package.json
- [ ] **Tipos debiles**: Buscar `as any`, `// @ts-ignore`, `// @ts-expect-error` — documentar o eliminar

### Criterio de aceptacion
- 0 instancias de `eval()` o `Function()`
- 0 SQL sin parametrizar
- 0 `catch {}` vacios
- Reduccion de al menos 5% de LoC por codigo muerto eliminado

---

## Entregables Fase 1

| Entregable | Version | Estado |
|---|---|---|
| Biome configurado + CI integrado | v1.8.1 | [ ] |
| Sistema Pro hardened | v1.8.2 | [ ] |
| Archivos grandes divididos | v1.8.3 | [ ] |
| 0 tests fallando | v1.8.4 | [ ] |
| E2E test suite (30+ tests) | v1.8.5 | [ ] |
| Code review + limpieza | v1.9.0 | [ ] |

**Al final de Fase 1:** Base de codigo lista para contribuidores externos, segura para produccion, con test coverage E2E.
