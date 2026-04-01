# Fase 5: Escala — Mes 5 en adelante

**Prioridad:** CRECIMIENTO
**Objetivo:** Escalar equipo, plataformas, integraciones y market share.
**Version target:** v3.0.0

**Prerequisito:** Fases 1-4 completadas (estabilidad, diferenciacion, monetizacion, moat tecnico)

---

## 5.1 Escalar el Equipo

**Impacto:** CRITICO — bus factor = 1 es insostenible para un producto comercial

### Roles prioritarios

#### Hire 1: Backend/Core Engineer
- **Perfil**: 3+ years TypeScript, experiencia con LLMs, familiar con llama.cpp o similar
- **Responsabilidades**:
  - Mantener conversation loop y tool execution
  - Optimizar performance (streaming, context management)
  - Implementar nuevas features core
  - Code review de contribuciones externas
- **Donde buscar**: r/LocalLLaMA, LLM Discord communities, Hacker News "Who is Hiring"
- **Compensacion**: Equity + salario competitivo, o revenue share

#### Hire 2: Frontend/DevTools Engineer
- **Perfil**: React, VS Code extension development, terminal UI
- **Responsabilidades**:
  - Mantener IDE plugins (VS Code, JetBrains, Neovim)
  - Mejorar web dashboard
  - TUI improvements
  - Design system y temas
- **Donde buscar**: VS Code extension community, React communities

#### Hire 3: DevRel / Community Manager
- **Perfil**: Developer background, buena comunicacion, experiencia con open source
- **Responsabilidades**:
  - Moderar Discord/GitHub Discussions
  - Escribir blog posts, tutorials, videos
  - Responder issues y PRs de la comunidad
  - Eventos: conferencias, meetups, livestreams
  - Social media

### Tareas

- [ ] Escribir job descriptions claras con expectativas y compensacion
- [ ] Publicar en: Hacker News, r/LocalLLaMA, LinkedIn, comunidades de TypeScript
- [ ] Setup: onboarding doc, dev environment guide, architecture walkthrough
- [ ] Definir proceso de contribucion: PR review, merge criteria, release cadence
- [ ] Herramientas de equipo: Linear/GitHub Projects, Slack/Discord interno
- [ ] Considerar modelo open-core con contribuidores pagados por bounties

### Criterio de aceptacion
- Al menos 2 personas adicionales contribuyendo regularmente
- Bus factor >= 3 para componentes criticos
- Onboarding de nuevo contributor en < 1 dia

---

## 5.2 Windows Support Nativo

**Tiempo estimado:** 10-14 dias
**Impacto:** Alto — Windows es ~45% del mercado developer

### Estado actual
- CI compila para Linux y macOS solamente
- Bun tiene soporte Windows (experimental pero funcional)
- No hay PowerShell tool

### Tareas

#### Core compatibility
- [ ] Auditar todo el codebase por Unix-only patterns:
  - Paths con `/` hardcoded -> usar `path.join()`
  - `chmod` / `chown` -> condicional por OS
  - Symlinks -> usar junctions en Windows
  - `/dev/null` -> `NUL` en Windows
  - `HOME` env var -> `USERPROFILE` en Windows
  - Signal handling (SIGTERM, SIGHUP) -> Windows equivalents

- [ ] Crear `src/tools/powershell.ts`:
  - Ejecutar PowerShell commands (equivalente a Bash tool)
  - Safety analysis adaptada a PowerShell (detectar `Remove-Item -Recurse -Force`, etc.)
  - Auto-detectar si usar Bash (WSL/Git Bash) o PowerShell

- [ ] GPU detection para Windows:
  - NVIDIA: `nvidia-smi` (funciona igual)
  - AMD: `dxdiag` o `wmic`
  - Adaptar `gpu-orchestrator.ts`

#### Build y distribucion
- [ ] Agregar target Windows x64 al CI:
  ```yaml
  - os: windows-latest
    target: bun-windows-x64
  ```
- [ ] Crear instalador:
  - **winget**: `winget install kulvex.kcode`
  - **Scoop**: Bucket con manifest
  - **Chocolatey**: Package con nupkg
  - **MSI installer**: Para enterprise (Group Policy deployable)
  - **Portable .zip**: Extraer y ejecutar

- [ ] Path setup automatico:
  - Agregar al PATH del usuario durante instalacion
  - Shell completions para PowerShell

#### Testing
- [ ] CI: tests corriendo en Windows (GitHub Actions `windows-latest`)
- [ ] Test matrix: Windows 10, Windows 11, Windows Server 2022
- [ ] Test WSL integration: detectar WSL y ofrecer usar Linux tools

### Criterio de aceptacion
- `kcode` funciona en Windows 10/11 sin WSL
- Instalacion via winget en < 2 minutos
- Todos los tools core funcionan (incluyendo Bash via Git Bash o PowerShell)
- Tests pasan en CI de Windows

---

## 5.3 Mobile Companion App

**Tiempo estimado:** 10-14 dias
**Impacto:** Medio — diferenciador unico, monitoreo remoto

### Concepto
App movil (React Native o PWA) para:
- Monitorear sesiones KCode remotas
- Recibir notificaciones cuando tareas terminan
- Revisar y aprobar tool calls remotamente
- Ver analytics y costos

### Tareas

#### Opcion A: PWA (recomendado para v1)
- [ ] El web dashboard (`kcode web`) ya es responsive (Fase 2)
- [ ] Agregar manifest.json para installable PWA
- [ ] Push notifications via Web Push API
- [ ] Offline-first con service worker
- [ ] Tunnel seguro: `kcode serve --remote` con autenticacion

#### Opcion B: React Native (v2 si hay demanda)
- [ ] Crear app con Expo
- [ ] Pantallas: Sessions, Analytics, Settings, Notifications
- [ ] Comunicacion via WebSocket con `kcode serve`

#### Remote approval system
- [ ] Cuando KCode pide permiso para un tool y el usuario no esta en la terminal:
  - Enviar push notification al mobile
  - Mostrar detalle del tool call
  - Botones: Approve / Deny / Always Allow
  - Timeout configurable (default: 5 minutos)
- [ ] Requiere: conexion autenticada entre mobile y KCode instance

### Criterio de aceptacion
- PWA instalable que muestra sesiones activas
- Push notifications funcionan para tool approvals
- Remote approval funciona con latencia < 3 segundos

---

## 5.4 API Publica

**Tiempo estimado:** 5-7 dias
**Impacto:** Alto — permite integraciones de terceros

### Estado actual
- `http-server.ts` existe pero es para IDE integration
- Necesita: documentacion, rate limiting, auth publica, versionado

### Tareas

- [ ] API v1 documentada con OpenAPI spec:
  ```
  POST /api/v1/sessions          — Crear sesion
  GET  /api/v1/sessions/:id      — Estado de sesion
  POST /api/v1/sessions/:id/send — Enviar mensaje
  GET  /api/v1/sessions/:id/stream — SSE stream de respuestas
  POST /api/v1/tools/:name       — Ejecutar tool directamente
  GET  /api/v1/models            — Listar modelos disponibles
  GET  /api/v1/stats             — Estadisticas de uso
  ```
- [ ] Autenticacion: API key local (generada por `kcode serve --generate-key`)
- [ ] Rate limiting: configurable en settings
- [ ] CORS: configurable para web clients
- [ ] WebSocket endpoint para streaming bidireccional
- [ ] SDK clientes:
  - `@kulvex/kcode-sdk` (TypeScript/JavaScript)
  - `kcode-sdk` (Python)
- [ ] Swagger UI en `http://localhost:PORT/docs`

### Criterio de aceptacion
- API documentada con OpenAPI spec
- SDK de TypeScript y Python publicados
- Swagger UI funcional
- Rate limiting y auth implementados

---

## 5.5 Model Certification Program

**Tiempo estimado:** 3-5 dias
**Impacto:** Medio — marketing + confianza del usuario

### Concepto
"KCode Certified" badge para modelos que pasan un benchmark de compatibilidad.

### Tareas

- [ ] Crear benchmark de certificacion (`benchmarks/certification/`):
  - **Tool calling**: El modelo puede extraer tool calls correctamente (10/10 tests)
  - **Code generation**: Genera codigo funcional (8/10 tests)
  - **Instruction following**: Sigue system prompt correctamente (8/10 tests)
  - **Context handling**: Maneja contexto largo sin degradar (6/10 tests)
  - **Safety**: Respeta permission boundaries (10/10 tests)

- [ ] Niveles de certificacion:
  - **Gold**: Pasa 45+/50 tests, tool calling nativo, >95% code quality
  - **Silver**: Pasa 35+/50 tests, tool calling texto, >85% code quality
  - **Bronze**: Pasa 25+/50 tests, funcional pero con limitaciones

- [ ] Pagina `kulvex.ai/certified-models` con:
  - Lista de modelos certificados con nivel
  - Scores detallados por categoria
  - Hardware recomendado para cada modelo
  - Download links

- [ ] Automatizar: `kcode benchmark --certify <model>` corre el suite completo

### Criterio de aceptacion
- Al menos 10 modelos certificados al lanzar
- Benchmark reproducible y automatizado
- Pagina publica con resultados

---

## 5.6 Partnerships y Co-marketing

**Impacto:** Alto para crecimiento — acceso a audiencias existentes

### Targets

- [ ] **Ollama team**:
  - KCode como "recommended UI" para Ollama
  - Deep integration: `kcode setup --ollama` (auto-detectar modelos instalados)
  - Blog post conjunto: "The best way to use Ollama for coding"

- [ ] **llama.cpp community**:
  - Contribuir optimizaciones upstream
  - Blog post: "Optimal llama.cpp settings for coding with KCode"
  - Benchmark comparisons

- [ ] **Hugging Face**:
  - Modelos certificados en HF hub con tag "kcode-certified"
  - Integration: `kcode models install hf://user/model`
  - Spaces demo

- [ ] **GPU vendors (NVIDIA, AMD)**:
  - Developer program: acceso a hardware para testing
  - Blog post: "Getting the most out of your RTX 5090 with KCode"
  - Case study de multi-GPU coding

- [ ] **Hosting providers**:
  - RunPod, Vast.ai, Lambda: KCode pre-instalado en GPU instances
  - Template: "KCode + Qwen 2.5 Coder" one-click deploy

### Criterio de aceptacion
- Al menos 2 partnerships activas
- Co-branded content publicado
- Referral traffic medible desde partners

---

## 5.7 Internationalizacion (i18n)

**Tiempo estimado:** 5-7 dias
**Impacto:** Medio — acceso a mercados no-angloparlantes

### Estado actual
- `src/i18n/` existe pero contenido desconocido

### Tareas

- [ ] Implementar sistema i18n completo:
  - Extraer todas las strings de UI a archivos de traduccion
  - Formato: JSON por idioma (`en.json`, `es.json`, `pt.json`, etc.)
  - Auto-detectar idioma del sistema
  - Setting: `{ "language": "es" }`
- [ ] Traducciones prioritarias:
  - Espanol (mercado LATAM + Espana)
  - Portugues (Brasil)
  - Frances
  - Aleman
  - Japones
  - Chino simplificado
- [ ] NO traducir: tool names, slash commands, API endpoints
- [ ] Traducir: mensajes de error, help text, wizard, prompts interactivos
- [ ] `kcode --lang es` para override temporal

### Criterio de aceptacion
- KCode usable en espanol e ingles como minimo
- Switching de idioma sin reiniciar
- Contribuidores pueden agregar idiomas facilmente

---

## Entregables Fase 5

| Entregable | Version | Estado |
|---|---|---|
| Equipo de 3+ personas | ongoing | [ ] |
| Windows support completo | v2.6.0 | [ ] |
| Mobile PWA companion | v2.7.0 | [ ] |
| API publica documentada + SDKs | v2.8.0 | [ ] |
| Model certification program | v2.9.0 | [ ] |
| Partnerships (2+ activas) | ongoing | [ ] |
| Internationalizacion (3+ idiomas) | v3.0.0 | [ ] |

**Al final de Fase 5:** KCode es un producto multiplataforma con equipo, ecosystem, partnerships, y presencia global. Listo para competir seriamente en el mercado de AI coding assistants.

---

## Timeline Global

```
Semana  1-2:  Fase 1 — Estabilizacion (v1.9.0)
Semana  3-6:  Fase 2 — Diferenciacion (v2.0.0)
Semana  7-10: Fase 3 — Monetizacion (v2.1.0)
Semana 11-16: Fase 4 — Moat Tecnico (v2.5.0)
Mes    5+:    Fase 5 — Escala (v3.0.0)
```

## KPIs por Fase

| Fase | KPI Principal | Target |
|---|---|---|
| 1 | Test pass rate | 100% (0 failures) |
| 2 | Features unicas vs Claude Code | 5+ (voice, offline, multi-GPU, model wizard, RAG) |
| 3 | MRR (Monthly Recurring Revenue) | $500+/mo (26+ Pro users) |
| 4 | Plugin ecosystem | 20+ plugins en marketplace |
| 5 | Monthly Active Users | 1,000+ |
