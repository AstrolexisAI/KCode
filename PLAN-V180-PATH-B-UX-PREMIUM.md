# Plan v1.8.0 — Camino B: UX Premium

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~12,000-15,000 LoC nuevas
**Filosofia:** KCode debe ser mas agradable de usar que cualquier competidor.
La interfaz debe ser bella, rapida, y poderosa.

---

## INDICE

1. [Feature B1: Web UI (TUI + Browser)](#feature-b1-web-ui)
2. [Feature B2: Real-time Collaboration](#feature-b2-real-time-collaboration)
3. [Feature B3: Visual Diff/Merge](#feature-b3-visual-diffmerge)
4. [Feature B4: Project Dashboard](#feature-b4-project-dashboard)
5. [Feature B5: Smart Templates](#feature-b5-smart-templates)
6. [Feature B6: Voice Mode Avanzado](#feature-b6-voice-mode-avanzado)

---

## Feature B1: Web UI (TUI + Browser)

### 1.1 Contexto

KCode solo tiene TUI (terminal). Muchos desarrolladores prefieren una interfaz web,
especialmente para:
- Ver diffs con syntax highlighting real
- Navegar archivos con tree view
- Copiar/pegar con facilidad
- Compartir sesiones con colegas (via URL)
- Usar en tablets/dispositivos sin terminal

La Web UI NO reemplaza la TUI. Es una interfaz alternativa que se conecta al
mismo backend via WebSocket.

### 1.2 Archivos Nuevos

```
src/
  web/
    server.ts                   (~300 lineas) - HTTP server + WebSocket
    server.test.ts              (~250 lineas)
    api.ts                      (~400 lineas) - REST API endpoints
    api.test.ts                 (~300 lineas)
    ws-handler.ts               (~250 lineas) - WebSocket message handler
    ws-handler.test.ts          (~200 lineas)
    static/
      index.html                (~100 lineas) - SPA shell
      app.js                    (~2000 lineas) - Vanilla JS app (NO framework)
      styles.css                (~500 lineas) - Estilos
      markdown.js               (~300 lineas) - Markdown renderer
      diff-viewer.js            (~400 lineas) - Diff viewer
      terminal-theme.css        (~150 lineas) - Temas de terminal
    types.ts                    (~80 lineas)
```

**Archivos a Modificar:**
- `src/index.ts` — agregar flag `--web` para iniciar server
- `src/core/conversation.ts` — emitir eventos via WebSocket ademas de UI
- `src/core/config.ts` — settings de web server

### 1.3 Arquitectura

```
┌────────────────────────┐     ┌────────────────────────┐
│   Terminal (TUI)       │     │   Browser (Web UI)     │
│   React/Ink            │     │   Vanilla JS           │
│                        │     │                        │
│  ┌──────────────────┐  │     │  ┌──────────────────┐  │
│  │ InputPrompt      │  │     │  │ Chat Input       │  │
│  │ MessageList      │  │     │  │ Message List     │  │
│  │ ToolTabs         │  │     │  │ Tool Panel       │  │
│  │ Header           │  │     │  │ Header           │  │
│  └──────────────────┘  │     │  └──────────────────┘  │
└──────────┬─────────────┘     └──────────┬─────────────┘
           │                              │
           │    ┌──────────────────┐      │
           └────┤  KCode Core      ├──────┘
                │                  │
                │  conversation.ts │
                │  tools           │
                │  config          │
                │  permissions     │
                └──────────────────┘
```

### 1.4 HTTP Server

```typescript
// src/web/server.ts

interface WebServerConfig {
  port: number;           // default: 19300
  host: string;           // default: '127.0.0.1' (solo local)
  auth: {
    enabled: boolean;     // default: true
    token: string;        // auto-generado
  };
  cors: boolean;          // default: false
  openBrowser: boolean;   // default: true
}

class WebServer {
  private connections: Set<ServerWebSocket> = new Set();

  async start(config: WebServerConfig): Promise<void> {
    Bun.serve({
      port: config.port,
      hostname: config.host,

      fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (url.pathname === '/ws') {
          const token = url.searchParams.get('token');
          if (config.auth.enabled && token !== config.auth.token) {
            return new Response('Unauthorized', { status: 401 });
          }
          if (server.upgrade(req)) return; // Upgraded
          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // REST API
        if (url.pathname.startsWith('/api/')) {
          return handleAPI(req, url);
        }

        // Static files
        return serveStatic(url.pathname);
      },

      websocket: {
        open: (ws) => this.connections.add(ws),
        close: (ws) => this.connections.delete(ws),
        message: (ws, msg) => this.handleMessage(ws, msg),
      },
    });

    // Abrir browser automaticamente
    if (config.openBrowser) {
      const url = `http://localhost:${config.port}?token=${config.auth.token}`;
      Bun.spawn(['xdg-open', url]); // Linux
    }
  }

  /** Broadcast evento a todos los clientes web */
  broadcast(event: WebEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.connections) {
      ws.send(data);
    }
  }
}
```

### 1.5 REST API

```typescript
// src/web/api.ts

// GET  /api/v1/session           - Info de sesion actual
// GET  /api/v1/messages          - Historial de mensajes
// POST /api/v1/messages          - Enviar mensaje
// GET  /api/v1/messages/:id      - Mensaje especifico
// POST /api/v1/cancel            - Cancelar respuesta actual
// GET  /api/v1/files             - Listar archivos del proyecto
// GET  /api/v1/files/:path       - Leer archivo
// GET  /api/v1/tools             - Listar tools disponibles
// GET  /api/v1/stats             - Estadisticas (tokens, costo, etc)
// GET  /api/v1/config            - Config actual (sin secrets)
// POST /api/v1/config            - Actualizar config
// GET  /api/v1/models            - Modelos disponibles
// POST /api/v1/model             - Cambiar modelo
// GET  /api/v1/plan              - Plan actual
// POST /api/v1/permission/:id    - Responder a permission request

async function handleAPI(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace('/api/v1/', '');

  switch (req.method + ' ' + path) {
    case 'GET session':
      return json({
        sessionId: getSessionId(),
        model: getCurrentModel(),
        tokensUsed: getTokenCount(),
        costUsd: getCost(),
        startedAt: getSessionStart(),
      });

    case 'POST messages':
      const { content } = await req.json();
      // Enviar al conversation loop (mismo que InputPrompt en TUI)
      await sendUserMessage(content);
      return json({ status: 'sent' });

    case 'GET messages':
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      return json(getMessages(offset, limit));

    // ... etc
  }
}
```

### 1.6 WebSocket Protocol

```typescript
// Eventos Server -> Client (broadcast)
type WebEvent =
  | { type: 'message.new'; data: { role: string; content: string; id: string } }
  | { type: 'message.delta'; data: { id: string; delta: string } }      // Streaming
  | { type: 'message.thinking'; data: { id: string; delta: string } }   // Extended thinking
  | { type: 'tool.start'; data: { id: string; name: string; input: any } }
  | { type: 'tool.result'; data: { id: string; output: string; error?: string } }
  | { type: 'permission.request'; data: { id: string; tool: string; input: any } }
  | { type: 'permission.resolved'; data: { id: string; allowed: boolean } }
  | { type: 'session.stats'; data: { tokens: number; cost: number } }
  | { type: 'model.changed'; data: { model: string } }
  | { type: 'compact.start'; data: {} }
  | { type: 'compact.done'; data: { strategy: string } };

// Eventos Client -> Server
type ClientEvent =
  | { type: 'message.send'; data: { content: string } }
  | { type: 'message.cancel'; data: {} }
  | { type: 'permission.respond'; data: { id: string; allowed: boolean; always?: boolean } }
  | { type: 'model.switch'; data: { model: string } }
  | { type: 'command.run'; data: { command: string } }       // Slash commands
  | { type: 'file.read'; data: { path: string } };
```

### 1.7 Frontend (Vanilla JS — Sin Framework)

**Justificacion:** NO usar React/Vue/Svelte para el frontend web. Razones:
- No agregar 500KB+ de bundle a un CLI tool
- Vanilla JS moderno es suficiente para un chat UI
- Menos dependencias = menos vulnerabilidades
- Se puede servir como static files sin build step

```javascript
// src/web/static/app.js (estructura)

class KCodeWebUI {
  constructor() {
    this.ws = null;
    this.messages = [];
    this.currentStream = null;
    this.permissionRequests = new Map();
  }

  // --- Connection ---
  connect(token) {
    this.ws = new WebSocket(`ws://localhost:19300/ws?token=${token}`);
    this.ws.onmessage = (e) => this.handleEvent(JSON.parse(e.data));
    this.ws.onclose = () => this.showReconnect();
  }

  // --- Event Handling ---
  handleEvent(event) {
    switch (event.type) {
      case 'message.new':
        this.addMessage(event.data);
        break;
      case 'message.delta':
        this.appendToMessage(event.data.id, event.data.delta);
        break;
      case 'tool.start':
        this.showToolExecution(event.data);
        break;
      case 'permission.request':
        this.showPermissionDialog(event.data);
        break;
      // ...
    }
  }

  // --- Rendering ---
  addMessage(msg) {
    const el = document.createElement('div');
    el.className = `message message-${msg.role}`;
    el.innerHTML = this.renderMarkdown(msg.content);
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  // --- Input ---
  sendMessage() {
    const input = this.inputEl.value.trim();
    if (!input) return;

    this.ws.send(JSON.stringify({ type: 'message.send', data: { content: input } }));
    this.inputEl.value = '';
  }

  // --- Permission Dialog ---
  showPermissionDialog(data) {
    // Modal con: tool name, input preview, Allow/Deny/Always buttons
    // Al responder: ws.send({ type: 'permission.respond', data: { id, allowed, always } })
  }

  // --- Markdown Rendering ---
  renderMarkdown(text) {
    // Usar una libreria ligera como marked.js (inline, <30KB)
    // Con syntax highlighting via highlight.js (lazy load por lenguaje)
  }
}
```

### 1.8 CLI Integration

```bash
# Iniciar con Web UI
kcode --web

# Iniciar en puerto especifico
kcode --web --web-port 3000

# Iniciar sin abrir browser
kcode --web --no-open

# Solo web (sin TUI)
kcode --web-only
```

### 1.9 Tests y Criterios

- [ ] `kcode --web` abre browser con UI funcional
- [ ] Mensajes se sincronizan entre TUI y Web UI en tiempo real
- [ ] Permission dialogs funcionan en web
- [ ] Streaming de respuestas es fluido (sin lag visible)
- [ ] Auth token previene acceso no autorizado
- [ ] Web UI funciona sin JavaScript frameworks (vanilla JS)
- [ ] Frontend total < 100KB (sin contar syntax highlighting)

---

## Feature B2: Real-time Collaboration

### 2.1 Contexto

Permitir que multiples usuarios vean y participen en la misma sesion de KCode.
Casos de uso:
- Pair programming con AI
- Code review en vivo
- Teaching/mentoring
- Team debugging

### 2.2 Archivos Nuevos

```
src/
  core/
    collab/
      session-share.ts          (~300 lineas) - Compartir sesion
      session-share.test.ts     (~250 lineas)
      cursor-sync.ts            (~200 lineas) - Sincronizacion de cursores
      cursor-sync.test.ts       (~150 lineas)
      permission-bridge.ts      (~200 lineas) - Permisos multi-usuario
      permission-bridge.test.ts (~150 lineas)
      chat.ts                   (~150 lineas) - Chat lateral entre usuarios
      chat.test.ts              (~100 lineas)
      types.ts                  (~60 lineas)
```

### 2.3 Modelo de Colaboracion

```typescript
// src/core/collab/types.ts

interface CollabSession {
  sessionId: string;
  ownerId: string;           // Nodo que creo la sesion
  shareToken: string;        // Token para unirse
  participants: Participant[];
  mode: 'view' | 'interact'; // view = solo observar, interact = puede enviar mensajes
  maxParticipants: number;   // default: 5
}

interface Participant {
  id: string;
  name: string;
  role: 'owner' | 'collaborator' | 'viewer';
  connectedAt: number;
  lastActivity: number;
  color: string;             // Color unico para cursor/highlight
}

// Permisos por rol:
// owner:        Todo (enviar mensajes, aprobar permisos, kickear usuarios)
// collaborator: Enviar mensajes, ver todo, NO aprobar permisos
// viewer:       Solo observar, NO puede enviar mensajes
```

### 2.4 Session Sharing

```typescript
// src/core/collab/session-share.ts

class SessionShare {
  private session: CollabSession;
  private transport: WebServer; // Reutiliza el WebServer de B1

  /** Iniciar comparticion de sesion */
  async startSharing(mode: 'view' | 'interact'): Promise<ShareInfo> {
    this.session = {
      sessionId: getSessionId(),
      ownerId: getNodeId(),
      shareToken: generateToken(16), // 16 chars alfanumerico
      participants: [{ id: getNodeId(), name: getHostname(), role: 'owner', ... }],
      mode,
      maxParticipants: 5,
    };

    return {
      shareUrl: `http://localhost:${this.transport.port}?share=${this.session.shareToken}`,
      shareToken: this.session.shareToken,
      // Si hay tunnel (ngrok, cloudflare tunnel):
      publicUrl: await this.getPublicUrl(),
    };
  }

  /** Un participante se une */
  async join(token: string, name: string): Promise<JoinResult> {
    if (token !== this.session.shareToken) {
      throw new Error('Invalid share token');
    }
    if (this.session.participants.length >= this.session.maxParticipants) {
      throw new Error('Session is full');
    }

    const participant: Participant = {
      id: generateId(),
      name,
      role: this.session.mode === 'interact' ? 'collaborator' : 'viewer',
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      color: this.assignColor(),
    };

    this.session.participants.push(participant);

    // Notificar a todos
    this.transport.broadcast({
      type: 'collab.joined',
      data: { participant },
    });

    // Enviar historial completo al nuevo participante
    return {
      participant,
      history: getMessages(),
      currentState: {
        model: getCurrentModel(),
        tokens: getTokenCount(),
        isResponding: isModelResponding(),
      },
    };
  }

  /** Enviar mensaje como participante */
  async sendAsParticipant(participantId: string, content: string): Promise<void> {
    const participant = this.session.participants.find(p => p.id === participantId);
    if (!participant) throw new Error('Not a participant');
    if (participant.role === 'viewer') throw new Error('Viewers cannot send messages');

    // Prefixar el mensaje con el nombre del participante
    const prefixed = `[${participant.name}] ${content}`;

    // Enviar al conversation loop
    await sendUserMessage(prefixed);
  }
}
```

### 2.5 Permission Bridge Multi-Usuario

```typescript
// src/core/collab/permission-bridge.ts

/**
 * Cuando hay colaboradores, los permisos se manejan asi:
 * 1. Solo el owner puede aprobar/denegar permisos
 * 2. Colaboradores ven el dialog pero NO pueden responder
 * 3. Si el owner no responde en 30s, el dialog se muestra a colaboradores
 * 4. Viewers nunca ven permission dialogs
 */

class CollabPermissionBridge {
  async requestPermission(toolName: string, input: any): Promise<boolean> {
    const requestId = generateId();

    // Enviar a todos
    this.transport.broadcast({
      type: 'permission.request',
      data: { id: requestId, tool: toolName, input, ownerOnly: true },
    });

    // Esperar respuesta del owner (30s)
    const ownerResponse = await this.waitForResponse(requestId, 'owner', 30000);
    if (ownerResponse !== null) return ownerResponse;

    // Fallback: pedir a cualquier collaborator
    this.transport.broadcast({
      type: 'permission.escalated',
      data: { id: requestId, reason: 'Owner did not respond' },
    });

    const collabResponse = await this.waitForResponse(requestId, 'collaborator', 30000);
    if (collabResponse !== null) return collabResponse;

    // Nadie respondio: denegar
    return false;
  }
}
```

### 2.6 Chat Lateral

```typescript
// src/core/collab/chat.ts

/**
 * Chat privado entre participantes (no va al modelo).
 * Util para coordinar sin "contaminar" el contexto del AI.
 */

// WebSocket events:
// { type: 'collab.chat', data: { from: participant, message: string } }
// Renderizado en sidebar de la Web UI
// En TUI: mostrado como notificacion "[Chat] user: message"
```

### 2.7 CLI

```bash
# Compartir sesion actual
/share                    # Genera URL local
/share --public           # Genera URL con tunnel publico
/share --mode view        # Solo observar
/share --mode interact    # Pueden enviar mensajes

# Unirse a sesion
kcode --join <share-url>
kcode --join <share-token> --host <ip:port>

# Gestion
/participants             # Ver participantes
/kick <name>             # Expulsar participante
/unshare                 # Dejar de compartir
```

### 2.8 Tests y Criterios

- [ ] Compartir sesion genera URL valida
- [ ] Participante puede unirse y ver historial completo
- [ ] Mensajes de colaboradores llegan al modelo
- [ ] Viewers no pueden enviar mensajes
- [ ] Permisos solo los aprueba el owner (con escalacion)
- [ ] Max 5 participantes por sesion
- [ ] Chat lateral no afecta el contexto del AI

---

## Feature B3: Visual Diff/Merge

### 3.1 Contexto

KCode tiene `DiffViewer.tsx` basico en TUI. Cuando el AI edita archivos, el usuario
ve un diff pero no puede interactuar con el.

El Visual Diff/Merge permite:
- Ver diffs side-by-side o inline
- Aceptar/rechazar hunks individuales
- Editar el resultado manualmente
- Resolver conflictos de merge
- Undo granular por hunk

### 3.2 Archivos Nuevos

```
src/
  ui/
    components/
      InteractiveDiff.tsx        (~500 lineas) - Diff interactivo en TUI
      InteractiveDiff.test.ts    (~350 lineas)
      MergeResolver.tsx          (~400 lineas) - Resolucion de conflictos
      MergeResolver.test.ts      (~300 lineas)
      HunkSelector.tsx           (~200 lineas) - Selector de hunks
      HunkSelector.test.ts       (~150 lineas)
  core/
    diff/
      engine.ts                  (~300 lineas) - Motor de diff mejorado
      engine.test.ts             (~250 lineas)
      hunk-operations.ts         (~200 lineas) - Operaciones sobre hunks
      hunk-operations.test.ts    (~150 lineas)
      three-way-merge.ts         (~350 lineas) - Three-way merge
      three-way-merge.test.ts    (~250 lineas)
      types.ts                   (~60 lineas)
```

### 3.3 Motor de Diff Mejorado

```typescript
// src/core/diff/types.ts

interface DiffHunk {
  id: string;
  startLineOld: number;
  endLineOld: number;
  startLineNew: number;
  endLineNew: number;
  linesRemoved: string[];
  linesAdded: string[];
  context: {
    before: string[];    // 3 lineas de contexto antes
    after: string[];     // 3 lineas de contexto despues
  };
  status: 'pending' | 'accepted' | 'rejected' | 'modified';
  type: 'addition' | 'deletion' | 'modification';
}

interface DiffResult {
  filePath: string;
  hunks: DiffHunk[];
  stats: {
    additions: number;
    deletions: number;
    modifications: number;
  };
}
```

```typescript
// src/core/diff/engine.ts

class DiffEngine {
  /** Generar diff entre dos versiones de un archivo */
  diff(original: string, modified: string): DiffResult {
    // Usar algoritmo Myers diff (implementacion propia, no shell out a git)
    // Agrupar cambios consecutivos en hunks
    // Agregar 3 lineas de contexto a cada hunk
  }

  /** Aplicar hunks selectivamente */
  applyHunks(original: string, hunks: DiffHunk[]): string {
    // Solo aplicar hunks con status === 'accepted' o 'modified'
    // Hunks 'rejected' se saltan
    // Hunks 'modified' usan el contenido editado por el usuario
  }
}
```

### 3.4 Three-Way Merge

```typescript
// src/core/diff/three-way-merge.ts

/**
 * Three-way merge para resolver conflictos cuando:
 * 1. El AI modifica un archivo
 * 2. El usuario tambien lo modifico (ej: en su IDE)
 * 3. Ambos cambios deben combinarse
 *
 * Base = version antes de que el AI empezara a editar
 * Ours = version actual del archivo (con cambios del usuario)
 * Theirs = version propuesta por el AI
 */

interface MergeResult {
  content: string;           // Resultado del merge
  conflicts: MergeConflict[];
  autoResolved: number;      // Hunks resueltos automaticamente
}

interface MergeConflict {
  id: string;
  startLine: number;
  endLine: number;
  ours: string[];            // Lineas del usuario
  theirs: string[];          // Lineas del AI
  base: string[];            // Lineas originales
  resolution?: 'ours' | 'theirs' | 'both' | 'custom';
  customContent?: string;
}

class ThreeWayMerge {
  merge(base: string, ours: string, theirs: string): MergeResult {
    // 1. Diff base vs ours -> hunks del usuario
    // 2. Diff base vs theirs -> hunks del AI
    // 3. Si hunks no se solapan -> auto-merge (aplicar ambos)
    // 4. Si hunks se solapan -> generar MergeConflict
    // 5. Retornar contenido con conflictos marcados
  }
}
```

### 3.5 Interactive Diff (TUI Component)

```typescript
// src/ui/components/InteractiveDiff.tsx

/**
 * Componente React/Ink que muestra un diff interactivo en terminal.
 *
 * Controles:
 *   ↑/↓     Navegar entre hunks
 *   Enter   Aceptar hunk actual
 *   x       Rechazar hunk actual
 *   e       Editar hunk (abre $EDITOR)
 *   a       Aceptar todos
 *   r       Rechazar todos
 *   d       Toggle display (side-by-side / inline)
 *   q       Finalizar revision
 *
 * Display modes:
 *   Inline:       Lineas - en rojo, + en verde, contexto en gris
 *   Side-by-side: Dos columnas, viejo a la izquierda, nuevo a la derecha
 */

function InteractiveDiff({ diff, onComplete }: Props) {
  const [currentHunk, setCurrentHunk] = useState(0);
  const [displayMode, setDisplayMode] = useState<'inline' | 'side-by-side'>('inline');
  const [hunks, setHunks] = useState(diff.hunks);

  useInput((input, key) => {
    if (key.upArrow) setCurrentHunk(h => Math.max(0, h - 1));
    if (key.downArrow) setCurrentHunk(h => Math.min(hunks.length - 1, h + 1));
    if (key.return) acceptHunk(currentHunk);
    if (input === 'x') rejectHunk(currentHunk);
    if (input === 'e') editHunk(currentHunk);
    if (input === 'a') acceptAll();
    if (input === 'r') rejectAll();
    if (input === 'd') toggleDisplay();
    if (input === 'q') finalize();
  });

  // Render: mostrar hunk actual con highlight, status bar con contadores
  return (
    <Box flexDirection="column">
      <Header stats={getStats(hunks)} currentHunk={currentHunk} total={hunks.length} />
      <HunkDisplay
        hunk={hunks[currentHunk]}
        mode={displayMode}
        isCurrent={true}
      />
      <StatusBar
        accepted={hunks.filter(h => h.status === 'accepted').length}
        rejected={hunks.filter(h => h.status === 'rejected').length}
        pending={hunks.filter(h => h.status === 'pending').length}
      />
      <Controls />
    </Box>
  );
}
```

### 3.6 Merge Resolver (TUI)

```typescript
// src/ui/components/MergeResolver.tsx

/**
 * UI para resolver conflictos de three-way merge.
 *
 * Muestra cada conflicto con 3 paneles:
 *   [BASE]   Version original
 *   [OURS]   Cambios del usuario
 *   [THEIRS] Cambios del AI
 *
 * Controles:
 *   1  Elegir OURS
 *   2  Elegir THEIRS
 *   3  Elegir ambos (concatenar)
 *   e  Editar manualmente
 *   n  Siguiente conflicto
 *   p  Conflicto anterior
 *   s  Guardar y salir
 */
```

### 3.7 Integracion con Edit Tool

Cuando el AI ejecuta Edit, en vez de aplicar directamente:

```
Si interactiveDiff.enabled && cambios > umbral (5+ lineas):
  1. Calcular diff
  2. Mostrar InteractiveDiff
  3. Usuario revisa hunk por hunk
  4. Aplicar solo hunks aceptados
  5. Si habia conflictos (archivo cambio mientras AI pensaba):
     Mostrar MergeResolver
```

### 3.8 Tests y Criterios

- [ ] Diff engine genera hunks correctos para todos los tipos de cambio
- [ ] Aceptar/rechazar hunks individuales aplica correctamente
- [ ] Three-way merge auto-resuelve cambios no conflictivos
- [ ] Conflictos se muestran con las 3 versiones
- [ ] Side-by-side display funciona en terminales >= 80 columnas
- [ ] Undo por hunk funciona correctamente

---

## Feature B4: Project Dashboard

### 4.1 Contexto

Un dashboard que muestre el estado general del proyecto: tests, coverage, TODOs,
deuda tecnica, actividad de sesiones, metricas de AI.

### 4.2 Archivos Nuevos

```
src/
  core/
    dashboard/
      analyzer.ts               (~400 lineas) - Analisis del proyecto
      analyzer.test.ts          (~300 lineas)
      metrics.ts                (~250 lineas) - Recoleccion de metricas
      metrics.test.ts           (~200 lineas)
      renderer.ts               (~300 lineas) - Renderizado del dashboard
      renderer.test.ts          (~200 lineas)
      types.ts                  (~60 lineas)
```

### 4.3 Metricas del Dashboard

```typescript
// src/core/dashboard/types.ts

interface ProjectDashboard {
  project: {
    name: string;
    language: string;
    files: number;
    linesOfCode: number;
    lastCommit: string;
  };
  tests: {
    framework: string;         // jest, vitest, bun:test, pytest, go test
    total: number;
    passing: number;
    failing: number;
    coverage?: number;         // Porcentaje
    lastRun: string;
  };
  codeQuality: {
    todos: number;             // Conteo de TODO/FIXME/HACK/XXX
    todoList: Array<{ file: string; line: number; text: string }>;
    longFunctions: number;     // Funciones con >50 lineas
    duplicateCode: number;     // Bloques similares detectados
    complexityScore: number;   // 0-100 (McCabe-like simplificado)
  };
  activity: {
    sessionsLast7Days: number;
    tokensLast7Days: number;
    costLast7Days: number;
    topTools: Array<{ name: string; count: number }>;
    filesModifiedByAI: number;
  };
  dependencies: {
    total: number;
    outdated: number;
    vulnerable: number;       // Si hay audit disponible
  };
}
```

### 4.4 Analyzer

```typescript
// src/core/dashboard/analyzer.ts

class ProjectAnalyzer {
  /** Analizar proyecto completo */
  async analyze(projectDir: string): Promise<ProjectDashboard> {
    const [project, tests, quality, activity, deps] = await Promise.all([
      this.analyzeProject(projectDir),
      this.analyzeTests(projectDir),
      this.analyzeCodeQuality(projectDir),
      this.analyzeActivity(),
      this.analyzeDependencies(projectDir),
    ]);
    return { project, tests, codeQuality: quality, activity, dependencies: deps };
  }

  private async analyzeTests(dir: string): Promise<ProjectDashboard['tests']> {
    // Detectar framework de tests:
    // - package.json > scripts > test -> jest/vitest/bun
    // - pytest.ini / setup.cfg -> pytest
    // - go.mod -> go test
    // - Cargo.toml -> cargo test
    //
    // Ejecutar `test --dry-run` o parsear ultimo output si existe
    // Parsear coverage si hay archivo de coverage (lcov, coverage.json)
  }

  private async analyzeCodeQuality(dir: string): Promise<ProjectDashboard['codeQuality']> {
    // 1. Buscar TODOs: grep -r "TODO|FIXME|HACK|XXX" --include="*.{ts,js,py,go,rs}"
    // 2. Funciones largas: parsear archivos y contar lineas por funcion
    // 3. Complejidad: contar if/else/for/while/switch anidados
    // 4. Duplicados: hash de bloques de 5+ lineas, buscar repetidos
  }

  private async analyzeActivity(): Promise<ProjectDashboard['activity']> {
    // Query analytics SQLite: tool_analytics table
    // Agrupar por dia, top tools, archivos modificados
  }

  private async analyzeDependencies(dir: string): Promise<ProjectDashboard['dependencies']> {
    // package.json: npm outdated --json, npm audit --json
    // Cargo.toml: cargo outdated, cargo audit
    // go.mod: go list -m -u all
    // requirements.txt: pip list --outdated --format=json
  }
}
```

### 4.5 Renderizado TUI

```typescript
// src/core/dashboard/renderer.ts

/**
 * Renderiza el dashboard en terminal con boxes Unicode.
 *
 * Layout:
 * ┌─ Project ──────────────────┬─ Tests ───────────────┐
 * │ Name: my-project           │ Framework: bun:test   │
 * │ Language: TypeScript        │ Total: 234            │
 * │ Files: 156                  │ ✓ Passing: 230       │
 * │ LoC: 12,456                │ ✗ Failing: 4         │
 * │ Last commit: 2h ago        │ Coverage: 78%         │
 * ├─ Code Quality ─────────────┼─ Activity (7d) ───────┤
 * │ TODOs: 23                  │ Sessions: 12          │
 * │ Long functions: 8          │ Tokens: 450K          │
 * │ Complexity: 72/100         │ Cost: $3.45           │
 * │ Duplicates: 3              │ Top: Bash(45) Edit(32)│
 * ├─ Dependencies ─────────────┼─ AI Impact ───────────┤
 * │ Total: 45                  │ Files modified: 34    │
 * │ Outdated: 7                │ Lines added: 1,200    │
 * │ Vulnerable: 0 ✓           │ Lines removed: 400    │
 * └────────────────────────────┴───────────────────────┘
 */
```

### 4.6 CLI

```bash
kcode dashboard            # Mostrar dashboard
kcode dashboard --watch    # Auto-refresh cada 30s
kcode dashboard --json     # Output JSON (para CI/CD)
kcode dashboard --web      # Abrir en Web UI
```

### 4.7 Tests y Criterios

- [ ] Dashboard detecta framework de tests correctamente
- [ ] TODO counter es preciso (verificado contra grep manual)
- [ ] Activity metrics coinciden con analytics de SQLite
- [ ] Dashboard renderiza correctamente en terminales de 80+ columnas
- [ ] `--json` output es valido para integracion CI

---

## Feature B5: Smart Templates

### 5.1 Contexto

Plantillas inteligentes que generan scaffolding de proyectos completos usando AI.
No son templates estaticos (como `create-react-app`), sino generados dinamicamente
segun las necesidades del usuario.

### 5.2 Archivos Nuevos

```
src/
  core/
    templates/
      engine.ts                 (~350 lineas) - Motor de templates
      engine.test.ts            (~250 lineas)
      registry.ts               (~200 lineas) - Registro de templates
      registry.test.ts          (~150 lineas)
      scaffolder.ts             (~400 lineas) - Generacion de archivos
      scaffolder.test.ts        (~300 lineas)
      types.ts                  (~60 lineas)
    templates/builtin/          (~10 templates .md con frontmatter)
```

### 5.3 Definicion de Templates

```typescript
// src/core/templates/types.ts

interface Template {
  name: string;              // "rest-api", "cli-tool", "react-app"
  description: string;
  tags: string[];            // ["typescript", "api", "express"]
  parameters: TemplateParam[];
  prompt: string;            // Prompt para el AI que genera el scaffold
  postSetup?: string[];      // Comandos a ejecutar despues (npm install, etc.)
}

interface TemplateParam {
  name: string;
  description: string;
  type: 'string' | 'boolean' | 'choice';
  choices?: string[];
  default?: any;
  required: boolean;
}
```

### 5.4 Templates Built-in

```markdown
# rest-api.md
---
name: rest-api
description: REST API with database, auth, and tests
tags: [typescript, api, bun, sqlite]
parameters:
  - name: projectName
    description: Name of the project
    type: string
    required: true
  - name: database
    description: Database to use
    type: choice
    choices: [sqlite, postgres, mysql]
    default: sqlite
  - name: auth
    description: Include authentication
    type: boolean
    default: true
  - name: docker
    description: Include Dockerfile
    type: boolean
    default: true
---

Generate a complete REST API project with the following specs:
- Runtime: Bun
- Language: TypeScript (strict mode)
- Database: {{database}}
- Auth: {{#if auth}}JWT-based authentication with register/login endpoints{{else}}No auth{{/if}}
- Testing: bun:test with at least one test per endpoint
- Structure: src/routes/, src/middleware/, src/models/, src/utils/
{{#if docker}}- Docker: Multi-stage Dockerfile with .dockerignore{{/if}}
- Include: README.md, .gitignore, tsconfig.json, package.json

Project name: {{projectName}}

Generate ALL files with complete, working code. No placeholders.
```

### 5.5 Scaffolder

```typescript
// src/core/templates/scaffolder.ts

class Scaffolder {
  /** Generar proyecto desde template */
  async scaffold(template: Template, params: Record<string, any>, outputDir: string): Promise<ScaffoldReport> {
    // 1. Expandir template prompt con parametros (Handlebars)
    const prompt = expandTemplate(template.prompt, params);

    // 2. Enviar al modelo con instrucciones de generar archivos
    const systemPrompt = `
You are a project scaffolder. Generate a complete project structure.
For each file, output:
---FILE: path/to/file.ext---
(file content here)
---END FILE---

Generate ALL files. No placeholders, no TODOs, no "implement here".
Every file must be complete and working.
    `;

    // 3. Ejecutar modelo
    const response = await executeModelRequest({
      model: getCurrentModel(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      maxTokens: 16384,
      stream: false,
    });

    // 4. Parsear respuesta y extraer archivos
    const files = this.parseFiles(response.content);

    // 5. Escribir archivos al disco
    for (const file of files) {
      const fullPath = join(outputDir, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content);
    }

    // 6. Ejecutar post-setup
    if (template.postSetup) {
      for (const cmd of template.postSetup) {
        Bun.spawnSync(cmd.split(' '), { cwd: outputDir });
      }
    }

    return { filesCreated: files.length, outputDir };
  }

  private parseFiles(content: string): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = [];
    const regex = /---FILE:\s*(.+?)---\n([\s\S]*?)---END FILE---/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      files.push({ path: match[1].trim(), content: match[2] });
    }
    return files;
  }
}
```

### 5.6 CLI

```bash
# Listar templates
kcode template list

# Generar proyecto desde template
kcode template create rest-api --name my-api --database postgres --auth

# Generar con wizard interactivo
kcode template create rest-api  # Pregunta parametros uno por uno

# Crear template custom
kcode template add ./my-template.md

# Generar desde descripcion libre (sin template predefinido)
kcode new "Create a CLI tool that converts CSV to JSON with streaming support"
```

### 5.7 Tests y Criterios

- [ ] `kcode template list` muestra templates con descripcion
- [ ] Scaffold genera archivos completos y funcionales
- [ ] Parametros se expanden correctamente en el prompt
- [ ] Post-setup commands se ejecutan
- [ ] Templates custom se cargan desde `~/.kcode/templates/` y `.kcode/templates/`

---

## Feature B6: Voice Mode Avanzado

### 6.1 Contexto

KCode tiene voice basico: graba 10s con arecord/sox, transcribe con whisper.
Es one-shot, no interactivo.

Voice Mode Avanzado:
- Conversacion bidireccional en tiempo real
- Voice Activity Detection (VAD) para detectar cuando habla el usuario
- Text-to-Speech (TTS) local para respuestas del AI
- Streaming ASR (reconocimiento continuo)

### 6.2 Archivos Nuevos

```
src/
  core/
    voice/
      vad.ts                    (~200 lineas) - Voice Activity Detection
      vad.test.ts               (~150 lineas)
      streaming-asr.ts          (~300 lineas) - ASR en streaming
      streaming-asr.test.ts     (~200 lineas)
      tts.ts                    (~250 lineas) - Text-to-Speech local
      tts.test.ts               (~200 lineas)
      voice-session.ts          (~350 lineas) - Sesion de voz completa
      voice-session.test.ts     (~250 lineas)
      types.ts                  (~60 lineas)
```

**Archivos a Modificar:**
- `src/core/voice.ts` — integrar con nuevo sistema
- `src/ui/App.tsx` — agregar indicador de voz en header

### 6.3 Voice Activity Detection

```typescript
// src/core/voice/vad.ts

/**
 * Detecta cuando el usuario empieza y deja de hablar.
 * Usa analisis de energia de audio (RMS) con umbral adaptativo.
 * NO requiere modelo de ML — es analisis de señal puro.
 */

interface VADConfig {
  /** Umbral de energia para detectar voz (auto-calibrado) */
  energyThreshold: number;    // default: 0.02 (auto-calibrated)
  /** Duracion minima de silencio para considerar fin de habla (ms) */
  silenceDuration: number;    // default: 1500
  /** Duracion minima de voz para considerar inicio de habla (ms) */
  speechDuration: number;     // default: 300
  /** Duracion de calibracion al inicio (ms) */
  calibrationDuration: number; // default: 2000
}

class VoiceActivityDetector {
  private baseline: number = 0; // Nivel de ruido base (calibrado)

  /** Calibrar con ruido ambiente */
  calibrate(audioChunk: Float32Array): void {
    // Calcular RMS del chunk
    // Actualizar baseline con running average
    // energyThreshold = baseline * 3 (3x ruido de fondo)
  }

  /** Procesar chunk de audio y detectar estado */
  process(audioChunk: Float32Array): VADEvent | null {
    const rms = this.calculateRMS(audioChunk);

    if (rms > this.energyThreshold) {
      // Voz detectada
      this.speechFrames++;
      this.silenceFrames = 0;

      if (this.speechFrames >= this.minSpeechFrames && this.state === 'silence') {
        this.state = 'speech';
        return { type: 'speech-start', timestamp: Date.now() };
      }
    } else {
      // Silencio
      this.silenceFrames++;

      if (this.silenceFrames >= this.minSilenceFrames && this.state === 'speech') {
        this.state = 'silence';
        return { type: 'speech-end', timestamp: Date.now() };
      }
    }

    return null;
  }
}
```

### 6.4 Streaming ASR

```typescript
// src/core/voice/streaming-asr.ts

/**
 * Reconocimiento de voz en streaming (no espera a que termine la grabacion).
 *
 * Backends:
 * 1. faster-whisper con --live flag (streaming nativo)
 * 2. whisper.cpp con --stream flag
 * 3. Chunked: grabar chunks de 3s y transcribir secuencialmente
 */

class StreamingASR {
  private backend: 'faster-whisper-stream' | 'whisper-cpp-stream' | 'chunked';
  private process: any;

  async start(onTranscript: (text: string, isFinal: boolean) => void): Promise<void> {
    switch (this.backend) {
      case 'faster-whisper-stream':
        // Ejecutar: faster-whisper --model small --live --vad_filter
        // Lee de stdin (audio raw PCM)
        // Escribe transcripciones parciales a stdout
        this.process = Bun.spawn(['faster-whisper', '--model', 'small', '--live', '--vad_filter'], {
          stdin: 'pipe',
          stdout: 'pipe',
        });

        // Leer transcripciones del stdout
        const reader = this.process.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          const isFinal = text.endsWith('\n');
          onTranscript(text.trim(), isFinal);
        }
        break;

      case 'chunked':
        // Fallback: grabar chunks de 3s, transcribir cada uno
        // Menos fluido pero funciona con cualquier whisper
        break;
    }
  }

  /** Enviar audio al ASR */
  feedAudio(pcmData: Float32Array): void {
    if (this.process?.stdin) {
      // Convertir Float32 a Int16 PCM
      const int16 = new Int16Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, pcmData[i] * 32768));
      }
      this.process.stdin.write(Buffer.from(int16.buffer));
    }
  }

  stop(): void {
    this.process?.kill();
  }
}
```

### 6.5 Text-to-Speech Local

```typescript
// src/core/voice/tts.ts

/**
 * TTS local sin internet.
 *
 * Backends:
 * 1. Piper TTS (ONNX, muchas voces, alta calidad)
 *    - https://github.com/rhasspy/piper
 *    - Modelos ~20-50MB por voz
 *    - Rapido en CPU
 *
 * 2. espeak-ng (pre-instalado en muchas distros Linux)
 *    - Calidad inferior pero siempre disponible
 *    - Sin necesidad de descargar modelos
 *
 * 3. say (macOS built-in)
 */

class LocalTTS {
  private backend: 'piper' | 'espeak' | 'say';

  async speak(text: string): Promise<void> {
    switch (this.backend) {
      case 'piper':
        // echo "text" | piper --model en_US-lessac-medium --output-raw | aplay -r 22050 -f S16_LE
        const piper = Bun.spawn(
          ['piper', '--model', this.getVoiceModel(), '--output-raw'],
          { stdin: 'pipe', stdout: 'pipe' }
        );
        const player = Bun.spawn(
          ['aplay', '-r', '22050', '-f', 'S16_LE', '-t', 'raw'],
          { stdin: piper.stdout }
        );
        piper.stdin.write(text);
        piper.stdin.end();
        await player.exited;
        break;

      case 'espeak':
        await Bun.spawn(['espeak-ng', '-v', this.getLang(), text]).exited;
        break;

      case 'say': // macOS
        await Bun.spawn(['say', '-v', this.getVoice(), text]).exited;
        break;
    }
  }

  /** Streaming TTS: hablar mientras se genera texto */
  async speakStream(textStream: AsyncIterable<string>): Promise<void> {
    // Acumular texto hasta encontrar un punto final (., !, ?)
    // Luego hablar cada oracion mientras se acumula la siguiente
    // Esto permite TTS en "tiempo real" sin esperar toda la respuesta
    let buffer = '';
    for await (const chunk of textStream) {
      buffer += chunk;
      const sentences = this.splitSentences(buffer);
      if (sentences.complete.length > 0) {
        for (const sentence of sentences.complete) {
          await this.speak(sentence);
        }
        buffer = sentences.remaining;
      }
    }
    // Hablar lo que quede en el buffer
    if (buffer.trim()) await this.speak(buffer);
  }

  private splitSentences(text: string): { complete: string[]; remaining: string } {
    const sentences: string[] = [];
    let remaining = text;
    const regex = /[^.!?]*[.!?]+\s*/g;
    let match;
    let lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      sentences.push(match[0].trim());
      lastIndex = regex.lastIndex;
    }
    remaining = text.slice(lastIndex);
    return { complete: sentences, remaining };
  }
}
```

### 6.6 Voice Session (Orquestador)

```typescript
// src/core/voice/voice-session.ts

class VoiceSession {
  private vad: VoiceActivityDetector;
  private asr: StreamingASR;
  private tts: LocalTTS;
  private recorder: AudioRecorder;
  private isListening: boolean = false;
  private isSpeaking: boolean = false;

  /** Iniciar sesion de voz bidireccional */
  async start(): Promise<void> {
    // 1. Calibrar VAD (2 segundos de ruido ambiente)
    console.log('🎙️ Calibrando... (mantente en silencio 2 segundos)');
    await this.calibrateVAD();

    // 2. Iniciar ASR streaming
    await this.asr.start(this.handleTranscript.bind(this));

    // 3. Iniciar grabacion continua
    this.recorder.start((audioChunk) => {
      // Cada chunk de audio:
      const event = this.vad.process(audioChunk);

      if (event?.type === 'speech-start') {
        this.isListening = true;
        // Interrumpir TTS si esta hablando
        if (this.isSpeaking) this.tts.stop();
      }

      if (this.isListening) {
        this.asr.feedAudio(audioChunk);
      }

      if (event?.type === 'speech-end') {
        this.isListening = false;
        // El ASR producira la transcripcion final
      }
    });

    console.log('🎙️ Voice mode activo. Habla para interactuar. Ctrl+C para salir.');
  }

  /** Manejar transcripcion del ASR */
  private async handleTranscript(text: string, isFinal: boolean): Promise<void> {
    if (!isFinal) {
      // Transcripcion parcial: mostrar en UI como preview
      this.ui.showPartialTranscript(text);
      return;
    }

    // Transcripcion final: enviar al modelo
    this.ui.showFinalTranscript(text);

    // Enviar al conversation loop
    const response = await sendUserMessage(text);

    // TTS de la respuesta (streaming)
    this.isSpeaking = true;
    await this.tts.speakStream(response.textStream);
    this.isSpeaking = false;
  }
}
```

### 6.7 Audio Recorder

```typescript
// Grabacion continua usando arecord o sox en modo streaming
class AudioRecorder {
  private process: any;

  start(onChunk: (data: Float32Array) => void): void {
    // arecord -f S16_LE -r 16000 -c 1 -t raw
    // Lee audio raw a 16kHz mono
    this.process = Bun.spawn(
      ['arecord', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw'],
      { stdout: 'pipe' }
    );

    // Leer chunks de 320 bytes (20ms a 16kHz)
    const CHUNK_SIZE = 640; // 320 samples * 2 bytes
    this.readLoop(CHUNK_SIZE, onChunk);
  }

  private async readLoop(chunkSize: number, onChunk: (data: Float32Array) => void): Promise<void> {
    const reader = this.process.stdout.getReader();
    let buffer = new Uint8Array(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Acumular en buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      // Procesar chunks completos
      while (buffer.length >= chunkSize) {
        const chunk = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);

        // Convertir Int16 a Float32
        const int16 = new Int16Array(chunk.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }

        onChunk(float32);
      }
    }
  }

  stop(): void {
    this.process?.kill();
  }
}
```

### 6.8 CLI

```bash
# Iniciar voice mode
kcode --voice

# Con TTS especifico
kcode --voice --tts piper --tts-voice en_US-lessac-medium

# Solo transcripcion (sin TTS)
kcode --voice --no-tts

# Configurar sensibilidad del VAD
kcode --voice --vad-sensitivity high
```

### 6.9 Tests y Criterios

- [ ] VAD detecta inicio y fin de habla con <300ms de latencia
- [ ] ASR transcribe con >90% accuracy en ingles
- [ ] TTS reproduce audio sin cortes
- [ ] Streaming TTS habla oracion por oracion
- [ ] Interrumpir TTS al empezar a hablar funciona
- [ ] Voice session completa (hablar -> transcribir -> modelo -> TTS) en <5s

---

## RESUMEN PATH B

| Feature | Archivos | LoC | Tests |
|---------|:--------:|:---:|:-----:|
| B1. Web UI | 10 | ~4,280 | ~750 |
| B2. Real-time Collaboration | 7 | ~1,260 | ~750 |
| B3. Visual Diff/Merge | 10 | ~2,660 | ~1,600 |
| B4. Project Dashboard | 6 | ~1,210 | ~700 |
| B5. Smart Templates | 6 | ~1,260 | ~700 |
| B6. Voice Mode Avanzado | 8 | ~1,510 | ~800 |
| **TOTAL PATH B** | **47** | **~12,180** | **~5,300** |

## ORDEN DE IMPLEMENTACION

```
Semana 1-3:  B1 (Web UI) ──────── Base para B2 y B4
    │
Semana 3-5:  B3 (Diff/Merge) ──── Independiente, mejora UX core
    │
Semana 5-6:  B4 (Dashboard) ───── Usa Web UI, aprovecha analyzer
    │
Semana 6-8:  B2 (Collaboration) ── Extiende Web UI con multi-user
    │
Semana 8-9:  B5 (Templates) ───── Independiente, rapido de implementar
    │
Semana 9-12: B6 (Voice) ────────── Mas complejo, necesita audio stack
```

**Dependencias:**
- B2 (Collaboration) depende fuertemente de B1 (Web UI)
- B4 (Dashboard) se beneficia de B1 pero puede funcionar solo en TUI
- B3, B5, B6 son independientes
