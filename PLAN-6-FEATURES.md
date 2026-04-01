# Plan de Implementacion: 6 Features Enterprise para KCode v1.6.0

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~12,000-15,000 LoC nuevas

> Este documento detalla la ingenieria inversa conceptual de 6 sistemas criticos,
> rediseñados desde cero para la arquitectura de KCode. NO se copia codigo,
> se reimplementan los conceptos adaptados al stack existente (Bun + SQLite + React/Ink).

---

## INDICE

1. [Feature 1: Enterprise Features](#feature-1-enterprise-features)
2. [Feature 2: Bridge/Daemon Mode](#feature-2-bridgedaemon-mode)
3. [Feature 3: Virtualizacion de UI](#feature-3-virtualizacion-de-ui)
4. [Feature 4: Lazy Loading y DCE](#feature-4-lazy-loading-y-dce)
5. [Feature 5: Remote Mode](#feature-5-remote-mode)
6. [Feature 6: Telemetria Profesional](#feature-6-telemetria-profesional)

---

## Feature 1: Enterprise Features

### 1.1 Contexto

KCode ya tiene un sistema basico de politicas (`ManagedPolicy` en `config.ts`) con
soporte para `/etc/kcode/policy.json` y `~/.kcode/managed-settings.json`. Tambien
tiene una tabla `audit_log` en SQLite. Lo que falta es:

- Distribucion remota de settings desde un servidor central
- MDM (Mobile Device Management) para macOS/Windows/Linux
- Policy limits con rate limiting y quotas
- OAuth flow completo con refresh de tokens

### 1.2 Archivos Nuevos a Crear

```
src/
  enterprise/
    remote-settings.ts        (~400 lineas) - Fetch, cache, polling de settings remotos
    remote-settings.test.ts   (~300 lineas) - Tests
    policy-limits.ts          (~350 lineas) - Rate limiting y quotas
    policy-limits.test.ts     (~250 lineas) - Tests
    mdm/
      reader.ts               (~250 lineas) - Lectura multiplataforma
      reader.test.ts          (~200 lineas) - Tests
      constants.ts            (~50 lineas)  - Dominios, paths por OS
    oauth/
      flow.ts                 (~500 lineas) - OAuth2 PKCE flow completo
      flow.test.ts            (~300 lineas) - Tests
      token-store.ts          (~200 lineas) - Almacenamiento seguro de tokens
      token-store.test.ts     (~150 lineas) - Tests
    types.ts                  (~80 lineas)  - Interfaces compartidas
    index.ts                  (~60 lineas)  - Re-exports
```

### 1.3 Remote Managed Settings

#### 1.3.1 Concepto

Un servidor central (propio de la organizacion o SaaS de Kulvex) distribuye
configuraciones a todas las instancias de KCode de la empresa. Las instancias
hacen polling periodico y aplican cambios en caliente.

#### 1.3.2 Diseño del Protocolo

**Endpoint:** `GET {KCODE_SETTINGS_URL}/api/v1/settings`

**Request:**
```
Headers:
  Authorization: Bearer {token}    # OAuth token o API key
  If-None-Match: "sha256:{hash}"   # ETag para cache
  X-KCode-Version: "1.6.0"        # Version del cliente
  X-KCode-OS: "linux"             # Plataforma
```

**Response 200 (settings cambiaron):**
```json
{
  "version": "2026-03-31T10:00:00Z",
  "checksum": "sha256:abc123...",
  "settings": {
    "permissionMode": "auto",
    "allowedTools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    "blockedTools": ["WebFetch"],
    "maxBudgetUsd": 50.0,
    "forceThinking": true,
    "customSystemPrompt": "...",
    "auditLogging": true
  }
}
```

**Response 304:** Settings no cambiaron (ETag match)
**Response 204/404:** No hay settings configurados para este cliente

#### 1.3.3 Flujo de Datos Detallado

```
INICIO (startup de KCode)
  |
  v
[1] Leer cache local: ~/.kcode/remote-settings.json
  |
  +-- Existe? --> Aplicar inmediatamente a la sesion
  |                (no bloquear startup esperando red)
  +-- No existe? --> Continuar sin settings remotos
  |
  v
[2] Fetch async en background (no bloquea UI)
  |
  +-- Calcular checksum SHA256 del cache actual
  |   Formula: SHA256(JSON.stringify(settings, Object.keys(settings).sort()))
  |   Nota: ordenar keys para checksum determinista
  |
  +-- HTTP GET con ETag = "sha256:{checksum}"
  |
  v
[3] Procesar respuesta
  |
  +-- 304 Not Modified --> No hacer nada (cache vigente)
  |
  +-- 200 OK --> Validar con Zod schema
  |   |
  |   +-- Valido? --> Guardar en ~/.kcode/remote-settings.json (permisos 0o600)
  |   |               Aplicar a sesion activa
  |   |               Emitir evento 'settings:changed'
  |   |
  |   +-- Invalido? --> Log warning, mantener cache anterior
  |
  +-- 204/404 --> Guardar {} como cache (significa "sin settings")
  |               No usar settings remotos
  |
  +-- Error de red --> Log warning, mantener cache anterior
  |                    Reintentar con backoff exponencial
  |
  v
[4] Iniciar polling periodico
  |
  +-- Intervalo: 1 hora (configurable via KCODE_SETTINGS_POLL_INTERVAL)
  +-- Repetir paso [2] y [3] en cada tick
  +-- Si la sesion termina, cancelar el timer
```

#### 1.3.4 Integracion con Config Existente

Modificar `src/core/config.ts` para insertar remote settings en la jerarquia.

**Nueva jerarquia (de mayor a menor prioridad):**
1. CLI environment variables (sin cambios)
2. **Remote managed settings** (NUEVO - prioridad alta porque viene del admin)
3. Local workspace settings `.kcode/settings.local.json` (sin cambios)
4. Project workspace settings `.kcode/settings.json` (sin cambios)
5. **MDM settings** (NUEVO - admin de IT)
6. User home settings `~/.kcode/settings.json` (sin cambios)

**Cambio en `buildConfig()`:**
```
Actualmente:
  const config = deepMerge(defaults, userSettings, projectSettings, localSettings, envVars)

Nuevo:
  const mdmSettings = await loadMdmSettings()
  const remoteSettings = await loadRemoteSettingsFromCache()
  const config = deepMerge(
    defaults,
    userSettings,
    mdmSettings,           // NUEVO
    projectSettings,
    localSettings,
    remoteSettings,        // NUEVO
    envVars
  )
```

#### 1.3.5 Deteccion de Settings Peligrosos

Antes de aplicar remote settings que afecten permisos o herramientas, mostrar
un dialogo de confirmacion al usuario (solo en modo interactivo).

**Settings que requieren confirmacion:**
- `permissionMode` cambiado a "auto" o "deny"
- `allowedTools` o `blockedTools` modificados
- `customSystemPrompt` añadido o cambiado
- `forceThinking` cambiado

**Flujo de confirmacion:**
```
[Remote settings recibidos con cambios peligrosos]
  |
  v
[Modo interactivo?]
  |
  +-- Si --> Mostrar dialogo: "Tu organizacion ha actualizado la configuracion.
  |          Cambios: [lista]. Aceptar? [s/n]"
  |          |
  |          +-- Aceptar --> Aplicar y continuar
  |          +-- Rechazar --> Mantener settings anteriores, log evento
  |
  +-- No (print mode, pipe) --> Aplicar automaticamente, log warning
```

#### 1.3.6 Retry Logic

```
Intentos maximos: 5
Backoff: exponencial con jitter

  delay(intento) = min(baseDelay * 2^intento, maxDelay) * (0.75 + random() * 0.5)

  Donde:
    baseDelay = 1000ms (1 segundo)
    maxDelay  = 30000ms (30 segundos)
    intento   = 0, 1, 2, 3, 4

  Ejemplo:
    Intento 0: ~1s    (1000 * 1 * jitter)
    Intento 1: ~2s    (1000 * 2 * jitter)
    Intento 2: ~4s    (1000 * 4 * jitter)
    Intento 3: ~8s    (1000 * 8 * jitter)
    Intento 4: ~16s   (1000 * 16 * jitter)

  Errores no reintentables (skipRetry):
    - 401 Unauthorized
    - 403 Forbidden
    - 400 Bad Request
```

#### 1.3.7 Tabla SQLite para Auditoria de Cambios

Añadir tabla `settings_audit` al schema existente en `db.ts`:

```sql
CREATE TABLE IF NOT EXISTS settings_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,        -- 'remote', 'mdm', 'user', 'project'
  action TEXT NOT NULL,        -- 'applied', 'rejected', 'error'
  settings_hash TEXT,          -- SHA256 del settings aplicado
  diff_summary TEXT,           -- Resumen de cambios en JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_settings_audit_date ON settings_audit(created_at);
```

---

### 1.4 MDM (Mobile Device Management)

#### 1.4.1 Concepto

Permitir que administradores de IT distribuyan configuracion de KCode a traves
de sus herramientas MDM existentes (Jamf, Intune, Ansible, etc).

#### 1.4.2 Diseño Multiplataforma

**macOS:**
- Dominio de preferencia: `com.kulvex.kcode`
- Path admin: `/Library/Managed Preferences/{username}/com.kulvex.kcode.plist`
- Path device: `/Library/Managed Preferences/com.kulvex.kcode.plist`
- Lectura: subprocess `plutil -convert json -o - -- {path}`
- Timeout: 5 segundos por operacion

**Windows:**
- Registry admin (HKLM): `HKLM\SOFTWARE\Policies\KCode`
- Registry usuario (HKCU): `HKCU\SOFTWARE\Policies\KCode`
- Valor: `Settings` (tipo REG_SZ, contenido JSON)
- Lectura: subprocess `reg query "HKLM\SOFTWARE\Policies\KCode" /v Settings`
- Timeout: 5 segundos por operacion

**Linux:**
- Path principal: `/etc/kcode/managed-settings.json` (ya existe parcialmente)
- Drop-ins: `/etc/kcode/managed-settings.d/*.json`
- Merge: archivo base tiene menor prioridad, drop-ins se ordenan alfabeticamente
  (el ultimo alfabeticamente tiene mayor prioridad)

#### 1.4.3 Flujo de Carga

```
INICIO (evaluacion temprana del modulo, antes de UI)
  |
  v
[1] Detectar plataforma (process.platform)
  |
  +-- 'darwin' --> Intentar leer plist paths en paralelo:
  |                a) /Library/Managed Preferences/{user}/{domain}.plist
  |                b) /Library/Managed Preferences/{domain}.plist
  |                Prioridad: (a) > (b). Primer path que exista gana.
  |                Si no existe ninguno, retornar null.
  |
  +-- 'win32'  --> Intentar leer registry en paralelo:
  |                a) HKLM\SOFTWARE\Policies\KCode
  |                b) HKCU\SOFTWARE\Policies\KCode
  |                Prioridad: (a) > (b). Primer key que exista gana.
  |
  +-- 'linux'  --> Leer /etc/kcode/managed-settings.json
  |                Leer todos los *.json en /etc/kcode/managed-settings.d/
  |                Merge: base < drop-in-a.json < drop-in-b.json < drop-in-z.json
  |
  v
[2] Parsear JSON resultado
  |
  +-- Valido? --> Validar contra ManagedPolicy schema (Zod)
  |   |
  |   +-- Valido --> Cache en memoria para la sesion
  |   +-- Invalido --> Log error, retornar null
  |
  +-- Parse error --> Log error, retornar null
  |
  v
[3] Retornar ManagedPolicy | null
```

#### 1.4.4 Optimizaciones

- **Fast-path check**: Antes de lanzar subprocess, verificar con `existsSync()`
  si el archivo/path existe. Evita el overhead de ~5ms por subprocess innecesario.
- **Cache de sesion**: Una vez leido, cachear en variable de modulo. Solo releer
  si se llama `clearMdmCache()` (para hot-reload).
- **Paralelismo**: Lanzar todas las lecturas de path en paralelo con `Promise.all()`.

#### 1.4.5 Formato del Plist (macOS)

Ejemplo de perfil MDM que un admin de IT desplegaria:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>permissionMode</key>
  <string>auto</string>
  <key>blockedTools</key>
  <array>
    <string>WebFetch</string>
    <string>WebSearch</string>
  </array>
  <key>maxBudgetUsd</key>
  <real>100.0</real>
  <key>auditLogging</key>
  <true/>
</dict>
</plist>
```

---

### 1.5 Policy Limits (Rate Limiting y Quotas)

#### 1.5.1 Concepto

El servidor central define restricciones de uso que se aplican a nivel de
organizacion. A diferencia de remote settings (configuracion), policy limits
son restricciones binarias (permitido/denegado).

#### 1.5.2 Endpoint

**URL:** `GET {KCODE_SETTINGS_URL}/api/v1/policy-limits`

**Response 200:**
```json
{
  "restrictions": {
    "allow_remote_sessions": { "allowed": true },
    "allow_web_access": { "allowed": false },
    "allow_feedback": { "allowed": true },
    "allow_local_models": { "allowed": true },
    "max_sessions_per_day": { "allowed": true, "limit": 50 },
    "max_tokens_per_day": { "allowed": true, "limit": 1000000 }
  }
}
```

#### 1.5.3 Modelo de Fail-Open vs Fail-Closed

```
Por defecto: FAIL OPEN
  - Si no hay cache Y no hay red: todas las policies = allowed
  - Si la policy es desconocida: allowed
  - Razon: no bloquear al desarrollador por problemas de red

Excepcion: Policies criticas FAIL CLOSED cuando no hay cache:
  - "allow_feedback" --> denegado si no hay cache
  - Razon: compliance (HIPAA, SOC2) requiere que ciertas features
           esten explicitamente habilitadas

Configurable via:
  KCODE_POLICY_FAIL_MODE=open|closed  (default: open)
```

#### 1.5.4 Flujo de Verificacion en Runtime

```typescript
// Pseudocodigo - NO es implementacion final
function isPolicyAllowed(policyName: string): boolean {
  const cache = getPolicyCache()

  // Sin cache disponible
  if (!cache) {
    if (CRITICAL_POLICIES.includes(policyName)) {
      return false  // fail closed para policies criticas
    }
    return true  // fail open para el resto
  }

  // Policy no definida en el servidor
  const restriction = cache.restrictions[policyName]
  if (!restriction) {
    return true  // policy desconocida = permitida
  }

  return restriction.allowed
}
```

#### 1.5.5 Integracion con Funcionalidades Existentes

Puntos de insercion en el codigo actual:

| Policy | Donde insertar check | Archivo actual |
|--------|---------------------|----------------|
| `allow_web_access` | Antes de ejecutar WebFetch/WebSearch | `src/tools/web-fetch.ts`, `src/tools/web-search.ts` |
| `allow_remote_sessions` | En startup de remote mode | `src/index.ts` (cuando se implemente Feature 5) |
| `allow_feedback` | En comando /feedback | `src/ui/actions/info-actions.ts` |
| `allow_local_models` | En model-manager setup | `src/core/model-manager.ts` |
| `max_sessions_per_day` | En inicio de sesion | `src/index.ts` runMain() |
| `max_tokens_per_day` | En conversation loop | `src/core/conversation.ts` antes de API call |

#### 1.5.6 Cache y Polling

Misma estrategia que remote settings:
- Cache en `~/.kcode/policy-limits.json`
- Polling cada 1 hora
- ETag-based caching
- Retry con backoff exponencial
- Permisos 0o600 en el archivo

---

### 1.6 OAuth Flow Completo

#### 1.6.1 Concepto

Implementar OAuth2 con PKCE (Proof Key for Code Exchange) para autenticacion
segura sin exponer client secrets. Soportar multiples providers (Kulvex Console,
GitHub, custom enterprise IdP).

#### 1.6.2 Flujo OAuth2 PKCE

```
[1] Usuario ejecuta: kcode login
    |
    v
[2] Generar PKCE challenge:
    - code_verifier: 128 bytes aleatorios, base64url encoded
    - code_challenge: SHA256(code_verifier), base64url encoded
    - state: 32 bytes aleatorios, base64url encoded (proteccion CSRF)
    |
    v
[3] Abrir navegador con URL de autorizacion:
    {auth_url}/authorize?
      response_type=code&
      client_id={client_id}&
      redirect_uri=http://127.0.0.1:{port}/callback&
      scope=kcode:read kcode:write&
      state={state}&
      code_challenge={code_challenge}&
      code_challenge_method=S256
    |
    v
[4] Iniciar servidor HTTP temporal en 127.0.0.1:{port}
    - Puerto: buscar libre entre 19000-19999
    - Timeout: 5 minutos (luego abortar)
    - Solo acepta conexiones de 127.0.0.1
    |
    v
[5] Usuario autoriza en navegador --> redirect a callback
    |
    v
[6] Servidor recibe callback:
    GET /callback?code={auth_code}&state={state}
    |
    +-- Validar state == state original (proteccion CSRF)
    +-- Si no coincide: error, abortar
    |
    v
[7] Intercambiar code por tokens:
    POST {token_url}/token
    Body (form-urlencoded):
      grant_type=authorization_code
      code={auth_code}
      redirect_uri=http://127.0.0.1:{port}/callback
      client_id={client_id}
      code_verifier={code_verifier}
    |
    v
[8] Recibir tokens:
    {
      "access_token": "...",
      "refresh_token": "...",
      "expires_in": 3600,
      "token_type": "Bearer",
      "scope": "kcode:read kcode:write"
    }
    |
    v
[9] Almacenar tokens de forma segura
    |
    v
[10] Cerrar servidor temporal, mostrar "Login exitoso" en terminal
```

#### 1.6.3 Token Storage

**Jerarquia de almacenamiento seguro:**

1. **macOS**: Keychain via `security` CLI
   ```bash
   # Guardar
   security add-generic-password -a "kcode" -s "kcode-oauth" -w "{token_json}" -U
   # Leer
   security find-generic-password -a "kcode" -s "kcode-oauth" -w
   # Borrar
   security delete-generic-password -a "kcode" -s "kcode-oauth"
   ```

2. **Linux**: Secret Service (GNOME Keyring / KWallet) via `secret-tool` CLI
   ```bash
   # Guardar
   echo -n "{token_json}" | secret-tool store --label="KCode OAuth" service kcode type oauth
   # Leer
   secret-tool lookup service kcode type oauth
   ```
   Fallback si no hay keyring: archivo cifrado `~/.kcode/tokens.enc`
   con clave derivada de machine-id + user salt.

3. **Windows**: Credential Manager via `cmdkey` o `powershell`
   ```powershell
   # Guardar (via PowerShell)
   [System.Management.Automation.PSCredential]::new(...)
   ```

4. **Fallback universal**: `~/.kcode/tokens.json` con permisos 0o600
   + warning al usuario de que es menos seguro.

#### 1.6.4 Token Refresh

```
[Antes de cada API call que requiera auth]
  |
  v
[Token expirado? (expires_at < now - 60s buffer)]
  |
  +-- No --> Usar token actual
  |
  +-- Si --> Intentar refresh
      |
      v
      [Refresh lock activo?]
        |
        +-- Si --> Esperar a que termine (max 10s)
        |
        +-- No --> Adquirir lock
            |
            v
            POST {token_url}/token
            Body:
              grant_type=refresh_token
              refresh_token={refresh_token}
              client_id={client_id}
            |
            v
            [Exito?]
              +-- Si --> Actualizar tokens en store
              |          Liberar lock
              |          Usar nuevo access_token
              |
              +-- No (401) --> Tokens invalidos
                               Borrar tokens
                               Pedir re-login al usuario
                               Liberar lock
```

#### 1.6.5 Integracion con Config

Añadir al `Settings` interface:

```
oauth:
  provider: "kulvex" | "github" | "custom"
  authUrl: string        # URL de autorizacion
  tokenUrl: string       # URL de intercambio de token
  clientId: string       # Client ID (publico, no secret)
  scopes: string[]       # Scopes requeridos
```

Añadir al CLI:
```
kcode login              # Iniciar OAuth flow
kcode logout             # Borrar tokens
kcode auth status        # Mostrar estado de autenticacion
kcode auth refresh       # Forzar refresh de token
```

#### 1.6.6 Prioridad de Auth Token

Nueva jerarquia de autenticacion:

```
1. KCODE_AUTH_TOKEN env var         (token externo, maximo prioridad)
2. KCODE_API_KEY env var            (API key directa)
3. OAuth token del keychain         (NUEVO)
4. apiKey de settings.json          (configuracion manual)
5. Sin auth (solo modelos locales)
```

---

## Feature 2: Bridge/Daemon Mode

### 2.1 Contexto

KCode ya tiene un HTTP server (`http-server.ts`, 921 lineas) con 13 endpoints y
SSE streaming. Tambien tiene una extension de VSCode basica. Lo que falta es:

- Un daemon persistente que se ejecute en background
- Un protocolo bidireccional (no solo request-response)
- Integracion nativa con IDEs (no solo via HTTP)
- Gestion de multiples sesiones simultaneas

### 2.2 Archivos Nuevos a Crear

```
src/
  bridge/
    daemon.ts              (~600 lineas) - Proceso daemon background
    daemon.test.ts         (~300 lineas) - Tests
    protocol.ts            (~300 lineas) - Protocolo de mensajes
    protocol.test.ts       (~200 lineas) - Tests
    session-manager.ts     (~400 lineas) - Gestion multi-sesion
    session-manager.test.ts(~250 lineas) - Tests
    websocket-server.ts    (~350 lineas) - Servidor WebSocket
    websocket-server.test.ts(~200 lineas)- Tests
    permission-bridge.ts   (~200 lineas) - Permisos remotos
    types.ts               (~100 lineas) - Interfaces
    index.ts               (~40 lineas)  - Re-exports
  cli/
    commands/
      daemon.ts            (~150 lineas) - Subcomando CLI
```

### 2.3 Arquitectura del Daemon

#### 2.3.1 Concepto

Un proceso background de larga vida que gestiona sesiones de KCode. Los IDEs
se conectan via WebSocket para interactuar con las sesiones.

```
                    +------------------+
                    |   IDE (VSCode)   |
                    |   IDE (JetBrains)|
                    |   CLI (kcode)    |
                    +--------+---------+
                             |
                        WebSocket
                             |
                    +--------v---------+
                    |   KCode Daemon   |
                    |   (background)   |
                    |                  |
                    |  +--Session 1--+ |
                    |  +--Session 2--+ |
                    |  +--Session N--+ |
                    +------------------+
```

#### 2.3.2 Ciclo de Vida del Daemon

```
[kcode daemon start]
  |
  v
[1] Verificar si ya hay daemon corriendo:
    - Leer ~/.kcode/daemon.pid
    - Verificar proceso: kill(pid, 0)
    |
    +-- Daemon activo --> Mostrar "Daemon ya corriendo en PID {pid}" y salir
    |
    +-- No activo / PID stale -->
        |
        v
[2] Crear daemon:
    - Escribir PID en ~/.kcode/daemon.pid
    - Escribir puerto en ~/.kcode/daemon.port
    - Iniciar servidor WebSocket en puerto libre (19100-19199)
    - Iniciar healthcheck HTTP en mismo puerto /health
    - Log a ~/.kcode/daemon.log (rotacion diaria, max 10MB)
    |
    v
[3] Loop principal:
    - Aceptar conexiones WebSocket
    - Gestionar sesiones
    - Garbage collect sesiones idle (timeout 30 min)
    - Responder healthchecks
    |
    v
[4] Señal de shutdown (SIGTERM, SIGINT, o kcode daemon stop):
    - Notificar clientes conectados: { type: "shutdown" }
    - Cerrar sesiones activas (guardar estado)
    - Borrar daemon.pid y daemon.port
    - Exit(0)
```

#### 2.3.3 Modos de Spawning de Sesiones

```
1. single-session (default para CLI):
   - Una sola sesion en el directorio actual
   - El daemon termina cuando la sesion termina

2. worktree (para trabajo paralelo):
   - Cada sesion obtiene un git worktree aislado
   - Las sesiones no interfieren entre si
   - Los worktrees se limpian al cerrar la sesion

3. shared-dir (para colaboracion IDE):
   - Multiples sesiones en el mismo directorio
   - Comparten filesystem (cuidado con conflictos)
   - Util cuando el IDE quiere multiples conversaciones sobre el mismo proyecto
```

### 2.4 Protocolo WebSocket

#### 2.4.1 Formato de Mensajes

Todos los mensajes son JSON con un campo `type` discriminador:

```typescript
// Tipo base
interface BridgeMessage {
  type: string
  id: string         // UUID unico por mensaje
  sessionId?: string // ID de sesion (null para mensajes globales)
  timestamp: string  // ISO 8601
}
```

#### 2.4.2 Mensajes Cliente --> Daemon

```
1. session.create
   {
     type: "session.create",
     id: "uuid",
     dir: "/path/to/project",
     spawnMode: "single-session" | "worktree" | "shared-dir",
     model?: "claude-sonnet-4-6",
     initialPrompt?: "fix the login bug"
   }

2. session.message
   {
     type: "session.message",
     id: "uuid",
     sessionId: "session-uuid",
     content: "please also update the tests"
   }

3. session.cancel
   {
     type: "session.cancel",
     id: "uuid",
     sessionId: "session-uuid"
   }

4. session.destroy
   {
     type: "session.destroy",
     id: "uuid",
     sessionId: "session-uuid"
   }

5. permission.response
   {
     type: "permission.response",
     id: "uuid",
     sessionId: "session-uuid",
     requestId: "original-request-id",
     allowed: true,
     remember: false    // Si persistir la decision
   }

6. ping
   { type: "ping", id: "uuid" }
```

#### 2.4.3 Mensajes Daemon --> Cliente

```
1. session.created
   {
     type: "session.created",
     id: "uuid",
     sessionId: "session-uuid",
     dir: "/path/to/project",
     model: "claude-sonnet-4-6"
   }

2. session.text
   {
     type: "session.text",
     id: "uuid",
     sessionId: "session-uuid",
     content: "I'll fix the login bug...",
     role: "assistant",
     streaming: true    // true = parcial, false = completo
   }

3. session.tool_use
   {
     type: "session.tool_use",
     id: "uuid",
     sessionId: "session-uuid",
     tool: "Edit",
     input: { file_path: "/src/login.ts", ... },
     status: "running" | "completed" | "error",
     result?: "..."
   }

4. session.thinking
   {
     type: "session.thinking",
     id: "uuid",
     sessionId: "session-uuid",
     content: "Let me analyze the auth flow..."
   }

5. permission.request
   {
     type: "permission.request",
     id: "uuid",
     sessionId: "session-uuid",
     requestId: "request-uuid",
     tool: "Bash",
     input: { command: "npm test" },
     safetyAnalysis: { level: "safe", details: "..." }
   }

6. session.done
   {
     type: "session.done",
     id: "uuid",
     sessionId: "session-uuid",
     tokensUsed: { input: 1500, output: 800 },
     costUsd: 0.03
   }

7. session.error
   {
     type: "session.error",
     id: "uuid",
     sessionId: "session-uuid",
     error: "Model returned 429: rate limited",
     fatal: false
   }

8. pong
   { type: "pong", id: "uuid" }

9. shutdown
   { type: "shutdown", id: "uuid", reason: "daemon stopping" }
```

#### 2.4.4 Diagrama de Secuencia: Sesion Completa

```
IDE                          Daemon                        LLM API
 |                             |                              |
 |-- session.create ---------->|                              |
 |                             |-- crear ConversationManager  |
 |<-- session.created ---------|                              |
 |                             |                              |
 |-- session.message --------->|                              |
 |   "fix login bug"          |-- API call ------------------>|
 |                             |                              |
 |<-- session.thinking --------|<-- thinking stream ----------|
 |<-- session.text (stream) ---|<-- text stream --------------|
 |                             |                              |
 |                             |-- tool_call: Read            |
 |<-- session.tool_use --------|   (auto-approved)            |
 |   status: running           |                              |
 |<-- session.tool_use --------|                              |
 |   status: completed         |                              |
 |                             |                              |
 |                             |-- tool_call: Bash            |
 |<-- permission.request ------|   (requiere aprobacion)      |
 |                             |                              |
 |-- permission.response ----->|                              |
 |   allowed: true             |-- ejecutar Bash              |
 |                             |                              |
 |<-- session.tool_use --------|                              |
 |   status: completed         |                              |
 |                             |-- API call (con resultados)->|
 |<-- session.text (stream) ---|<-- text stream --------------|
 |<-- session.done ------------|                              |
```

### 2.5 Session Manager

#### 2.5.1 Estructura Interna

```
SessionManager
  |
  +-- sessions: Map<sessionId, Session>
  |
  +-- Session:
  |     id: string
  |     dir: string
  |     spawnMode: SpawnMode
  |     conversationManager: ConversationManager  (reutilizar existente)
  |     clients: Set<WebSocket>       (multiples clientes pueden ver misma sesion)
  |     createdAt: Date
  |     lastActivityAt: Date
  |     status: "active" | "idle" | "responding"
  |     worktreePath?: string          (si spawnMode = worktree)
  |
  +-- maxSessions: 20 (configurable)
  +-- idleTimeout: 30 minutos
  +-- gcInterval: 5 minutos
```

#### 2.5.2 Garbage Collection

```
Cada 5 minutos:
  Para cada sesion:
    Si (now - lastActivityAt) > idleTimeout:
      - Notificar clientes: session.done con reason: "idle timeout"
      - Guardar transcript
      - Si worktree: limpiar git worktree
      - Destruir sesion
    Si sesion sin clientes Y status == "idle":
      - Destruir sesion (nadie la esta usando)
```

### 2.6 CLI del Daemon

Añadir subcomando a `src/index.ts`:

```
kcode daemon start [--port PORT] [--log-level debug|info|warn|error]
kcode daemon stop
kcode daemon status
kcode daemon sessions     # Listar sesiones activas
kcode daemon attach <id>  # Conectar terminal a sesion existente
```

### 2.7 Integracion con Extension VSCode

Modificar la extension existente para:

1. **Auto-detectar daemon**: Leer `~/.kcode/daemon.port`, conectar via WebSocket
2. **Fallback a HTTP**: Si no hay daemon, usar el HTTP server existente
3. **Mostrar permisos**: Cuando llega `permission.request`, mostrar notificacion
   nativa de VSCode con botones Accept/Deny
4. **Streaming**: Mostrar texto del asistente en tiempo real en el webview
5. **Multi-sesion**: Permitir multiples conversaciones en diferentes paneles

### 2.8 Seguridad del Daemon

```
1. Solo escuchar en 127.0.0.1 (nunca 0.0.0.0)
2. Token de autenticacion:
   - Generado al iniciar daemon, guardado en ~/.kcode/daemon.token (0o600)
   - Clientes deben enviar: Authorization: Bearer {token}
   - Token rotado en cada reinicio del daemon
3. Limite de conexiones: max 10 clientes simultaneos
4. Rate limiting: max 100 mensajes/minuto por cliente
5. Validacion de paths: no permitir sesiones fuera de home directory
```

---

## Feature 3: Virtualizacion de UI

### 3.1 Contexto

KCode usa `<Static>` de Ink para mensajes completados y renderizado directo
para streaming. Esto funciona bien para conversaciones cortas pero degrada
rendimiento con >100 mensajes (re-renders innecesarios, consumo de memoria).

### 3.2 Archivos a Crear/Modificar

```
src/ui/
  components/
    VirtualMessageList.tsx   (~500 lineas) - NUEVO: Lista virtualizada
    VirtualMessageList.test.tsx (~300 lineas) - Tests
  hooks/
    useVirtualScroll.ts      (~250 lineas) - NUEVO: Hook de scroll virtual
    useVirtualScroll.test.ts (~200 lineas) - Tests
    useMessageSearch.ts      (~200 lineas) - NUEVO: Busqueda en mensajes
    useMessageSearch.test.ts (~150 lineas) - Tests
  components/
    MessageList.tsx          (MODIFICAR)   - Reemplazar con VirtualMessageList
```

### 3.3 Estrategia de Virtualizacion

#### 3.3.1 Concepto

Solo renderizar los mensajes visibles en el viewport del terminal + un buffer
de N mensajes arriba y abajo para scroll suave. Cachear alturas medidas.

```
+================================+
|  Mensaje 1  (no renderizado)   |  <- fuera de viewport
|  Mensaje 2  (no renderizado)   |
|  ...                           |
|  Mensaje 48 (no renderizado)   |
+================================+
|  Mensaje 49 (buffer arriba)    |  <- buffer (renderizado pero no visible)
|  Mensaje 50 (buffer arriba)    |
+--------------------------------+
|  Mensaje 51 (VISIBLE)          |  <- viewport visible
|  Mensaje 52 (VISIBLE)          |
|  Mensaje 53 (VISIBLE)          |
|  Mensaje 54 (VISIBLE)          |
|  Mensaje 55 (VISIBLE)          |
+--------------------------------+
|  Mensaje 56 (buffer abajo)     |  <- buffer (renderizado pero no visible)
|  Mensaje 57 (buffer abajo)     |
+================================+
|  Mensaje 58 (no renderizado)   |  <- fuera de viewport
|  ...                           |
|  Mensaje 200 (no renderizado)  |
+================================+

Configuracion:
  BUFFER_SIZE = 5           mensajes extra arriba y abajo
  VIEWPORT = terminal rows  calculado dinamicamente
```

#### 3.3.2 Algoritmo de Virtualizacion

```
DATOS:
  messages[]: array de todos los mensajes
  heights: Map<messageId, number>    cache de alturas medidas
  scrollOffset: number               offset de scroll en lineas
  terminalRows: number               filas visibles del terminal

CALCULAR RANGO VISIBLE:
  1. totalHeight = sum(heights[msg.id] for msg in messages)
     (usar altura estimada = 3 para mensajes sin medir)

  2. Encontrar primer mensaje visible:
     acumulado = 0
     firstVisible = 0
     for (i = 0; i < messages.length; i++):
       h = heights[messages[i].id] ?? 3  // estimado
       if acumulado + h > scrollOffset:
         firstVisible = i
         break
       acumulado += h

  3. Encontrar ultimo mensaje visible:
     visibleHeight = 0
     lastVisible = firstVisible
     for (i = firstVisible; i < messages.length; i++):
       h = heights[messages[i].id] ?? 3
       visibleHeight += h
       lastVisible = i
       if visibleHeight >= terminalRows:
         break

  4. Aplicar buffer:
     renderStart = max(0, firstVisible - BUFFER_SIZE)
     renderEnd = min(messages.length - 1, lastVisible + BUFFER_SIZE)

  5. Renderizar solo messages[renderStart..renderEnd]

MEDICION DE ALTURAS:
  - Cuando un mensaje se renderiza por primera vez, medir su altura real
  - Guardar en heights cache
  - Invalidar cache cuando cambia el ancho del terminal (columns change)
  - Usar WeakRef o messageId como key para evitar memory leaks
```

#### 3.3.3 Scroll Handling

```
KEYBINDINGS:
  j / ↓           : scroll down 1 linea
  k / ↑           : scroll up 1 linea
  Page Down / Ctrl+D : scroll down media pagina
  Page Up / Ctrl+U   : scroll up media pagina
  g / Home        : scroll al inicio
  G / End         : scroll al final (follow mode)

FOLLOW MODE:
  - Activado por defecto (auto-scroll con nuevos mensajes)
  - Desactivado cuando el usuario scrollea hacia arriba
  - Reactivado cuando el usuario scrollea hasta el final (G / End)
  - Indicador visual: [FOLLOWING] o [SCROLLED: line X/Y]

MOUSE WHEEL (si terminal soporta):
  - Detectar via ANSI escape sequences
  - Scroll proporcional: 3 lineas por tick de rueda
```

#### 3.3.4 Optimizaciones de Rendimiento

```
1. React.memo en cada MessageEntry:
   - Solo re-renderizar si el contenido del mensaje cambio
   - Para mensajes completados, NUNCA re-renderizar

2. Stable closures:
   - Medicion refs deben ser estables (no crear nuevos closures en cada render)
   - Usar useCallback con dependency array correcto

3. Height cache invalidation:
   - Solo invalidar cuando columns cambian (terminal resize)
   - No invalidar en scroll (las alturas no cambian)

4. Batch updates:
   - Agrupar multiples scroll events en un solo render
   - Usar requestAnimationFrame equivalent (setImmediate en Bun)

5. Streaming text optimization:
   - El ultimo mensaje (streaming) se renderiza fuera del sistema virtual
   - Solo el contenido nuevo se actualiza, no todo el mensaje
   - Cuando streaming termina, mover a la lista virtualizada
```

### 3.4 Busqueda en Mensajes

#### 3.4.1 Funcionalidad

```
ACTIVAR: Ctrl+F o /search
  |
  v
[Mostrar barra de busqueda en la parte inferior]
  Input: [_________________________]  [1/15]  [n]ext [p]rev [Esc]
  |
  v
[Busqueda incremental]:
  - Pre-lowercase todo el texto de mensajes (cache)
  - indexOf() para matching (zero allocation por keystroke)
  - Resaltar matches: amarillo para actual, invertido para otros
  |
  v
[Navegacion]:
  n / Enter : siguiente match
  N / Shift+Enter : match anterior
  Esc : cerrar busqueda, volver a posicion original
```

#### 3.4.2 Implementacion del Cache de Busqueda

```
1. Cuando se abre la busqueda:
   - Pre-computar texto lowercased de cada mensaje
   - Cachear en WeakMap<MessageEntry, string>

2. Para cada keystroke:
   - Buscar en el cache lowercased
   - Retornar array de { messageIndex, charOffset }
   - Scroll a primer match

3. Performance targets:
   - <16ms por busqueda en 2000 mensajes
   - Sin allocations en el hot path (reusar buffers)
```

### 3.5 Migracion desde MessageList Actual

**Estrategia: reemplazo gradual**

```
Fase 1: Crear VirtualMessageList como componente separado
Fase 2: Añadir feature flag en App.tsx:
        const MessageComponent = useVirtualScroll ? VirtualMessageList : MessageList
Fase 3: Testing extensivo con conversaciones largas (>500 mensajes)
Fase 4: Hacer VirtualMessageList el default
Fase 5: Eliminar MessageList antiguo
```

---

## Feature 4: Lazy Loading y DCE

### 4.1 Contexto

KCode ya usa dynamic imports para algunas features opcionales (Pro, profiles,
agents), pero la mayoria de modulos se importan estaticamente en `index.ts`.
No hay sistema de feature flags ni dead code elimination.

### 4.2 Archivos a Crear/Modificar

```
src/
  core/
    feature-flags.ts        (~150 lineas) - NUEVO: Sistema de feature flags
    feature-flags.test.ts   (~200 lineas) - Tests
    startup-profiler.ts     (~120 lineas) - NUEVO: Profiler de startup
  index.ts                  (MODIFICAR)   - Convertir imports estaticos a dinamicos
  core/config.ts            (MODIFICAR)   - Añadir feature flags a settings
  build.ts                  (MODIFICAR)   - Integrar DCE en build
```

### 4.3 Sistema de Feature Flags

#### 4.3.1 Diseño

```
Dos tipos de feature flags:

1. BUILD-TIME flags (Dead Code Elimination):
   - Definidos en tiempo de build via Bun's define
   - El bundler elimina ramas muertas
   - Resultado: codigo no usado ni siquiera llega al binario
   - Uso: features experimentales, plataforma-especificas

2. RUNTIME flags (Feature Gates):
   - Definidos en settings o remote config
   - Evaluados en runtime
   - El codigo existe en el binario pero no se ejecuta
   - Uso: features que se activan/desactivan por organizacion
```

#### 4.3.2 Build-time Feature Flags

Modificar `build.ts` para inyectar defines:

```
Configuracion de build (build.ts):
  Bun.build({
    entrypoints: ['src/index.ts'],
    define: {
      'FEATURE_VOICE': 'false',         // Voice mode
      'FEATURE_BRIDGE': 'true',         // Bridge/daemon mode
      'FEATURE_REMOTE': 'false',        // Remote mode
      'FEATURE_ENTERPRISE': 'true',     // Enterprise features
      'FEATURE_TELEMETRY': 'true',      // OpenTelemetry
      'FEATURE_LSP': 'true',           // LSP integration
      'FEATURE_SWARM': 'true',         // Multi-agent swarm
    }
  })

Uso en codigo:
  // feature-flags.ts
  declare const FEATURE_VOICE: boolean
  declare const FEATURE_BRIDGE: boolean
  // ... etc

  // En cualquier modulo:
  if (FEATURE_VOICE) {
    const voice = await import('./voice.js')
    // Este bloque entero se elimina si FEATURE_VOICE=false
  }
```

#### 4.3.3 Runtime Feature Flags

```
// feature-flags.ts

interface FeatureFlags {
  // Flags controlados por remote settings o config
  enableAutoRoute: boolean       // Auto-routing entre modelos
  enableDistillation: boolean    // Aprendizaje de sesiones pasadas
  enableWorldModel: boolean      // Prediccion de errores
  enableCodebaseIndex: boolean   // Indexacion de simbolos
  enableExperimentalTools: boolean
}

// Carga:
// 1. Defaults hardcoded
// 2. Override via ~/.kcode/settings.json -> featureFlags: {}
// 3. Override via remote settings -> featureFlags: {}
// 4. Override via env var -> KCODE_FF_ENABLE_AUTO_ROUTE=true
```

### 4.4 Plan de Conversion a Lazy Loading

#### 4.4.1 Audit de Imports Actuales

Clasificar todos los imports estaticos de `index.ts` en categorias:

```
CRITICO (mantener estatico - necesario para startup):
  - ConversationManager (core del producto)
  - buildConfig (necesario antes de todo)
  - log (logging desde el inicio)
  - TranscriptManager (para resume)

DIFERIBLE (convertir a dynamic import):
  - startServer          --> solo si --serve flag
  - voiceToText          --> solo si --voice flag
  - ModelSetupWizard     --> solo si primer run o kcode setup
  - getRulesManager      --> lazy, cargar despues de config
  - getPluginManager     --> lazy, cargar despues de config
  - getLspManager        --> lazy, cargar despues de config
  - getNarrativeManager  --> lazy, cargar en background
  - registerBuiltinTools --> puede diferirse hasta primer prompt
  - closeDb              --> solo en shutdown
  - shutdownMcpManager   --> solo en shutdown

SUBCOMANDOS (ya lazy via commander .action()):
  - setup, models, pro, server, doctor, stats, etc.
  - Ya estan correctamente lazy-loaded
```

#### 4.4.2 Patron de Conversion

```
ANTES (estatico):
  import { startServer } from "./core/http-server.js"
  // ... startServer siempre en memoria, aunque nunca se use

DESPUES (lazy):
  // Solo importar cuando se necesita
  async function getServer() {
    const { startServer } = await import("./core/http-server.js")
    return startServer
  }

  // En el punto de uso:
  if (options.serve) {
    const startServer = await getServer()
    await startServer(config, port)
  }
```

#### 4.4.3 Orden de Inicializacion Optimizado

```
FASE 1 - Inmediato (< 50ms):
  [1] Process handlers (uncaughtException, signals)
  [2] CLI parsing (commander)
  [3] Fast-path exits (--version, --help)

FASE 2 - Config (< 100ms):
  [4] loadConfig() - settings files
  [5] loadManagedPolicy() - /etc/kcode/policy.json (solo si existe)
  [6] Feature flag resolution

FASE 3 - Core (< 200ms):
  [7] Database connection (SQLite)
  [8] TranscriptManager init

FASE 4 - Background (async, no bloquea UI):
  [9] Plugin discovery
  [10] MCP server connections
  [11] LSP server detection
  [12] Remote settings fetch
  [13] Narrative manager warmup
  [14] Codebase indexer (si habilitado)

FASE 5 - On-demand (cuando se necesita):
  [15] Tool registration (justo antes del primer prompt)
  [16] Model setup wizard (si no configurado)
  [17] Voice module (si --voice)
  [18] HTTP server (si --serve)
```

### 4.5 Startup Profiler

#### 4.5.1 Diseño

```
// startup-profiler.ts

Proposito: Medir tiempo de cada fase de startup para identificar bottlenecks.

API:
  profileCheckpoint(name: string): void
  getProfileReport(): ProfileEntry[]
  printProfileReport(): void

Storage:
  Array de { name, timestamp, deltaFromPrevious }

Activacion:
  - Siempre activo en dev mode
  - Activado via KCODE_PROFILE_STARTUP=1 en produccion
  - Output al final de init o via kcode doctor

Ejemplo de output:
  Startup Profile:
    process_start          0ms
    cli_parsed            12ms  (+12ms)
    config_loaded         45ms  (+33ms)
    db_connected          52ms  (+7ms)
    tools_registered      89ms  (+37ms)
    ui_rendered          134ms  (+45ms)
    plugins_loaded       256ms  (+122ms)  [background]
    mcp_connected        412ms  (+156ms)  [background]
    total_to_interactive 134ms
```

#### 4.5.2 Integracion con `kcode doctor`

Añadir seccion de performance a doctor:

```
kcode doctor output:
  ...
  Performance:
    Startup time: 134ms (target: <200ms)  [OK]
    Config load: 33ms                      [OK]
    Plugin load: 122ms                     [SLOW - consider disabling unused plugins]
    MCP connect: 156ms                     [OK - background]
  ...
```

---

## Feature 5: Remote Mode

### 5.1 Contexto

KCode no tiene soporte de ejecucion remota. El unico acceso remoto es el HTTP
server para IDEs. Se necesita:

- Ejecutar KCode en un servidor remoto via SSH
- Sincronizar archivos entre local y remoto
- Streaming de resultados en tiempo real
- Gestion de sesiones remotas

### 5.2 Archivos a Crear

```
src/
  remote/
    remote-session.ts        (~600 lineas) - Gestion de sesiones remotas
    remote-session.test.ts   (~350 lineas) - Tests
    ssh-transport.ts         (~400 lineas) - Transporte SSH
    ssh-transport.test.ts    (~250 lineas) - Tests
    file-sync.ts             (~350 lineas) - Sincronizacion de archivos
    file-sync.test.ts        (~200 lineas) - Tests
    remote-permission.ts     (~200 lineas) - Permisos en sesion remota
    remote-permission.test.ts(~150 lineas) - Tests
    types.ts                 (~80 lineas)  - Interfaces
    index.ts                 (~40 lineas)  - Re-exports
  cli/
    commands/
      remote.ts              (~200 lineas) - Subcomando CLI
```

### 5.3 Arquitectura

#### 5.3.1 Vision General

```
+------------------+          SSH          +------------------+
|   Local Machine  | <==================> |  Remote Machine  |
|                  |                       |                  |
|  kcode remote    |                       |  kcode-agent     |
|  (TUI cliente)   |                       |  (headless)      |
|                  |                       |                  |
|  File watcher    | ---- file sync -----> |  Working dir     |
|  Permission UI   | <--- results -------- |  Tool execution  |
|  Display output  | <--- streaming ------ |  LLM API calls   |
+------------------+                       +------------------+
```

#### 5.3.2 Modos de Operacion

```
1. REMOTE EXECUTION (kcode remote connect):
   - KCode corre en el servidor remoto
   - Terminal local solo muestra output y maneja input
   - Archivos estan en el servidor
   - Ideal: servidor con GPU para modelos locales

2. LOCAL-REMOTE HYBRID (kcode remote sync):
   - KCode corre localmente
   - Herramientas Bash se ejecutan en remoto via SSH
   - Archivos se sincronizan bidireccional
   - Ideal: editor local + servidor de build remoto

3. VIEWER MODE (kcode remote watch):
   - Solo observar una sesion remota existente
   - Sin capacidad de enviar mensajes ni interrumpir
   - Ideal: supervision/auditoria
```

### 5.4 Modo 1: Remote Execution

#### 5.4.1 Flujo de Conexion

```
[kcode remote connect user@server:/path/to/project]
  |
  v
[1] Verificar SSH connectivity:
    - ssh -o ConnectTimeout=10 -o BatchMode=yes user@server echo "ok"
    - Si falla: mostrar error con sugerencias (ssh-agent, key perms)
    |
    v
[2] Verificar KCode en remoto:
    - ssh user@server "which kcode || echo NOT_FOUND"
    |
    +-- NOT_FOUND --> Ofrecer instalar:
    |   "KCode no esta instalado en el servidor. Instalar? [s/n]"
    |   Si acepta: ssh user@server "curl -fsSL https://install.kulvex.dev | bash"
    |
    +-- Encontrado --> Verificar version compatible:
        ssh user@server "kcode --version"
        Si version < minima: warning
    |
    v
[3] Iniciar agente remoto:
    ssh -t user@server "kcode serve --headless --port 0 --dir /path/to/project"
    |
    El agente imprime en stdout: { "port": 19150, "token": "abc123" }
    |
    v
[4] Crear tunel SSH:
    ssh -N -L {localPort}:127.0.0.1:{remotePort} user@server
    |
    v
[5] Conectar via WebSocket:
    ws://127.0.0.1:{localPort}
    Headers: Authorization: Bearer {token}
    |
    v
[6] Iniciar TUI local:
    - Mismo protocolo que Bridge Mode (Feature 2)
    - Input local --> WebSocket --> agente remoto --> LLM API
    - Resultados remotos --> WebSocket --> display local
    |
    v
[7] Cleanup al desconectar:
    - Ctrl+C local --> enviar session.cancel al remoto
    - Cerrar WebSocket
    - Matar tunel SSH
    - Opcionalmente matar agente remoto (o dejarlo para resume)
```

#### 5.4.2 Manejo de Desconexion

```
[Conexion SSH se pierde]
  |
  v
[1] Detectar: WebSocket close event o SSH tunnel exit
  |
  v
[2] Mostrar en TUI: "Conexion perdida. Reconectando..."
  |
  v
[3] Intentar reconectar:
    Retry cada 5 segundos, hasta 12 intentos (1 minuto total)
    |
    +-- Exito --> Resumir sesion desde ultimo mensaje conocido
    |             (el agente remoto sigue vivo con la sesion)
    |
    +-- Fallo despues de 12 intentos -->
        "No se pudo reconectar. La sesion remota sigue activa."
        "Para reconectar: kcode remote resume user@server --session {id}"
        "Para ver sesiones: kcode remote sessions user@server"
```

### 5.5 Modo 2: Local-Remote Hybrid (Sync)

#### 5.5.1 Sincronizacion de Archivos

```
ESTRATEGIA: rsync bidireccional con watchman/inotify

Configuracion (.kcode/remote.json):
  {
    "host": "user@server",
    "remoteDir": "/home/user/project",
    "syncExclude": [
      "node_modules/", ".git/objects/", "dist/", "*.pyc",
      ".kcode/", "__pycache__/"
    ],
    "syncInterval": 2000,     // ms entre syncs automaticos
    "syncOnSave": true        // sync inmediato al guardar
  }

FLUJO:
  [Inicio]
    |
    v
  [1] Sync inicial: local --> remoto (full rsync)
      rsync -avz --delete --exclude-from=.kcode/sync-exclude \
        /local/project/ user@server:/remote/project/
    |
    v
  [2] Watcher local (Bun.watch o chokidar):
      - Detectar cambios en archivos locales
      - Debounce: 500ms
      - Sync incremental: solo archivos cambiados
      rsync -avz --files-from=changed.txt /local/ user@server:/remote/
    |
    v
  [3] Watcher remoto (via ssh + inotifywait):
      - Detectar cambios hechos por herramientas remotas
      - Sync reverso: remoto --> local
      - Solo archivos modificados por KCode (no node_modules, etc.)
    |
    v
  [4] Conflict resolution:
      - Si mismo archivo modificado local Y remoto:
        Regla: el cambio mas reciente gana
        Backup del perdedor en .kcode/sync-conflicts/
        Warning al usuario
```

#### 5.5.2 Ejecucion Remota de Bash

```
Cuando KCode decide ejecutar Bash tool:

NORMAL (local):
  BashTool -> spawn("bash", ["-c", command], { cwd })

REMOTE HYBRID:
  BashTool -> ssh user@server "cd /remote/project && bash -c '...command...'"

IMPLEMENTACION:
  - Wrapper en BashTool que detecta si hay remote config activo
  - Si remote: ejecutar via SSH en lugar de local
  - Stdout/stderr streaming via SSH channel
  - Exit code preservado
  - Working directory: remoteDir
  - Environment: variables de remote config

EXCEPCION - Comandos locales (no ejecutar remotamente):
  - git (ejecutar local, el repo esta aqui)
  - kcode (meta-comandos)
  - Comandos configurados en syncExclude.localCommands[]
```

### 5.6 Modo 3: Viewer Mode

```
[kcode remote watch user@server --session {id}]
  |
  v
[1] Conectar via SSH tunnel + WebSocket (igual que Mode 1)
  |
  v
[2] Enviar mensaje de subscripcion:
    { type: "session.subscribe", sessionId: id, mode: "viewer" }
  |
  v
[3] Recibir stream de eventos:
    - session.text (ver lo que el asistente escribe)
    - session.tool_use (ver herramientas ejecutadas)
    - session.thinking (ver thinking, si habilitado)
    - session.done (sesion terminada)
  |
  v
[4] Modo read-only:
    - No enviar mensajes
    - Ctrl+C NO cancela la sesion remota (solo cierra el viewer)
    - Scroll, busqueda, y copy funcionan normal
```

### 5.7 CLI

```
kcode remote connect user@server:/path   # Modo 1: ejecucion remota
kcode remote sync user@server:/path      # Modo 2: sync + ejecucion hibrida
kcode remote watch user@server --session ID  # Modo 3: viewer
kcode remote sessions user@server        # Listar sesiones remotas
kcode remote resume user@server --session ID # Reconectar a sesion
kcode remote install user@server         # Instalar KCode en remoto
```

### 5.8 Seguridad

```
1. Solo SSH como transporte (no HTTP directo a internet)
2. El agente remoto solo escucha en 127.0.0.1
3. Token de sesion unico por conexion
4. Verificar host key de SSH (no usar -o StrictHostKeyChecking=no)
5. No transmitir API keys por el wire (el remoto usa sus propias keys)
6. Opcion para forzar que el remoto use solo modelos locales:
   kcode remote connect --local-only user@server:/path
7. Audit log de todas las conexiones remotas
```

---

## Feature 6: Telemetria Profesional

### 6.1 Contexto

KCode tiene analytics basico en SQLite (`tool_analytics` table) y metricas
in-memory (`MetricsCollector`). Lo que falta es:

- OpenTelemetry para trazas distribuidas
- Export a backends profesionales (Grafana, Datadog, custom)
- Event queue con buffer para resiliencia
- Sampling configurable
- PII protection
- Correlacion de trazas entre sesiones

### 6.2 Archivos a Crear/Modificar

```
src/
  telemetry/
    otel.ts                  (~400 lineas) - Setup de OpenTelemetry
    otel.test.ts             (~250 lineas) - Tests
    event-queue.ts           (~250 lineas) - Cola de eventos con buffer
    event-queue.test.ts      (~200 lineas) - Tests
    sinks/
      console.ts             (~80 lineas)  - Sink a stdout (dev)
      otlp.ts                (~150 lineas) - Sink OTLP (Grafana, Jaeger)
      datadog.ts             (~150 lineas) - Sink Datadog
      sqlite.ts              (~100 lineas) - Sink a SQLite local
      custom-http.ts         (~120 lineas) - Sink HTTP generico
    sampling.ts              (~100 lineas) - Estrategias de sampling
    pii-filter.ts            (~150 lineas) - Filtrado de PII
    pii-filter.test.ts       (~200 lineas) - Tests
    spans.ts                 (~200 lineas) - Helpers para crear spans
    types.ts                 (~80 lineas)  - Interfaces
    index.ts                 (~60 lineas)  - Re-exports
  core/
    analytics.ts             (MODIFICAR)   - Integrar con event queue
    metrics.ts               (MODIFICAR)   - Exponer via OTEL metrics
```

### 6.3 Arquitectura de Telemetria

#### 6.3.1 Pipeline

```
[Evento en KCode]
  |
  v
[PII Filter] --> Remover/hashear datos sensibles
  |
  v
[Sampling] --> Decidir si el evento se registra (rate sampling)
  |
  v
[Event Queue] --> Buffer en memoria (max 1000 eventos)
  |
  v
[Sinks] --> Enviar a 1+ destinos en paralelo:
  |
  +-- SQLite local (siempre, para analytics offline)
  +-- OTLP endpoint (si configurado: Grafana, Jaeger, etc.)
  +-- Datadog (si configurado)
  +-- Console (solo en dev)
  +-- Custom HTTP (webhook generico)
```

#### 6.3.2 OpenTelemetry Setup

```
COMPONENTES OTEL A USAR:
  - TracerProvider: para tracing distribuido
  - MeterProvider: para metricas (counters, histograms)
  - LoggerProvider: para logs estructurados (opcional)

NO usar el SDK completo de OTEL (demasiado pesado ~400KB).
En su lugar, implementar un cliente OTLP ligero:

  - Protocolo: OTLP/HTTP (JSON) - mas simple que gRPC
  - Endpoint: configurable via KCODE_OTLP_ENDPOINT
  - Headers: configurable via KCODE_OTLP_HEADERS
  - Compression: gzip opcional

ESQUEMA DE TRAZAS:

  kcode.session (trace root)
    |
    +-- kcode.turn (span por turno de conversacion)
    |     |
    |     +-- kcode.llm.request (span por API call)
    |     |     attributes:
    |     |       model, provider, input_tokens, output_tokens,
    |     |       latency_ms, status, cost_usd
    |     |
    |     +-- kcode.tool.execute (span por herramienta)
    |     |     attributes:
    |     |       tool_name, duration_ms, success, error_type
    |     |
    |     +-- kcode.tool.execute (otro tool en mismo turno)
    |
    +-- kcode.turn (siguiente turno)
          |
          +-- ...
```

#### 6.3.3 Event Queue

```
DISEÑO:
  - Buffer circular en memoria: max 1000 eventos
  - Flush periodico: cada 15 segundos
  - Flush por tamano: cuando buffer llega a 100 eventos
  - Flush al cerrar sesion (graceful shutdown)
  - Fire-and-forget: si un sink falla, no reintentar (log warning)
  - Thread-safe: usar queueMicrotask() para async flush

ESTRUCTURA:
  class EventQueue {
    private buffer: TelemetryEvent[]
    private sinks: TelemetrySink[]
    private flushInterval: Timer
    private maxBufferSize: number

    enqueue(event: TelemetryEvent): void
    flush(): Promise<void>
    addSink(sink: TelemetrySink): void
    removeSink(name: string): void
    shutdown(): Promise<void>  // flush final
  }

INTERFACE SINK:
  interface TelemetrySink {
    name: string
    send(events: TelemetryEvent[]): Promise<void>
    shutdown(): Promise<void>
  }
```

#### 6.3.4 Filtrado de PII

```
REGLAS DE FILTRADO:

1. NUNCA incluir en telemetria:
   - Contenido de archivos (file contents)
   - Prompts del usuario (user input text)
   - Respuestas del asistente (assistant output)
   - API keys, tokens, passwords
   - Rutas absolutas de archivos (hashear: SHA256(path))
   - Nombres de archivo si contienen datos sensibles

2. SI incluir (datos operacionales):
   - Nombres de herramientas usadas
   - Duraciones y latencias
   - Conteo de tokens (numerico, no contenido)
   - Costos en USD
   - Nombres de modelos
   - Errores (tipo y codigo, no mensaje completo)
   - Plataforma y version

3. HASHEAR antes de enviar:
   - Paths de archivos: SHA256 truncado a 12 chars
   - Session IDs: UUID ya anonimo
   - Queries de busqueda: excluir completamente

IMPLEMENTACION:
  function filterPII(event: TelemetryEvent): TelemetryEvent {
    const filtered = { ...event }

    // Hashear paths
    if (filtered.attributes.file_path) {
      filtered.attributes.file_path_hash =
        sha256(filtered.attributes.file_path).slice(0, 12)
      delete filtered.attributes.file_path
    }

    // Remover contenido
    delete filtered.attributes.content
    delete filtered.attributes.user_input
    delete filtered.attributes.assistant_output
    delete filtered.attributes.api_key

    // Truncar mensajes de error
    if (filtered.attributes.error_message) {
      filtered.attributes.error_message =
        filtered.attributes.error_message.slice(0, 100)
    }

    return filtered
  }
```

#### 6.3.5 Sampling

```
ESTRATEGIAS:

1. Rate-based sampling:
   - Sample 1 de cada N eventos del mismo tipo
   - Configurable por tipo de evento
   - Default: 100% para errores, 10% para tool_use, 1% para llm_request

2. Priority-based sampling:
   - Errores: siempre (100%)
   - Sesiones largas (>20 turns): siempre
   - Sesiones normales: rate-based

3. Budget-based sampling:
   - Max N eventos por minuto
   - Si se excede: drop eventos de baja prioridad primero

CONFIGURACION (en settings.json):
  {
    "telemetry": {
      "enabled": true,
      "level": "standard",  // "off" | "minimal" | "standard" | "verbose"
      "sampling": {
        "default": 0.1,           // 10% default
        "errors": 1.0,            // 100% errores
        "tool_use": 0.1,          // 10% tool use
        "llm_request": 0.01,      // 1% llm requests
        "session_lifecycle": 1.0  // 100% start/end
      },
      "sinks": {
        "sqlite": { "enabled": true },
        "otlp": {
          "enabled": true,
          "endpoint": "https://otel.example.com:4318",
          "headers": { "Authorization": "Bearer xxx" }
        },
        "datadog": {
          "enabled": false,
          "apiKey": "..."
        }
      }
    }
  }
```

#### 6.3.6 Eventos a Trackear

```
SESION:
  kcode.session.start        - Inicio de sesion
  kcode.session.end          - Fin de sesion
  kcode.session.resume       - Resume de sesion anterior
  kcode.session.error        - Error no manejado

API/LLM:
  kcode.llm.request          - Llamada a API de LLM
  kcode.llm.response         - Respuesta recibida
  kcode.llm.error            - Error de API (429, 500, timeout)
  kcode.llm.fallback         - Fallback a modelo alternativo
  kcode.llm.retry            - Reintento de request

TOOLS:
  kcode.tool.execute         - Ejecucion de herramienta
  kcode.tool.error           - Error en herramienta
  kcode.tool.permission      - Evento de permiso (granted/denied)
  kcode.tool.timeout         - Herramienta timeout

ENTERPRISE:
  kcode.settings.remote_load - Carga de remote settings
  kcode.settings.mdm_load    - Carga de MDM settings
  kcode.policy.check         - Verificacion de policy limit
  kcode.auth.login           - Login OAuth
  kcode.auth.refresh         - Refresh de token
  kcode.auth.error           - Error de autenticacion

PERFORMANCE:
  kcode.startup.phase        - Cada fase de startup (con duracion)
  kcode.compact.trigger      - Compactacion de contexto
  kcode.memory.pressure      - Presion de memoria alta

REMOTE:
  kcode.remote.connect       - Conexion remota establecida
  kcode.remote.disconnect    - Desconexion
  kcode.remote.sync          - Sincronizacion de archivos
```

### 6.4 Niveles de Privacidad

```
Respetar la preferencia del usuario con niveles claros:

1. "off" - Sin telemetria (cero datos salen del dispositivo)
   - Solo analytics local en SQLite (para /stats)

2. "minimal" - Solo crashes y errores criticos
   - kcode.session.error
   - kcode.llm.error (solo tipo, sin detalles)

3. "standard" (default) - Metricas operacionales
   - Todo lo de minimal +
   - Lifecycle events (start/end)
   - Metricas de rendimiento (latencias, tokens)
   - Tool usage (nombres, no contenido)

4. "verbose" - Debug completo
   - Todo lo de standard +
   - Cada API call
   - Cada tool execution con detalles
   - Startup profiling

PRIMER USO:
  Preguntar al usuario: "Permitir telemetria anonima? [s/n/configurar]"
  No asumir consentimiento.
```

### 6.5 Integracion con Analytics Existente

```
OBJETIVO: No reemplazar el sistema actual, sino extenderlo.

analytics.ts actual:
  recordToolEvent() --> INSERT en tool_analytics table

NUEVO flujo:
  recordToolEvent() --> INSERT en tool_analytics (sin cambios)
                    --> eventQueue.enqueue() (NUEVO: enviar a sinks)

metrics.ts actual:
  MetricsCollector --> in-memory stats

NUEVO flujo:
  MetricsCollector --> in-memory stats (sin cambios)
                   --> OTEL MeterProvider (NUEVO: exponer como OTEL metrics)

BENEFICIO: Todo el codigo existente sigue funcionando.
           La telemetria profesional es una capa adicional, no un reemplazo.
```

### 6.6 Dashboard de Metricas Local

Añadir a `kcode doctor` y `kcode stats`:

```
kcode stats --telemetry
  Telemetry Status:
    Level: standard
    Sinks: sqlite (active), otlp (active, last flush 2m ago)
    Events buffered: 12
    Events sent (last hour): 847
    Events dropped (sampling): 4,231
    Errors: 0
    PII filter: active (3 fields filtered in last event)
```

---

## RESUMEN DE DEPENDENCIAS ENTRE FEATURES

```
Feature 1 (Enterprise)  <-- independiente, implementar primero
Feature 4 (Lazy/DCE)    <-- independiente, implementar primero
Feature 6 (Telemetria)  <-- independiente, implementar primero

Feature 3 (Virtual UI)  <-- independiente, puede ir en paralelo

Feature 2 (Bridge)      <-- depende de Feature 1 (auth) parcialmente
Feature 5 (Remote)      <-- depende de Feature 2 (protocolo WebSocket)
                         <-- depende de Feature 1 (policy limits: allow_remote)
```

## ORDEN DE IMPLEMENTACION RECOMENDADO

```
Sprint 1 (semanas 1-2):
  [A] Feature 4 - Lazy Loading/DCE (foundation, mejora startup inmediata)
  [B] Feature 6 - Telemetria (observabilidad para todo lo demas)

Sprint 2 (semanas 3-4):
  [C] Feature 1 - Enterprise (remote settings + MDM + OAuth)
  [D] Feature 3 - Virtualizacion UI (independiente, mejora UX)

Sprint 3 (semanas 5-6):
  [E] Feature 2 - Bridge/Daemon (requiere auth de Feature 1)

Sprint 4 (semanas 7-8):
  [F] Feature 5 - Remote Mode (requiere protocolo de Feature 2)

TOTAL ESTIMADO: ~8 semanas con 1-2 desarrolladores
```

---

## NOTAS DE PROPIEDAD INTELECTUAL

Este plan describe conceptos y patrones arquitectonicos de dominio publico:
- OAuth2 PKCE es un estandar abierto (RFC 7636)
- OpenTelemetry es un proyecto open source (Apache 2.0)
- MDM via plist/registry es documentacion publica de Apple/Microsoft
- Virtualizacion de listas es un patron conocido (react-window, etc.)
- WebSocket es un estandar abierto (RFC 6455)
- Long polling es un patron HTTP estandar
- ETag caching es parte de HTTP/1.1 (RFC 7232)

NO se ha copiado codigo fuente. Todos los diseños son reimplementaciones
originales adaptadas a la arquitectura existente de KCode (Bun + SQLite + Ink).
