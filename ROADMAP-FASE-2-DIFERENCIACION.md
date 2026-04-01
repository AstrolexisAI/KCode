# Fase 2: Diferenciacion Real — Semanas 3-6

**Prioridad:** ESTRATEGICA
**Objetivo:** Construir features que Claude Code no tiene y pulir las que lo diferencian.
**Version target:** v2.0.0

**Prerequisito:** Fase 1 completada (linter, seguridad Pro, split de archivos, E2E tests)

---

## 2.1 Voice Input System

**Tiempo estimado:** 5-7 dias
**Impacto:** Alto — Claude Code lo tiene, KCode no. Feature de accesibilidad y wow-factor.

### Arquitectura propuesta

```
Microfono -> WebRTC/PortAudio -> Whisper local (o API) -> Texto -> Input del TUI
```

### Tareas

#### Backend de captura de audio
- [ ] Crear `src/core/voice/voice-capture.ts`:
  - Captura de audio via subprocess (`arecord` en Linux, `sox` cross-platform)
  - Buffer circular de audio (max 30 segundos por chunk)
  - Deteccion de silencio para auto-stop (threshold configurable)
  - Formato: WAV 16kHz 16-bit mono (optimo para Whisper)
- [ ] Detectar disponibilidad de microfono al inicio
- [ ] Manejar permisos de microfono gracefully (mensaje claro si no hay acceso)

#### Speech-to-Text (STT)
- [ ] Crear `src/core/voice/stt-engine.ts`:
  - **Modo local**: Whisper.cpp via subprocess (descargar modelo ggml)
    - Modelo recomendado: `whisper-base` (140MB) para balance velocidad/calidad
    - Modelo Pro: `whisper-large-v3` (3GB) para maxima precision
  - **Modo cloud**: OpenAI Whisper API como fallback
    - Endpoint: `POST https://api.openai.com/v1/audio/transcriptions`
    - Usa la API key de OpenAI si esta configurada
  - **Modo hibrido**: Local primero, cloud si falla
- [ ] Streaming STT para feedback en tiempo real (mostrar texto parcial mientras habla)
- [ ] Soporte multilenguaje (auto-detectar idioma o configurar en settings)

#### Integracion con TUI
- [ ] Crear `src/ui/VoiceIndicator.tsx`:
  - Indicador visual de "grabando" (icono de microfono pulsante)
  - Barra de nivel de audio en tiempo real
  - Texto parcial mientras se transcribe
  - Keybinding: `Ctrl+V` para toggle voice (o configurable)
- [ ] Crear `src/core/voice/voice-commands.ts`:
  - Comandos de voz especiales: "enviar", "cancelar", "nuevo parrafo"
  - Mappeo de comandos de voz a slash commands: "ejecutar commit" -> `/commit`
- [ ] Integrar output de STT con el input buffer del TUI
- [ ] Agregar a settings:
  ```json
  {
    "voice": {
      "enabled": false,
      "engine": "local",
      "model": "whisper-base",
      "language": "auto",
      "keybinding": "ctrl+v",
      "silenceThreshold": 2000,
      "maxDuration": 30000
    }
  }
  ```

#### Tests
- [ ] Unit test: deteccion de silencio
- [ ] Unit test: conversion audio -> texto con mock
- [ ] Unit test: voice commands parsing
- [ ] Integration test: captura -> STT -> input buffer
- [ ] E2E test: `/voice` toggle activa/desactiva

#### Documentacion
- [ ] Agregar seccion "Voice Input" al README
- [ ] Documentar requisitos: `sox` o `arecord` instalado, microfono disponible
- [ ] Documentar modelos Whisper disponibles y como descargarlos via `kcode setup`

### Criterio de aceptacion
- Voice input funciona en Linux y macOS
- Latencia < 2 segundos entre fin de habla y texto disponible (modo local)
- Funciona offline con Whisper local
- Keybinding configurable

---

## 2.2 Offline Model Management (Killer Feature)

**Tiempo estimado:** 5-6 dias
**Impacto:** CRITICO — es la feature que justifica la existencia de KCode vs Claude Code

### Estado actual
- `model-manager.ts` ya detecta hardware y recomienda modelos
- `llama-server.ts` maneja el lifecycle del servidor local
- Falta: UX pulida, catalogo curado, one-click setup

### Tareas

#### Catalogo curado de modelos
- [ ] Crear `src/core/model-catalog.ts`:
  ```typescript
  interface CatalogedModel {
    id: string;                    // "qwen2.5-coder-32b"
    name: string;                  // "Qwen 2.5 Coder 32B"
    provider: "gguf" | "ollama" | "mlx";
    sizes: ModelSize[];            // Variantes de quantizacion
    minVram: number;               // VRAM minima en GB
    recommendedVram: number;       // VRAM recomendada
    codingScore: number;           // 1-10 para coding tasks
    generalScore: number;          // 1-10 para tareas generales
    toolCallSupport: "native" | "text-pattern" | "none";
    contextWindow: number;
    downloadUrl: string;
    sha256: string;                // Verificacion de integridad
    license: string;
    notes: string;
  }
  ```
- [ ] Catalogo inicial con modelos probados:
  - **Tier 1 (recomendados)**: Qwen 2.5 Coder 32B, DeepSeek Coder V2, CodeLlama 34B
  - **Tier 2 (buenos)**: Mistral Large, Llama 3.1 70B, Phi-3 Medium
  - **Tier 3 (ligeros)**: Qwen 2.5 Coder 7B, CodeLlama 7B, Phi-3 Mini
  - **Tier Apple Silicon**: MLX versions de los anteriores
- [ ] Auto-seleccion basada en VRAM disponible:
  - < 8GB VRAM: Tier 3 con Q4_K_M
  - 8-16GB VRAM: Tier 2 con Q5_K_M
  - 16-24GB VRAM: Tier 1 con Q5_K_M
  - 24GB+ VRAM: Tier 1 con Q6_K o FP16
  - Multi-GPU: Distribuir layers entre GPUs

#### Wizard interactivo mejorado
- [ ] Crear `src/ui/ModelWizard.tsx`:
  - Paso 1: Detectar hardware (GPU, VRAM, RAM, disk space)
  - Paso 2: Mostrar modelos compatibles rankeados por score
  - Paso 3: Seleccionar modelo con preview de specs
  - Paso 4: Descargar con barra de progreso real
  - Paso 5: Verificar integridad (SHA256)
  - Paso 6: Configurar y arrancar servidor
  - Paso 7: Test rapido (enviar prompt simple, verificar respuesta)
- [ ] Soporte para Ollama como alternativa:
  ```bash
  # Si Ollama esta instalado, ofrecer como opcion
  ollama pull qwen2.5-coder:32b
  ```
- [ ] Resume de descargas interrumpidas (HTTP Range headers)
- [ ] Estimacion de tiempo de descarga basada en velocidad de red

#### CLI mejorado
- [ ] `kcode models catalog` — Mostrar catalogo completo con scores y compatibilidad
- [ ] `kcode models recommend` — Recomendacion personalizada basada en hardware
- [ ] `kcode models download <model>` — Descargar con progreso
- [ ] `kcode models verify <model>` — Verificar integridad SHA256
- [ ] `kcode models benchmark <model>` — Benchmark rapido (tokens/s, TTFT, calidad)
- [ ] `kcode models compare <model1> <model2>` — Comparar dos modelos side-by-side

#### Multi-GPU optimizado
- [ ] Detectar todas las GPUs disponibles (nvidia-smi, rocm-smi)
- [ ] Calcular distribucion optima de layers por GPU
- [ ] Generar config de llama.cpp con `--tensor-split` correcto
- [ ] Documentar setup multi-GPU (ej: 4090 + 5090)

### Criterio de aceptacion
- `kcode setup` lleva a un usuario de 0 a modelo funcionando en < 5 minutos
- Descarga con progreso y resume funciona
- Benchmark automatico post-descarga confirma que el modelo funciona
- Multi-GPU detectado y configurado automaticamente

---

## 2.3 IDE Plugins Maduros

**Tiempo estimado:** 5-7 dias
**Impacto:** Alto — muchos devs viven en el IDE, no en la terminal

### VS Code Extension

- [ ] Revisar y completar `vscode-extension/`:
  - Sidebar panel con chat embebido
  - Context menu: "Ask KCode about this code"
  - Inline suggestions (como Copilot pero via KCode)
  - Diff view para edits propuestos
  - Status bar: modelo activo, tokens usados, costo
  - Command palette: todos los slash commands disponibles
- [ ] Comunicacion via HTTP API (`src/core/http-server.ts`):
  - WebSocket para streaming de respuestas
  - REST para tool execution
  - Auth via token local
- [ ] Publicar en VS Code Marketplace (o Open VSX para usuarios de VSCodium)
- [ ] README de la extension con screenshots y GIFs

### JetBrains Plugin

- [ ] Revisar y completar `jetbrains-plugin/`:
  - Tool window con chat
  - Action: "Ask KCode" en context menu
  - Diff view nativo de JetBrains
  - Integration con terminal embebido
- [ ] Comunicacion via mismo HTTP API
- [ ] Publicar en JetBrains Marketplace

### Neovim Integration

- [ ] Crear `nvim-kcode/` (Lua plugin):
  - Comandos: `:KCode <prompt>`, `:KCodeEdit`, `:KCodeExplain`
  - Floating window para respuestas
  - Integration con telescope.nvim para file selection
  - Comunicacion via HTTP API o stdio
- [ ] Documentar en README

### Criterio de aceptacion
- VS Code extension instalable desde Marketplace
- JetBrains plugin instalable desde Marketplace
- Neovim plugin disponible via lazy.nvim / packer
- Todas las integraciones usan el mismo HTTP API backend

---

## 2.4 Dashboard Web Mejorado

**Tiempo estimado:** 4-5 dias
**Impacto:** Medio-Alto — selling point visual, diferenciador para demos

### Estado actual
- `src/web/` tiene React SPA con Vite
- `kcode web` arranca el dashboard

### Tareas

- [ ] **Session viewer**: Ver conversaciones pasadas con syntax highlighting
- [ ] **Real-time monitoring**: WebSocket feed del conversation loop activo
  - Tokens in/out en tiempo real
  - Tool calls con resultado
  - Costo acumulado
- [ ] **Model dashboard**:
  - Modelos instalados con specs
  - GPU utilization en tiempo real (nvidia-smi polling)
  - VRAM usage
  - Tokens/segundo
- [ ] **Analytics dashboard**:
  - Graficas de uso: tokens/dia, costo/dia, herramientas mas usadas
  - Comparacion de modelos (cual es mas rapido, cual genera mejor codigo)
  - Session history timeline
- [ ] **Configuration UI**:
  - Editor visual de settings.json
  - Model switcher con drag-and-drop para fallback chain
  - Permission rules editor
  - Plugin manager
- [ ] **Mobile responsive**: Que funcione en tablet/telefono para monitoreo remoto
- [ ] **Dark/light theme**: Respetar preferencia del sistema

### Criterio de aceptacion
- `kcode web` abre dashboard funcional con real-time data
- Dashboard muestra metricas utiles de GPU y tokens
- Funciona en mobile para monitoreo remoto

---

## 2.5 Documentacion para Usuarios

**Tiempo estimado:** 3-4 dias
**Impacto:** CRITICO para ventas — sin docs no hay adopcion

### Tareas

- [ ] **Docs site** (usar Astro, Docusaurus, o VitePress):
  - Getting Started (5 min quickstart)
  - Installation (Homebrew, binary, source)
  - Configuration reference
  - Tool reference (las 46+ tools)
  - Slash command reference (152+ commands)
  - API reference (HTTP server)
  - Plugin development guide
  - FAQ
- [ ] **Tutorials**:
  - "Tu primer proyecto con KCode y un modelo local"
  - "Migrando de Claude Code a KCode"
  - "Configurando multi-GPU para desarrollo"
  - "Creando tu primer plugin"
  - "KCode para equipos: setup enterprise"
- [ ] **Video demos** (grabacion de terminal con asciinema o similar):
  - Setup desde cero (hardware detection -> modelo descargado -> primera conversacion)
  - Workflow completo: bug fix con KCode
  - Multi-agent swarm en accion
  - Comparacion lado a lado con Claude Code
- [ ] **CHANGELOG.md** con formato Keep a Changelog
- [ ] **CONTRIBUTING.md** expandido con:
  - Setup de desarrollo
  - Guia de arquitectura
  - Como agregar un nuevo tool
  - Como agregar un nuevo slash command
  - Code review checklist

### Criterio de aceptacion
- Docs site deployado y accesible publicamente
- Quickstart funciona en < 5 minutos para un usuario nuevo
- Al menos 3 tutorials completos
- Al menos 2 video demos

---

## 2.6 Telemetria Opt-in

**Tiempo estimado:** 2-3 dias
**Impacto:** Medio — necesario para entender adoption y priorizar features

### Tareas

- [ ] Crear `src/core/telemetry-client.ts`:
  - **100% opt-in**: Preguntar en primer uso, recordar decision
  - Datos anonimos: session count, tool usage frequency, model used, OS, hardware tier
  - **Nunca enviar**: prompts, respuestas, codigo, file paths, API keys
  - Endpoint: `https://kulvex.ai/api/telemetry`
  - Batch envio: acumular local, enviar cada 24h
  - Mostrar exactamente que se envia antes de pedir consentimiento
- [ ] Settings:
  ```json
  {
    "telemetry": {
      "enabled": false,
      "showData": true
    }
  }
  ```
- [ ] `/telemetry` slash command para ver/toggle estado
- [ ] Respetar `DO_NOT_TRACK` env var (estandar)
- [ ] Dashboard interno para visualizar telemetria agregada

### Criterio de aceptacion
- Opt-in explicitamente (default: off)
- `kcode doctor` muestra estado de telemetria
- No se envia ningun dato sin consentimiento
- DO_NOT_TRACK=1 deshabilita completamente

---

## Entregables Fase 2

| Entregable | Version | Estado |
|---|---|---|
| Voice input (local + cloud STT) | v1.10.0 | [ ] |
| Model catalog + wizard mejorado | v1.11.0 | [ ] |
| VS Code extension en Marketplace | v1.12.0 | [ ] |
| JetBrains plugin en Marketplace | v1.12.0 | [ ] |
| Neovim plugin | v1.12.0 | [ ] |
| Dashboard web mejorado | v1.13.0 | [ ] |
| Docs site publico | v1.14.0 | [ ] |
| Telemetria opt-in | v1.14.0 | [ ] |
| **Release mayor** | **v2.0.0** | [ ] |

**Al final de Fase 2:** KCode tiene features unicas que Claude Code no ofrece, documentacion profesional, y presencia en los marketplaces de IDE.
