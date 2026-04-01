# Fase 3: Monetizacion y Go-To-Market — Semanas 7-10

**Prioridad:** NEGOCIO
**Objetivo:** Convertir KCode de proyecto open-source a producto con revenue.
**Version target:** v2.1.0

**Prerequisito:** Fase 2 completada (voice, model management, IDE plugins, docs)

---

## 3.1 Landing Page kulvex.ai

**Tiempo estimado:** 4-5 dias
**Impacto:** CRITICO — sin landing page no hay ventas

### Estructura de la pagina

```
kulvex.ai/
├── / (hero + features + pricing + CTA)
├── /docs (documentacion completa)
├── /blog (tutorials, releases, comparaciones)
├── /changelog (historial de versiones)
├── /download (binarios + instrucciones)
├── /pro (features Pro detalladas)
├── /enterprise (contacto para empresas)
└── /privacy (politica de privacidad)
```

### Tareas

#### Hero section
- [ ] Headline: "AI Coding Assistant. Your Models. Your Machine. Your Privacy."
- [ ] Sub-headline: "KCode works with local LLMs and 6+ cloud APIs. No vendor lock-in. Open source."
- [ ] CTA primario: "Download Free" (link a /download)
- [ ] CTA secundario: "Try Pro — 14 days free" (link a /pro)
- [ ] Terminal GIF/video mostrando KCode en accion (asciinema embed)
- [ ] Badges: "AGPL-3.0", "46+ Tools", "152+ Commands", "100% Offline Capable"

#### Feature comparison
- [ ] Tabla comparativa vs competidores (sin nombrarlos, usar categorias):
  | Feature | Cloud-Only Tools | KCode Free | KCode Pro |
  |---------|-----------------|------------|-----------|
  | Local LLM support | No | Si | Si |
  | Offline mode | No | Si | Si |
  | Multi-provider | Limited | 6+ APIs | 6+ APIs |
  | Open source | No | AGPL-3.0 | AGPL-3.0 |
  | Voice input | Some | Si | Si |
  | Multi-agent | No | 1 agente | 8 agentes |
  | IDE plugins | Yes | VS Code | All IDEs |
  | Price | $20-200/mo | Free | $19/mo |

#### Pricing section
- [ ] **Free tier**:
  - 46 tools, 152+ commands
  - Local LLM support completo
  - 1 agente secuencial
  - 200 sessions/month (subir de 50)
  - 64K context window (subir de 32K)
  - Community support
- [ ] **Pro tier ($19/mo)**:
  - Todo lo free +
  - Multi-agent swarm (8 paralelos)
  - Voice input
  - Browser automation
  - HTTP API (IDE integrations)
  - Transcript search ilimitado
  - Analytics export
  - Email support
  - 14 dias trial gratis
- [ ] **Team tier ($49/mo per seat)**:
  - Todo lo Pro +
  - Shared session history
  - Team analytics dashboard
  - Admin console
  - SSO (SAML/OIDC)
  - Priority support
  - Custom model catalog
- [ ] **Enterprise (contacto)**:
  - Todo lo Team +
  - On-premise deployment
  - SLA garantizado
  - Dedicated support
  - Custom integrations
  - Compliance reports (SOC2, HIPAA)

#### Tech stack del sitio
- [ ] Framework: Astro (static site, fast, SEO-friendly)
- [ ] Hosting: Cloudflare Pages (gratis, CDN global)
- [ ] Analytics: Plausible (privacy-friendly, no cookies)
- [ ] Forms: Formspree o Cloudflare Workers

### Criterio de aceptacion
- kulvex.ai carga en < 2 segundos
- SEO basico: meta tags, Open Graph, sitemap.xml
- Mobile responsive
- Pricing claro y visible

---

## 3.2 Payment Integration (Stripe)

**Tiempo estimado:** 5-7 dias
**Impacto:** CRITICO — sin payments no hay revenue

### Arquitectura

```
Usuario -> kulvex.ai/pro -> Stripe Checkout -> Webhook -> API -> Genera Pro Key -> Email
```

### Tareas

#### Backend (Cloudflare Workers o similar)
- [ ] Crear API en `https://kulvex.ai/api/`:
  - `POST /api/checkout` — Crea Stripe Checkout session
  - `POST /api/webhook` — Recibe Stripe webhooks
  - `GET /api/pro/validate` — Valida Pro key (ya existe, mejorar)
  - `POST /api/pro/activate` — Activa key post-pago
  - `POST /api/pro/deactivate` — Cancela suscripcion
  - `GET /api/pro/status` — Estado de suscripcion
- [ ] Stripe Products:
  - `kcode_pro_monthly` — $19/mo, auto-renew
  - `kcode_pro_yearly` — $190/year (save $38, ~17% descuento)
  - `kcode_team_monthly` — $49/mo per seat
  - `kcode_team_yearly` — $490/year per seat
- [ ] Stripe Checkout:
  - Pagina hosted por Stripe (no manejar tarjetas nosotros)
  - Soporte: tarjeta de credito, PayPal, Google Pay, Apple Pay
  - Impuestos automaticos via Stripe Tax
- [ ] Webhook handlers:
  - `checkout.session.completed` — Generar Pro key, enviar email
  - `customer.subscription.updated` — Actualizar estado
  - `customer.subscription.deleted` — Revocar Pro key
  - `invoice.payment_failed` — Notificar usuario, grace period 7 dias
- [ ] Pro key generation:
  - Formato: `kcode_pro_{random_32_chars}_{checksum}`
  - Almacenar en DB: key, customer_id, plan, status, created_at, expires_at
  - Hashear key en DB (nunca plaintext)

#### Frontend (kulvex.ai)
- [ ] Pagina `/pro/checkout`:
  - Seleccion de plan (monthly/yearly, individual/team)
  - Redirect a Stripe Checkout
  - Pagina de exito con key visible + instrucciones
- [ ] Pagina `/pro/manage`:
  - Estado de suscripcion
  - Historial de pagos
  - Cancelar/cambiar plan
  - Descargar facturas
- [ ] Email transaccional (via Stripe o Resend):
  - Bienvenida + Pro key
  - Confirmacion de pago mensual
  - Aviso de pago fallido
  - Confirmacion de cancelacion

#### Integracion con KCode CLI
- [ ] `kcode pro activate <key>` — Guardar key en settings
- [ ] `kcode pro status` — Mostrar plan, expiracion, features
- [ ] `kcode pro checkout` — Abrir URL de checkout en browser
- [ ] `kcode pro manage` — Abrir URL de gestion en browser
- [ ] `kcode pro deactivate` — Desactivar y limpiar cache local

### Criterio de aceptacion
- Flujo completo: checkout -> pago -> key generada -> activada en CLI
- Webhook maneja todos los estados de Stripe
- Grace period de 7 dias para pago fallido
- Facturas disponibles via Stripe portal

---

## 3.3 Free Tier Generoso

**Tiempo estimado:** 1-2 dias
**Impacto:** Alto — un free tier restrictivo mata la adopcion

### Cambios en `src/core/pro.ts`

| Limite | Actual | Nuevo | Razon |
|--------|--------|-------|-------|
| Sessions/month | 50 | 200 | 50 es muy poco para evaluacion seria |
| Context window | 32K | 64K | 32K limita modelos modernos con 128K+ |
| Agentes | 1 secuencial | 1 secuencial | Mantener como incentivo Pro |
| Transcript search | 72h | 7 dias | 72h es frustrante |
| Tools | Todos | Todos | No limitar tools en free |
| Slash commands | Todos | Todos | No limitar commands en free |
| Local LLM | Sin limite | Sin limite | Es el core value |
| Cloud API | Sin limite | Sin limite | Usuario paga su propia API key |

### Tareas

- [ ] Actualizar limites en `pro.ts`
- [ ] Actualizar docs y landing page con nuevos limites
- [ ] Agregar mensaje amigable cuando se alcanza un limite:
  ```
  Has alcanzado 200 sesiones este mes (free tier).
  Upgrade a Pro por $19/mo para sesiones ilimitadas: kcode pro checkout
  ```
- [ ] No bloquear abruptamente — dar warning a 80% y 95% antes de bloquear

### Criterio de aceptacion
- Usuario free puede trabajar productivamente todo el mes
- Mensajes de upgrade son informativos, no agresivos
- No hay limites artificiales en features locales (modelos, tools)

---

## 3.4 Trial de 14 Dias

**Tiempo estimado:** 2-3 dias
**Impacto:** Alto — sin trial, nadie prueba features Pro

### Tareas

- [ ] Crear endpoint `POST /api/pro/trial`:
  - Input: email
  - Output: trial key con expiracion 14 dias
  - Limite: 1 trial por email (verificar en DB)
  - No requiere tarjeta de credito
- [ ] Trial key format: `kcode_trial_{random}_{checksum}`
- [ ] `kcode pro trial` — Solicitar trial desde CLI:
  - Pedir email
  - Llamar API
  - Activar key automaticamente
  - Mostrar fecha de expiracion
- [ ] Notificaciones durante el trial:
  - Dia 1: "Bienvenido al trial Pro. Tienes 14 dias para explorar."
  - Dia 10: "Quedan 4 dias de trial. Upgrade: kcode pro checkout"
  - Dia 13: "Manana expira tu trial."
  - Dia 14: "Trial expirado. Gracias por probar. Upgrade: kcode pro checkout"
- [ ] Al expirar: volver a free tier sin perder datos ni configuracion
- [ ] Analytics: track conversion trial -> paid

### Criterio de aceptacion
- Trial se activa en < 30 segundos
- No requiere tarjeta de credito
- Transicion trial -> free es seamless (no pierde nada)
- 1 trial por email (anti-abuse)

---

## 3.5 Community Building

**Tiempo estimado:** 2-3 dias (setup) + ongoing
**Impacto:** Alto — community = retention + word-of-mouth

### Tareas

- [ ] **GitHub Discussions** activado en el repo:
  - Categorias: General, Q&A, Ideas, Show & Tell, Bugs
  - Plantillas de issue: Bug Report, Feature Request, Question
  - ISSUE_TEMPLATE/ con formularios estructurados
- [ ] **Discord server** (o alternativa):
  - Canales: #general, #help, #showcase, #plugins, #models, #announcements
  - Bot de bienvenida con quickstart
  - Roles: User, Pro, Contributor, Maintainer
  - Webhook de GitHub para nuevos releases
- [ ] **Social media**:
  - Twitter/X: @kulvex_ai (anuncios, tips, threads)
  - Reddit: posts en r/LocalLLaMA, r/programming, r/commandline
  - Hacker News: launch post preparado
- [ ] **Content strategy**:
  - Blog post semanal (tutorial, release notes, comparacion)
  - Monthly newsletter para usuarios registrados
  - "KCode Tip of the Day" en Twitter

### Criterio de aceptacion
- Discord/Discussions activo y con reglas claras
- Al menos 1 blog post publicado
- Presencia en Twitter con contenido util

---

## 3.6 Distribution Completa

**Tiempo estimado:** 3-4 dias
**Impacto:** Alto — facilidad de instalacion = adopcion

### Tareas

#### Homebrew
- [ ] Verificar que `brew install kulvex/tap/kcode` funciona end-to-end
- [ ] SHA256 hashes correctos para cada plataforma
- [ ] Auto-update via `brew upgrade kcode`
- [ ] Test en macOS limpio (VM o CI)

#### Binarios directos
- [ ] Pagina `/download` con binarios para:
  - Linux x64 (.tar.gz)
  - Linux ARM64 (.tar.gz)
  - macOS x64 (.tar.gz)
  - macOS ARM64 (.tar.gz)
  - Windows x64 (.zip) — si hay soporte
- [ ] Instrucciones de instalacion one-liner:
  ```bash
  curl -fsSL https://kulvex.ai/install.sh | bash
  ```
- [ ] Script de instalacion que:
  - Detecta OS y arch
  - Descarga binario correcto
  - Verifica SHA256
  - Mueve a /usr/local/bin (o ~/bin si no es root)
  - Agrega al PATH si necesario
  - Ejecuta `kcode doctor` para verificar

#### npm/bun (para devs)
- [ ] Publicar en npm: `npm install -g kcode`
- [ ] Publicar en bun: `bun add -g kcode`
- [ ] Verificar que funciona sin Bun (via npx)

#### Auto-update
- [ ] `kcode update`:
  - Checkear version mas reciente en GitHub Releases
  - Descargar si hay nueva version
  - Verificar SHA256
  - Reemplazar binario
  - Mostrar changelog
- [ ] Notificacion periodica (1x/semana) si hay version nueva disponible
- [ ] Setting para deshabilitar auto-check: `{ "autoUpdate": false }`

### Criterio de aceptacion
- Instalacion funciona en < 2 minutos en Linux y macOS limpios
- `kcode update` actualiza sin problemas
- SHA256 verificado en cada descarga

---

## Entregables Fase 3

| Entregable | Version | Estado |
|---|---|---|
| Landing page kulvex.ai | v2.0.1 | [ ] |
| Stripe integration completa | v2.0.2 | [ ] |
| Free tier ajustado | v2.0.3 | [ ] |
| Trial 14 dias | v2.0.4 | [ ] |
| Community (Discord + Discussions) | v2.0.5 | [ ] |
| Distribution (Homebrew + install.sh + npm) | v2.1.0 | [ ] |

**Al final de Fase 3:** KCode tiene revenue, pagina profesional, community activa, e instalacion simple.
