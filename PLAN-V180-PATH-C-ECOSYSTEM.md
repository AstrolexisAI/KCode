# Plan v1.8.0 — Camino C: Ecosistema y Comunidad

**Fecha:** 2026-03-31
**Autor:** Equipo de Arquitectura
**Estado:** Planificacion
**Estimacion total:** ~10,000-13,000 LoC nuevas
**Filosofia:** Construir una comunidad alrededor de KCode. Los mejores productos
crecen por su ecosistema, no solo por sus features.

---

## INDICE

1. [Feature C1: Plugin SDK](#feature-c1-plugin-sdk)
2. [Feature C2: Community Marketplace](#feature-c2-community-marketplace)
3. [Feature C3: KCode Cloud](#feature-c3-kcode-cloud)
4. [Feature C4: Extension API](#feature-c4-extension-api)
5. [Feature C5: Multi-language CLI](#feature-c5-multi-language-cli)
6. [Feature C6: Analytics & Insights Dashboard](#feature-c6-analytics--insights-dashboard)

---

## Feature C1: Plugin SDK

### 1.1 Contexto

KCode tiene un plugin system funcional pero crear plugins es artesanal:
no hay documentacion formal, no hay CLI de scaffolding, no hay validacion,
no hay sistema de pruebas, y no hay publicacion automatizada.

El Plugin SDK proporciona:
- CLI para crear, testear, y publicar plugins
- Scaffolding automatico de plugins
- Validacion y linting de manifests
- Testing framework para plugins
- Documentacion generada automaticamente

### 1.2 Archivos Nuevos

```
src/
  cli/commands/
    plugin-sdk/
      create.ts                 (~300 lineas) - Scaffolding de plugin
      create.test.ts            (~200 lineas)
      validate.ts               (~250 lineas) - Validacion de plugin
      validate.test.ts          (~200 lineas)
      test-runner.ts            (~300 lineas) - Ejecutor de tests de plugins
      test-runner.test.ts       (~200 lineas)
      publish.ts                (~250 lineas) - Publicar al marketplace
      publish.test.ts           (~200 lineas)
      docs-gen.ts               (~200 lineas) - Generador de documentacion
      docs-gen.test.ts          (~150 lineas)
  core/
    plugin-sdk/
      manifest-schema.ts        (~200 lineas) - JSON Schema completo del manifest
      plugin-api.ts             (~300 lineas) - API expuesta a plugins
      plugin-api.test.ts        (~250 lineas)
      sandbox.ts                (~250 lineas) - Sandbox de ejecucion
      sandbox.test.ts           (~200 lineas)
      types.ts                  (~80 lineas)
```

### 1.3 Scaffolding de Plugin

```typescript
// src/cli/commands/plugin-sdk/create.ts

interface PluginScaffoldConfig {
  name: string;
  description: string;
  author: string;
  license: string;
  components: ('skills' | 'hooks' | 'mcp' | 'output-styles' | 'agents')[];
  language: 'markdown' | 'typescript';  // Markdown = solo prompts, TS = con logica
}

async function createPlugin(config: PluginScaffoldConfig): Promise<void> {
  const dir = join(process.cwd(), `kcode-plugin-${config.name}`);
  mkdirSync(dir, { recursive: true });

  // 1. plugin.json (manifest)
  const manifest = {
    name: config.name,
    version: '0.1.0',
    description: config.description,
    author: config.author,
    license: config.license,
    kcode: '>=1.7.0',
    skills: config.components.includes('skills') ? ['skills/*.md'] : [],
    hooks: config.components.includes('hooks') ? {} : undefined,
    mcpServers: config.components.includes('mcp') ? {} : undefined,
    outputStyles: config.components.includes('output-styles') ? ['output-styles/*.md'] : [],
    agents: config.components.includes('agents') ? ['agents/*.md'] : [],
  };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));

  // 2. Crear directorios de componentes
  for (const component of config.components) {
    mkdirSync(join(dir, component), { recursive: true });

    // Crear archivo de ejemplo
    switch (component) {
      case 'skills':
        writeFileSync(join(dir, 'skills/example.md'), SKILL_TEMPLATE(config.name));
        break;
      case 'hooks':
        manifest.hooks = {
          PostToolUse: [{
            match: { toolName: 'Bash' },
            action: 'command',
            command: 'echo',
            args: ['Tool executed: {{toolName}}'],
          }],
        };
        break;
      case 'mcp':
        manifest.mcpServers = {
          'example-server': {
            command: 'npx',
            args: ['@example/mcp-server'],
            env: {},
          },
        };
        break;
      case 'output-styles':
        writeFileSync(join(dir, 'output-styles/concise.md'), OUTPUT_STYLE_TEMPLATE);
        break;
      case 'agents':
        writeFileSync(join(dir, 'agents/helper.md'), AGENT_TEMPLATE(config.name));
        break;
    }
  }

  // 3. README.md
  writeFileSync(join(dir, 'README.md'), README_TEMPLATE(config));

  // 4. Tests
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests/plugin.test.ts'), TEST_TEMPLATE(config));

  // 5. .gitignore
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.kcode/\n');
}

const SKILL_TEMPLATE = (name: string) => `---
name: example
description: Example skill for ${name}
aliases: [ex]
args:
  - name: target
    description: What to operate on
    required: true
---

Perform the example operation on {{target}}.
Analyze the target and provide a detailed report.
`;

const AGENT_TEMPLATE = (name: string) => `---
name: ${name}-helper
description: Helper agent for ${name} plugin
model: null
tools: [Read, Glob, Grep]
maxTurns: 10
---

You are a helper agent for the ${name} plugin.
Your job is to assist with specialized tasks.
`;
```

### 1.4 Validador de Plugins

```typescript
// src/cli/commands/plugin-sdk/validate.ts

interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
}

interface ValidationIssue {
  code: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
}

async function validatePlugin(dir: string): Promise<ValidationReport> {
  const report: ValidationReport = { valid: true, errors: [], warnings: [], info: [] };

  // 1. Manifest existe y es JSON valido
  const manifestPath = join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    report.errors.push({ code: 'MISSING_MANIFEST', message: 'plugin.json not found' });
    report.valid = false;
    return report;
  }

  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    report.errors.push({ code: 'INVALID_JSON', message: `plugin.json parse error: ${e.message}` });
    report.valid = false;
    return report;
  }

  // 2. Campos requeridos
  for (const field of ['name', 'version', 'description']) {
    if (!manifest[field]) {
      report.errors.push({ code: 'MISSING_FIELD', message: `Missing required field: ${field}`, file: 'plugin.json' });
      report.valid = false;
    }
  }

  // 3. Nombre valido (alphanumeric + hyphens)
  if (manifest.name && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    report.errors.push({ code: 'INVALID_NAME', message: 'Plugin name must be lowercase alphanumeric with hyphens', fix: 'Rename to: ' + manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, '-') });
    report.valid = false;
  }

  // 4. Version es semver valida
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    report.errors.push({ code: 'INVALID_VERSION', message: 'Version must be semver (e.g., 1.0.0)' });
    report.valid = false;
  }

  // 5. Skills existen y tienen frontmatter valido
  if (manifest.skills) {
    for (const pattern of manifest.skills) {
      const files = globSync(pattern, { cwd: dir });
      if (files.length === 0) {
        report.warnings.push({ code: 'NO_SKILLS', message: `No files match pattern: ${pattern}` });
      }
      for (const file of files) {
        const content = readFileSync(join(dir, file), 'utf-8');
        const { frontmatter, errors } = parseFrontmatter(content);
        if (errors.length > 0) {
          report.errors.push({ code: 'INVALID_SKILL', message: `Invalid frontmatter in ${file}`, file });
          report.valid = false;
        }
        if (!frontmatter.name) {
          report.warnings.push({ code: 'SKILL_NO_NAME', message: `Skill ${file} missing name in frontmatter`, file });
        }
      }
    }
  }

  // 6. Hooks referencian eventos validos
  if (manifest.hooks) {
    const validEvents = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Notification', 'Stop', 'ErrorOccurred'];
    for (const event of Object.keys(manifest.hooks)) {
      if (!validEvents.includes(event)) {
        report.warnings.push({ code: 'UNKNOWN_HOOK_EVENT', message: `Unknown hook event: ${event}` });
      }
    }
  }

  // 7. MCP servers tienen command valido
  if (manifest.mcpServers) {
    for (const [name, config] of Object.entries(manifest.mcpServers)) {
      if (!(config as any).command) {
        report.errors.push({ code: 'MCP_NO_COMMAND', message: `MCP server '${name}' missing command` });
        report.valid = false;
      }
    }
  }

  // 8. Path traversal check
  const allPaths = [...(manifest.skills || []), ...(manifest.outputStyles || []), ...(manifest.agents || [])];
  for (const p of allPaths) {
    if (p.includes('..') || p.startsWith('/')) {
      report.errors.push({ code: 'PATH_TRAVERSAL', message: `Unsafe path: ${p}` });
      report.valid = false;
    }
  }

  // 9. Tamaño total
  const totalSize = calculateDirSize(dir);
  if (totalSize > 10_000_000) {
    report.warnings.push({ code: 'LARGE_PLUGIN', message: `Plugin size: ${formatBytes(totalSize)} (recommended: <10MB)` });
  }

  // 10. Info: componentes detectados
  report.info.push({ code: 'SUMMARY', message: `Components: ${Object.keys(manifest).filter(k => ['skills', 'hooks', 'mcpServers', 'outputStyles', 'agents'].includes(k) && manifest[k]).join(', ') || 'none'}` });

  return report;
}
```

### 1.5 Test Runner para Plugins

```typescript
// src/cli/commands/plugin-sdk/test-runner.ts

/**
 * Ejecuta tests de plugins en un entorno aislado.
 *
 * Tests verifican que:
 * 1. El plugin se carga sin errores
 * 2. Los skills se parsean correctamente
 * 3. Los hooks se ejecutan sin errores
 * 4. Los MCP servers arrancan y responden
 * 5. Los output styles se aplican correctamente
 */

interface PluginTestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  duration: number;
  error?: string;
}

async function testPlugin(dir: string): Promise<PluginTestResult[]> {
  const results: PluginTestResult[] = [];
  const manifest = loadManifest(dir);

  // Test 1: Manifest loads correctly
  results.push(await runTest('manifest-load', async () => {
    const m = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8'));
    assert(m.name, 'name is required');
    assert(m.version, 'version is required');
  }));

  // Test 2: Skills parse correctly
  if (manifest.skills) {
    for (const pattern of manifest.skills) {
      const files = globSync(pattern, { cwd: dir });
      for (const file of files) {
        results.push(await runTest(`skill-parse:${file}`, async () => {
          const content = readFileSync(join(dir, file), 'utf-8');
          const { frontmatter } = parseFrontmatter(content);
          assert(frontmatter.name, `${file}: name required in frontmatter`);
          assert(frontmatter.description, `${file}: description required`);
        }));
      }
    }
  }

  // Test 3: Hooks execute without error (dry run)
  if (manifest.hooks) {
    for (const [event, hooks] of Object.entries(manifest.hooks)) {
      for (const hook of hooks as any[]) {
        results.push(await runTest(`hook-dryrun:${event}`, async () => {
          // Verificar que el comando existe
          const cmd = hook.command;
          const result = Bun.spawnSync(['which', cmd]);
          assert(result.exitCode === 0, `Command not found: ${cmd}`);
        }));
      }
    }
  }

  // Test 4: MCP servers start (with timeout)
  if (manifest.mcpServers) {
    for (const [name, config] of Object.entries(manifest.mcpServers)) {
      results.push(await runTest(`mcp-start:${name}`, async () => {
        const proc = Bun.spawn([(config as any).command, ...(config as any).args || []], {
          env: { ...process.env, ...(config as any).env },
          timeout: 5000,
        });
        // Esperar a que arranque (max 5s)
        // Si arranca, OK. Si falla, error.
        const exitCode = await Promise.race([
          proc.exited,
          new Promise(resolve => setTimeout(() => { proc.kill(); resolve(0); }, 5000)),
        ]);
        // exitCode 0 o timeout (killed by us) = OK
      }));
    }
  }

  // Test 5: User-defined tests (bun test en directorio tests/)
  if (existsSync(join(dir, 'tests'))) {
    results.push(await runTest('user-tests', async () => {
      const result = Bun.spawnSync(['bun', 'test'], { cwd: dir, timeout: 30000 });
      if (result.exitCode !== 0) {
        throw new Error(`Tests failed:\n${result.stderr.toString()}`);
      }
    }));
  }

  return results;
}
```

### 1.6 Publisher

```typescript
// src/cli/commands/plugin-sdk/publish.ts

async function publishPlugin(dir: string, registry: string): Promise<PublishResult> {
  // 1. Validar plugin
  const validation = await validatePlugin(dir);
  if (!validation.valid) {
    throw new Error(`Plugin has errors:\n${validation.errors.map(e => e.message).join('\n')}`);
  }

  // 2. Ejecutar tests
  const tests = await testPlugin(dir);
  const failed = tests.filter(t => t.status === 'fail');
  if (failed.length > 0) {
    throw new Error(`${failed.length} tests failed`);
  }

  // 3. Crear tarball
  const manifest = loadManifest(dir);
  const tarball = await createTarball(dir, `${manifest.name}-${manifest.version}.tar.gz`);

  // 4. Calcular SHA256
  const sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(tarball)).digest('hex');

  // 5. Publicar al registry
  const response = await fetch(`${registry}/api/v1/plugins`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Plugin-Name': manifest.name,
      'X-Plugin-Version': manifest.version,
      'X-Plugin-SHA256': sha256,
      'Authorization': `Bearer ${getAuthToken()}`,
    },
    body: readFileSync(tarball),
  });

  if (!response.ok) {
    throw new Error(`Publish failed: ${response.status} ${await response.text()}`);
  }

  return { name: manifest.name, version: manifest.version, sha256 };
}
```

### 1.7 CLI

```bash
# Crear plugin desde scaffold
kcode plugin create my-plugin --skills --hooks

# Validar plugin
kcode plugin validate ./kcode-plugin-my-plugin

# Testear plugin
kcode plugin test ./kcode-plugin-my-plugin

# Publicar al marketplace
kcode plugin publish ./kcode-plugin-my-plugin --registry official

# Generar documentacion
kcode plugin docs ./kcode-plugin-my-plugin --output ./docs
```

### 1.8 Tests y Criterios

- [ ] `kcode plugin create` genera scaffold funcional
- [ ] Validador detecta todos los errores de manifest
- [ ] Test runner ejecuta tests de skills, hooks, MCP
- [ ] Publisher sube tarball al registry con SHA256
- [ ] Plugin generado por scaffold pasa validacion sin modificaciones

---

## Feature C2: Community Marketplace

### 2.1 Contexto

KCode tiene marketplace basico con CDN en v1.7.0. Falta:
- Portal web donde la comunidad publica plugins
- Sistema de reviews y ratings
- Estadisticas de descargas
- Categorias y busqueda
- Verificacion de plugins
- Reportes de abuso

### 2.2 Archivos Nuevos

```
src/
  core/
    marketplace/
      client.ts                 (~350 lineas) - Cliente del marketplace
      client.test.ts            (~250 lineas)
      search.ts                 (~200 lineas) - Busqueda y filtrado
      search.test.ts            (~150 lineas)
      reviews.ts                (~200 lineas) - Sistema de reviews
      reviews.test.ts           (~150 lineas)
      categories.ts             (~100 lineas) - Categorias predefinidas
      publish-flow.ts           (~250 lineas) - Flujo de publicacion
      publish-flow.test.ts      (~200 lineas)
      types.ts                  (~80 lineas)
```

### 2.3 Marketplace API Client

```typescript
// src/core/marketplace/client.ts

interface MarketplacePlugin {
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
    url?: string;
  };
  categories: string[];
  tags: string[];
  downloads: number;
  rating: number;           // 0-5
  reviewCount: number;
  verified: boolean;
  featured: boolean;
  publishedAt: string;
  updatedAt: string;
  size: number;
  sha256: string;
  components: string[];     // ['skills', 'hooks', 'mcp']
  kcode: string;            // Version minima de KCode
  license: string;
  repositoryUrl?: string;
  screenshots?: string[];
}

interface SearchOptions {
  query?: string;
  category?: string;
  tag?: string;
  sort?: 'downloads' | 'rating' | 'newest' | 'updated';
  verified?: boolean;
  page?: number;
  limit?: number;           // default: 20
}

class MarketplaceClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'https://marketplace.kulvex.ai/api/v1') {
    this.baseUrl = baseUrl;
  }

  /** Buscar plugins */
  async search(options: SearchOptions): Promise<{ plugins: MarketplacePlugin[]; total: number }> {
    const params = new URLSearchParams();
    if (options.query) params.set('q', options.query);
    if (options.category) params.set('category', options.category);
    if (options.tag) params.set('tag', options.tag);
    if (options.sort) params.set('sort', options.sort);
    if (options.verified !== undefined) params.set('verified', String(options.verified));
    params.set('page', String(options.page || 1));
    params.set('limit', String(options.limit || 20));

    const response = await fetch(`${this.baseUrl}/plugins?${params}`);
    return response.json();
  }

  /** Obtener detalle de un plugin */
  async getPlugin(name: string): Promise<MarketplacePlugin> {
    const response = await fetch(`${this.baseUrl}/plugins/${name}`);
    if (!response.ok) throw new Error(`Plugin not found: ${name}`);
    return response.json();
  }

  /** Obtener reviews de un plugin */
  async getReviews(name: string, page: number = 1): Promise<{ reviews: Review[]; total: number }> {
    const response = await fetch(`${this.baseUrl}/plugins/${name}/reviews?page=${page}`);
    return response.json();
  }

  /** Publicar review */
  async submitReview(name: string, review: { rating: number; comment: string }): Promise<void> {
    await fetch(`${this.baseUrl}/plugins/${name}/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify(review),
    });
  }

  /** Reportar plugin (abuso, malware, etc.) */
  async reportPlugin(name: string, reason: string): Promise<void> {
    await fetch(`${this.baseUrl}/plugins/${name}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify({ reason }),
    });
  }

  /** Descargar plugin */
  async download(name: string, version?: string): Promise<Buffer> {
    const url = version
      ? `${this.baseUrl}/plugins/${name}/download?version=${version}`
      : `${this.baseUrl}/plugins/${name}/download`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
```

### 2.4 Categorias

```typescript
// src/core/marketplace/categories.ts

const PLUGIN_CATEGORIES = [
  { id: 'development', name: 'Development', icon: '🔧', description: 'Build tools, linters, formatters' },
  { id: 'devops', name: 'DevOps', icon: '🚀', description: 'CI/CD, Docker, Kubernetes, Terraform' },
  { id: 'database', name: 'Database', icon: '🗄️', description: 'SQL, NoSQL, migrations, ORMs' },
  { id: 'testing', name: 'Testing', icon: '🧪', description: 'Test frameworks, coverage, mocking' },
  { id: 'documentation', name: 'Documentation', icon: '📝', description: 'Doc generators, API docs, wikis' },
  { id: 'security', name: 'Security', icon: '🔒', description: 'Auditing, vulnerability scanning' },
  { id: 'ai-ml', name: 'AI/ML', icon: '🤖', description: 'Model management, training, inference' },
  { id: 'languages', name: 'Languages', icon: '💬', description: 'Language-specific tools and helpers' },
  { id: 'productivity', name: 'Productivity', icon: '⚡', description: 'Shortcuts, templates, automation' },
  { id: 'integrations', name: 'Integrations', icon: '🔗', description: 'Third-party service integrations' },
];
```

### 2.5 TUI Browser

```typescript
// Integrar en `kcode plugin browse`

/**
 * Browser interactivo de marketplace en TUI.
 *
 * Layout:
 * ┌─ KCode Marketplace ────────────────────────────────────┐
 * │ Search: [___________________]  Category: [All ▼]       │
 * │ Sort: [Downloads ▼]  Verified only: [x]                │
 * ├────────────────────────────────────────────────────────│
 * │ ★★★★★ 4.8  git-hooks (1.2.0)              ✓ verified │
 * │   Git commit hooks and branch management      ⬇ 1,523 │
 * │                                                        │
 * │ ★★★★☆ 4.2  docker-tools (2.0.1)           ✓ verified │
 * │   Docker build, compose, and debugging        ⬇ 987   │
 * │                                                        │
 * │ ★★★★★ 4.9  kubernetes (1.5.0)             ✓ verified │
 * │   K8s deployment, scaling, and debugging      ⬇ 756   │
 * ├────────────────────────────────────────────────────────│
 * │ [Enter] Install  [i] Details  [↑↓] Navigate  [q] Quit │
 * └────────────────────────────────────────────────────────┘
 */
```

### 2.6 Tests y Criterios

- [ ] `kcode plugin browse` muestra plugins del marketplace
- [ ] Busqueda por nombre y tag funciona
- [ ] Filtrado por categoria y verificacion funciona
- [ ] Install desde marketplace descarga y valida
- [ ] Reviews se publican y se ven correctamente
- [ ] Report de plugins funciona

---

## Feature C3: KCode Cloud

### 3.1 Contexto

Servicio SaaS opcional para equipos. NO reemplaza el uso local — es un add-on.

### 3.2 Archivos Nuevos

```
src/
  core/
    cloud/
      client.ts                 (~400 lineas) - Cliente de KCode Cloud
      client.test.ts            (~300 lineas)
      sync.ts                   (~300 lineas) - Sincronizacion de sesiones
      sync.test.ts              (~250 lineas)
      team.ts                   (~250 lineas) - Gestion de equipos
      team.test.ts              (~200 lineas)
      billing.ts                (~200 lineas) - Facturacion y limites
      billing.test.ts           (~150 lineas)
      types.ts                  (~80 lineas)
```

### 3.3 Funcionalidades del Cloud

```typescript
// src/core/cloud/types.ts

interface KCodeCloudConfig {
  /** URL del servidor cloud */
  url: string;                // default: https://cloud.kulvex.ai
  /** Token de autenticacion */
  token: string;
  /** ID del equipo */
  teamId: string;
  /** Features habilitadas */
  features: {
    sessionSync: boolean;     // Sincronizar sesiones al cloud
    sharedMemory: boolean;    // Memoria compartida entre el equipo
    analytics: boolean;       // Analytics centralizados
    policies: boolean;        // Politicas de equipo
    audit: boolean;           // Log de auditoria
  };
}

interface CloudTeam {
  id: string;
  name: string;
  members: TeamMember[];
  plan: 'free' | 'team' | 'enterprise';
  usage: {
    sessionsThisMonth: number;
    tokensThisMonth: number;
    storageUsedMb: number;
  };
  limits: {
    maxMembers: number;
    maxSessions: number;
    maxStorageMb: number;
    maxTokensPerMonth: number;
  };
}

interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
  lastActive: string;
}
```

### 3.4 Session Sync

```typescript
// src/core/cloud/sync.ts

class SessionSync {
  /** Sincronizar sesion actual al cloud */
  async syncSession(): Promise<void> {
    const sessionData = {
      sessionId: getSessionId(),
      startedAt: getSessionStart(),
      model: getCurrentModel(),
      project: basename(process.cwd()),
      messages: getMessages().map(m => ({
        role: m.role,
        content: m.content,
        // NO enviar tool results completos (puede contener codigo privado)
        // Solo enviar metadata: tool name, duracion, exito/error
        toolMeta: m.toolCalls?.map(tc => ({
          name: tc.name,
          duration: tc.duration,
          success: !tc.error,
        })),
      })),
      stats: {
        tokensUsed: getTokenCount(),
        costUsd: getCost(),
        toolsUsed: getToolStats(),
      },
    };

    await this.cloudClient.post('/api/v1/sessions', sessionData);
  }

  /** Sincronizacion incremental (solo delta desde ultimo sync) */
  async syncDelta(): Promise<void> {
    const lastSyncIndex = this.getLastSyncIndex();
    const newMessages = getMessages().slice(lastSyncIndex);

    if (newMessages.length === 0) return;

    await this.cloudClient.patch(`/api/v1/sessions/${getSessionId()}`, {
      newMessages: newMessages.map(this.sanitizeMessage),
      stats: getCurrentStats(),
    });

    this.setLastSyncIndex(getMessages().length);
  }

  /** Sanitizar mensaje antes de enviar al cloud */
  private sanitizeMessage(msg: Message): any {
    return {
      role: msg.role,
      // Truncar contenido largo (max 2KB por mensaje)
      content: msg.content?.slice(0, 2048),
      timestamp: msg.timestamp,
      // Solo metadata de tools, no inputs/outputs completos
      toolMeta: msg.toolCalls?.map(tc => ({
        name: tc.name,
        success: !tc.error,
      })),
    };
  }
}
```

### 3.5 Shared Team Memory

```typescript
// src/core/cloud/team.ts

class TeamMemory {
  /** Sincronizar memorias del equipo */
  async syncMemories(): Promise<void> {
    // 1. Subir memorias locales con scope='team'
    const localTeamMemories = getMemoriesByScope('team');
    await this.cloudClient.post('/api/v1/team/memories', localTeamMemories);

    // 2. Descargar memorias del equipo
    const remoteMemories = await this.cloudClient.get('/api/v1/team/memories');

    // 3. Merge: remote tiene precedencia si hay conflicto (por timestamp)
    await mergeMemories(localTeamMemories, remoteMemories);
  }

  /** Obtener analytics del equipo */
  async getTeamAnalytics(period: 'day' | 'week' | 'month'): Promise<TeamAnalytics> {
    return this.cloudClient.get(`/api/v1/team/analytics?period=${period}`);
  }

  /** Gestionar politicas del equipo */
  async getTeamPolicies(): Promise<TeamPolicies> {
    return this.cloudClient.get('/api/v1/team/policies');
  }

  async updateTeamPolicies(policies: Partial<TeamPolicies>): Promise<void> {
    await this.cloudClient.patch('/api/v1/team/policies', policies);
  }
}
```

### 3.6 CLI

```bash
# Login al cloud
kcode cloud login

# Ver info del equipo
kcode cloud team

# Invitar miembro
kcode cloud invite user@example.com

# Sincronizar sesion
kcode cloud sync

# Ver analytics del equipo
kcode cloud analytics --period week

# Gestionar politicas
kcode cloud policies
```

### 3.7 Tests y Criterios

- [ ] `kcode cloud login` autentica correctamente
- [ ] Session sync sube datos sanitizados (sin codigo fuente completo)
- [ ] Shared memory se sincroniza entre miembros del equipo
- [ ] Analytics muestra metricas correctas del equipo
- [ ] Politicas de equipo se aplican a todos los miembros

---

## Feature C4: Extension API

### 4.1 Contexto

Permitir que aplicaciones externas se integren con KCode de forma programatica.
Diferente del HTTP server (Pro feature) — esto es un SDK/API publica y documentada.

### 4.2 Archivos Nuevos

```
src/
  core/
    extension-api/
      api.ts                    (~400 lineas) - API principal
      api.test.ts               (~300 lineas)
      events.ts                 (~200 lineas) - Event emitter
      events.test.ts            (~150 lineas)
      middleware.ts             (~200 lineas) - Middleware pipeline
      middleware.test.ts         (~150 lineas)
      schema.ts                 (~150 lineas) - OpenAPI schema
      types.ts                  (~80 lineas)
```

### 4.3 Extension API

```typescript
// src/core/extension-api/api.ts

/**
 * API publica para extensiones de KCode.
 * Disponible via HTTP cuando `kcode serve` esta activo.
 *
 * Endpoints:
 *
 * --- Conversation ---
 * POST /api/ext/v1/messages          - Enviar mensaje
 * GET  /api/ext/v1/messages          - Listar mensajes
 * POST /api/ext/v1/cancel            - Cancelar respuesta
 * GET  /api/ext/v1/stream            - SSE stream de eventos
 *
 * --- Tools ---
 * GET  /api/ext/v1/tools             - Listar tools disponibles
 * POST /api/ext/v1/tools/:name       - Ejecutar tool directamente
 *
 * --- Memory ---
 * GET  /api/ext/v1/memories          - Listar memorias
 * POST /api/ext/v1/memories          - Crear memoria
 * PUT  /api/ext/v1/memories/:id      - Actualizar memoria
 * DELETE /api/ext/v1/memories/:id    - Eliminar memoria
 *
 * --- Config ---
 * GET  /api/ext/v1/config            - Leer config
 * PATCH /api/ext/v1/config           - Actualizar config
 *
 * --- Sessions ---
 * GET  /api/ext/v1/sessions          - Listar sesiones
 * POST /api/ext/v1/sessions          - Crear nueva sesion
 * GET  /api/ext/v1/sessions/:id      - Detalle de sesion
 *
 * --- Health ---
 * GET  /api/ext/v1/health            - Health check
 * GET  /api/ext/v1/info              - Info de la instancia
 */

class ExtensionAPI {
  private middleware: Middleware[] = [];

  /** Registrar middleware (auth, logging, rate limiting) */
  use(mw: Middleware): void {
    this.middleware.push(mw);
  }

  /** Manejar request */
  async handle(req: Request): Promise<Response> {
    // Ejecutar middleware pipeline
    for (const mw of this.middleware) {
      const result = await mw(req);
      if (result) return result; // Middleware corto-circuiteo
    }

    const url = new URL(req.url);
    const path = url.pathname.replace('/api/ext/v1/', '');

    // --- Conversation ---
    if (req.method === 'POST' && path === 'messages') {
      const { content, model, tools } = await req.json();
      const response = await sendUserMessage(content, { model, tools });
      return json(response);
    }

    if (req.method === 'GET' && path === 'stream') {
      // Server-Sent Events stream
      return new Response(
        new ReadableStream({
          start(controller) {
            const handler = (event: any) => {
              controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
            };
            eventEmitter.on('*', handler);
            req.signal.addEventListener('abort', () => {
              eventEmitter.off('*', handler);
              controller.close();
            });
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } },
      );
    }

    // --- Tools ---
    if (req.method === 'POST' && path.startsWith('tools/')) {
      const toolName = path.replace('tools/', '');
      const input = await req.json();
      const result = await executeTool(toolName, input);
      return json(result);
    }

    // --- Memory ---
    if (req.method === 'GET' && path === 'memories') {
      return json(await listMemories());
    }

    if (req.method === 'POST' && path === 'memories') {
      const memory = await req.json();
      await addMemory(memory);
      return json({ status: 'created' });
    }

    // ... etc

    return new Response('Not Found', { status: 404 });
  }
}
```

### 4.4 Event System

```typescript
// src/core/extension-api/events.ts

type ExtensionEvent =
  | { type: 'message.created'; data: { id: string; role: string; content: string } }
  | { type: 'message.streaming'; data: { id: string; delta: string } }
  | { type: 'tool.started'; data: { id: string; name: string } }
  | { type: 'tool.completed'; data: { id: string; name: string; success: boolean } }
  | { type: 'permission.requested'; data: { id: string; tool: string } }
  | { type: 'session.started'; data: { sessionId: string } }
  | { type: 'session.ended'; data: { sessionId: string; stats: SessionStats } }
  | { type: 'model.changed'; data: { from: string; to: string } }
  | { type: 'compact.triggered'; data: { strategy: string } }
  | { type: 'memory.created'; data: { type: string; title: string } }
  | { type: 'error'; data: { message: string; code: string } };

class ExtensionEventEmitter {
  private listeners: Map<string, Set<(event: ExtensionEvent) => void>> = new Map();

  on(eventType: string, handler: (event: ExtensionEvent) => void): void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    this.listeners.get(eventType)!.add(handler);
  }

  off(eventType: string, handler: (event: ExtensionEvent) => void): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  emit(event: ExtensionEvent): void {
    // Emit to specific listeners
    this.listeners.get(event.type)?.forEach(h => h(event));
    // Emit to wildcard listeners
    this.listeners.get('*')?.forEach(h => h(event));
  }
}
```

### 4.5 OpenAPI Schema

```typescript
// src/core/extension-api/schema.ts

/** Generar OpenAPI 3.0 schema automaticamente */
function generateOpenAPISchema(): object {
  return {
    openapi: '3.0.0',
    info: {
      title: 'KCode Extension API',
      version: '1.0.0',
      description: 'API for integrating external applications with KCode',
    },
    servers: [{ url: 'http://localhost:19300/api/ext/v1' }],
    paths: {
      '/messages': {
        post: {
          summary: 'Send a message to KCode',
          requestBody: { content: { 'application/json': { schema: { /* ... */ } } } },
          responses: { 200: { description: 'Message sent successfully' } },
        },
        get: {
          summary: 'List conversation messages',
          // ...
        },
      },
      // ... all endpoints
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}

// Servir en GET /api/ext/v1/openapi.json
```

### 4.6 Tests y Criterios

- [ ] Extension API responde correctamente a todos los endpoints
- [ ] SSE stream emite eventos en tiempo real
- [ ] Auth token previene acceso no autorizado
- [ ] Tool execution via API funciona con permisos
- [ ] OpenAPI schema es valido y completo
- [ ] Rate limiting previene abuso

---

## Feature C5: Multi-language CLI

### 5.1 Contexto

KCode muestra mensajes en ingles. Para expansion global, soportar multiples idiomas
en la interfaz CLI (NO en las respuestas del modelo — eso es decision del modelo).

### 5.2 Archivos Nuevos

```
src/
  i18n/
    index.ts                    (~150 lineas) - Motor de i18n
    index.test.ts               (~120 lineas)
    detector.ts                 (~100 lineas) - Deteccion de idioma
    detector.test.ts            (~80 lineas)
    locales/
      en.ts                     (~400 lineas) - Ingles (base)
      es.ts                     (~400 lineas) - Español
      pt.ts                     (~400 lineas) - Portugues
      fr.ts                     (~400 lineas) - Frances
      de.ts                     (~400 lineas) - Aleman
      zh.ts                     (~400 lineas) - Chino simplificado
      ja.ts                     (~400 lineas) - Japones
      ko.ts                     (~400 lineas) - Coreano
```

### 5.3 Motor de i18n

```typescript
// src/i18n/index.ts

type LocaleKey = keyof typeof import('./locales/en');

interface I18nConfig {
  locale: string;           // 'en', 'es', 'pt', etc.
  fallback: string;         // default: 'en'
}

class I18n {
  private locale: string;
  private messages: Record<string, string>;
  private fallbackMessages: Record<string, string>;

  constructor(config: I18nConfig) {
    this.locale = config.locale;
    this.messages = this.loadLocale(config.locale);
    this.fallbackMessages = this.loadLocale(config.fallback);
  }

  /** Traducir una clave */
  t(key: string, params?: Record<string, string | number>): string {
    let message = this.messages[key] || this.fallbackMessages[key] || key;

    // Interpolacion: "Hello {name}" -> "Hello John"
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        message = message.replace(`{${k}}`, String(v));
      }
    }

    return message;
  }

  /** Pluralizacion */
  tp(key: string, count: number, params?: Record<string, string | number>): string {
    const pluralKey = count === 1 ? `${key}.one` : `${key}.other`;
    return this.t(pluralKey, { ...params, count });
  }
}

// Singleton global
let i18n: I18n;

export function t(key: string, params?: Record<string, string | number>): string {
  return i18n.t(key, params);
}

export function initI18n(locale?: string): void {
  const detectedLocale = locale || detectLocale();
  i18n = new I18n({ locale: detectedLocale, fallback: 'en' });
}
```

### 5.4 Deteccion de Idioma

```typescript
// src/i18n/detector.ts

function detectLocale(): string {
  // 1. Config explicita
  const configLocale = getConfig('locale');
  if (configLocale) return configLocale;

  // 2. Variable de entorno KCODE_LANG
  if (process.env.KCODE_LANG) return process.env.KCODE_LANG;

  // 3. Variables de entorno del sistema
  const envLang = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES;
  if (envLang) {
    // "es_ES.UTF-8" -> "es"
    const match = envLang.match(/^([a-z]{2})/i);
    if (match) return match[1].toLowerCase();
  }

  // 4. Default: ingles
  return 'en';
}
```

### 5.5 Ejemplo de Locale

```typescript
// src/i18n/locales/es.ts

export default {
  // General
  'welcome': 'Bienvenido a KCode',
  'goodbye': 'Hasta luego',
  'error': 'Error',
  'warning': 'Advertencia',
  'success': 'Exito',

  // Session
  'session.started': 'Sesion iniciada',
  'session.resumed': 'Sesion restaurada',
  'session.cost': 'Costo de sesion: ${cost}',
  'session.tokens': '{count} tokens usados',

  // Permission
  'permission.ask': '¿Permitir {tool} ejecutar?',
  'permission.allow': 'Permitir',
  'permission.deny': 'Denegar',
  'permission.always': 'Siempre permitir',
  'permission.bash.dangerous': 'Este comando podria ser peligroso: {command}',

  // Tools
  'tool.executing': 'Ejecutando {tool}...',
  'tool.completed': '{tool} completado en {duration}ms',
  'tool.error': '{tool} fallo: {error}',

  // Compaction
  'compact.starting': 'Compactando contexto...',
  'compact.done': 'Contexto compactado ({strategy})',

  // Voice
  'voice.calibrating': 'Calibrando... (mantente en silencio 2 segundos)',
  'voice.active': 'Modo de voz activo. Habla para interactuar.',
  'voice.no_backend': 'No se encontro backend de voz. Instala whisper-cpp o faster-whisper.',

  // Offline
  'offline.active': 'Modo offline activo',
  'offline.no_model': 'No hay modelo local disponible',
  'offline.blocked': 'Bloqueado: {url} (modo offline activo)',

  // Dashboard
  'dashboard.tests.passing': '{count} tests pasando',
  'dashboard.tests.failing': '{count} tests fallando',
  'dashboard.todos': '{count} TODOs pendientes',

  // Plurals
  'files.one': '{count} archivo',
  'files.other': '{count} archivos',
  'sessions.one': '{count} sesion',
  'sessions.other': '{count} sesiones',

  // Setup
  'setup.detecting': 'Detectando hardware...',
  'setup.recommended': 'Recomendado: {model}',
  'setup.configuring': 'Configurando...',
  'setup.done': 'Configuracion completada',

  // Plugin
  'plugin.installing': 'Instalando {name}...',
  'plugin.installed': '{name} v{version} instalado',
  'plugin.removed': '{name} removido',
};
```

### 5.6 Integracion

Todos los strings visibles al usuario en la TUI deben usar `t()`:

```typescript
// Antes:
console.log('Session started');

// Despues:
console.log(t('session.started'));

// Con parametros:
console.log(t('tool.completed', { tool: 'Bash', duration: 150 }));
// -> "Bash completado en 150ms"

// Plural:
console.log(tp('files', 5));
// -> "5 archivos"
```

### 5.7 Tests y Criterios

- [ ] Deteccion automatica de idioma desde $LANG funciona
- [ ] `kcode --lang es` fuerza idioma español
- [ ] Fallback a ingles para claves sin traduccion
- [ ] Interpolacion de parametros funciona
- [ ] Pluralizacion funciona en todos los idiomas
- [ ] Al menos 3 idiomas completos (en, es, pt)

---

## Feature C6: Analytics & Insights Dashboard

### 6.1 Contexto

KCode tiene analytics basicos en SQLite. Este feature extiende analytics con:
- Insights automaticos (patrones de uso, recomendaciones)
- Export a CSV/JSON para analisis externo
- Graficos ASCII en terminal
- Comparacion de rendimiento entre modelos
- ROI tracking (tiempo ahorrado estimado)

### 6.2 Archivos Nuevos

```
src/
  core/
    insights/
      analyzer.ts               (~350 lineas) - Motor de insights
      analyzer.test.ts          (~250 lineas)
      charts.ts                 (~300 lineas) - Graficos ASCII
      charts.test.ts            (~200 lineas)
      exporter.ts               (~200 lineas) - Export CSV/JSON
      exporter.test.ts          (~150 lineas)
      model-compare.ts          (~250 lineas) - Comparacion de modelos
      model-compare.test.ts     (~200 lineas)
      roi.ts                    (~200 lineas) - ROI tracking
      roi.test.ts               (~150 lineas)
      types.ts                  (~60 lineas)
```

### 6.3 Motor de Insights

```typescript
// src/core/insights/analyzer.ts

interface Insight {
  type: 'recommendation' | 'pattern' | 'alert' | 'achievement';
  title: string;
  description: string;
  data?: any;
  priority: 'low' | 'medium' | 'high';
}

class InsightsAnalyzer {
  /** Generar insights desde analytics */
  async analyze(period: number = 30): Promise<Insight[]> {
    const insights: Insight[] = [];
    const analytics = await getAnalyticsSummary(period);

    // 1. Modelo mas eficiente (mejor ratio calidad/costo)
    const modelStats = await getModelBreakdown(period);
    if (modelStats.length > 1) {
      const bestRatio = modelStats.reduce((best, m) =>
        (m.successRate / m.avgCost) > (best.successRate / best.avgCost) ? m : best
      );
      insights.push({
        type: 'recommendation',
        title: `${bestRatio.model} tiene la mejor relacion calidad/costo`,
        description: `${bestRatio.successRate}% exito a $${bestRatio.avgCost.toFixed(4)} por query`,
        priority: 'medium',
      });
    }

    // 2. Herramientas mas usadas vs menos usadas
    const toolStats = await getToolBreakdown(period);
    const leastUsed = toolStats.filter(t => t.count < 5);
    if (leastUsed.length > 0) {
      insights.push({
        type: 'pattern',
        title: `${leastUsed.length} herramientas casi sin uso`,
        description: `Considera si ${leastUsed.map(t => t.name).join(', ')} son necesarias`,
        priority: 'low',
      });
    }

    // 3. Tasa de error alta en alguna herramienta
    const errorProne = toolStats.filter(t => t.errorRate > 0.3 && t.count > 10);
    for (const tool of errorProne) {
      insights.push({
        type: 'alert',
        title: `${tool.name} tiene ${(tool.errorRate * 100).toFixed(0)}% de errores`,
        description: `${tool.errors} errores en ${tool.count} ejecuciones`,
        priority: 'high',
      });
    }

    // 4. Logros (gamification)
    const totalSessions = analytics.totalSessions;
    const milestones = [10, 50, 100, 500, 1000];
    for (const milestone of milestones) {
      if (totalSessions >= milestone && totalSessions < milestone * 2) {
        insights.push({
          type: 'achievement',
          title: `${milestone} sesiones completadas`,
          description: `Has usado KCode en ${milestone}+ sesiones. ¡Sigue asi!`,
          priority: 'low',
        });
      }
    }

    // 5. Tendencia de uso (creciendo o decreciendo)
    const daily = await getDailyActivity(period);
    if (daily.length >= 14) {
      const firstHalf = daily.slice(0, 7).reduce((s, d) => s + d.count, 0);
      const secondHalf = daily.slice(-7).reduce((s, d) => s + d.count, 0);
      if (secondHalf > firstHalf * 1.5) {
        insights.push({
          type: 'pattern',
          title: 'Uso creciente',
          description: `Tu uso aumento ${((secondHalf / firstHalf - 1) * 100).toFixed(0)}% esta semana`,
          priority: 'low',
        });
      }
    }

    return insights.sort((a, b) => {
      const priority = { high: 3, medium: 2, low: 1 };
      return priority[b.priority] - priority[a.priority];
    });
  }
}
```

### 6.4 Graficos ASCII

```typescript
// src/core/insights/charts.ts

class ASCIICharts {
  /** Grafico de barras horizontal */
  barChart(data: Array<{ label: string; value: number }>, config?: { width?: number; showValue?: boolean }): string {
    const maxValue = Math.max(...data.map(d => d.value));
    const maxWidth = config?.width || 40;
    const maxLabel = Math.max(...data.map(d => d.label.length));

    return data.map(d => {
      const barLen = Math.round((d.value / maxValue) * maxWidth);
      const bar = '█'.repeat(barLen);
      const label = d.label.padEnd(maxLabel);
      const value = config?.showValue !== false ? ` ${d.value}` : '';
      return `${label} │${bar}${value}`;
    }).join('\n');
  }

  /** Sparkline (mini grafico en una linea) */
  sparkline(data: number[]): string {
    const chars = '▁▂▃▄▅▆▇█';
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    return data.map(v => {
      const index = Math.round(((v - min) / range) * (chars.length - 1));
      return chars[index];
    }).join('');
  }

  /** Tabla formateada */
  table(headers: string[], rows: string[][]): string {
    const colWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map(r => (r[i] || '').length))
    );

    const separator = '┼' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┼';
    const formatRow = (cells: string[]) =>
      '│' + cells.map((c, i) => ` ${c.padEnd(colWidths[i])} `).join('│') + '│';

    return [
      separator.replace(/┼/g, '┌').replace(/─/g, '─') + '',
      formatRow(headers),
      separator,
      ...rows.map(formatRow),
      separator.replace(/┼/g, '└'),
    ].join('\n').replace(/┌/g, '┌').replace(/└/g, '└');
  }
}
```

### 6.5 Model Compare

```typescript
// src/core/insights/model-compare.ts

interface ModelComparison {
  model: string;
  sessions: number;
  avgTokensPerSession: number;
  avgCostPerSession: number;
  avgLatencyMs: number;
  successRate: number;
  toolCallsPerSession: number;
}

async function compareModels(period: number = 30): Promise<ModelComparison[]> {
  // Query analytics agrupado por modelo
  // Calcular metricas por modelo
  // Ordenar por score compuesto (calidad * velocidad / costo)
}

function formatComparison(models: ModelComparison[]): string {
  const charts = new ASCIICharts();

  return [
    '## Comparacion de Modelos (ultimos 30 dias)\n',
    charts.table(
      ['Modelo', 'Sesiones', 'Avg Tokens', 'Avg Costo', 'Latencia', 'Exito'],
      models.map(m => [
        m.model,
        String(m.sessions),
        String(m.avgTokensPerSession),
        `$${m.avgCostPerSession.toFixed(4)}`,
        `${m.avgLatencyMs}ms`,
        `${(m.successRate * 100).toFixed(1)}%`,
      ]),
    ),
    '',
    '### Costo por sesion:',
    charts.barChart(models.map(m => ({ label: m.model, value: m.avgCostPerSession * 1000 })), { showValue: true }),
    '',
    '### Tasa de exito:',
    charts.barChart(models.map(m => ({ label: m.model, value: Math.round(m.successRate * 100) })), { showValue: true }),
  ].join('\n');
}
```

### 6.6 ROI Tracking

```typescript
// src/core/insights/roi.ts

interface ROIMetrics {
  totalCostUsd: number;
  estimatedTimeSavedHours: number;
  estimatedValueUsd: number;  // timeSaved * hourlyRate
  roi: number;                // (value - cost) / cost * 100
  topTimeSavers: Array<{
    category: string;
    timeSavedHours: number;
  }>;
}

async function calculateROI(config: { hourlyRate: number; period: number }): Promise<ROIMetrics> {
  const analytics = await getAnalyticsSummary(config.period);

  // Estimacion de tiempo ahorrado por tipo de tool:
  const TIME_SAVINGS_PER_CALL: Record<string, number> = {
    'Edit': 3,          // 3 min por edicion manual
    'Write': 5,         // 5 min por archivo nuevo
    'Bash': 2,          // 2 min por comando investigado
    'Grep': 1,          // 1 min por busqueda manual
    'Glob': 0.5,        // 30s por busqueda de archivos
    'Read': 1,          // 1 min por lectura + comprension
    'WebSearch': 3,     // 3 min por busqueda web manual
    'WebFetch': 2,      // 2 min por fetch + lectura
    'Agent': 15,        // 15 min por tarea delegada
    'default': 1,       // 1 min generico
  };

  let totalMinSaved = 0;
  const categoryTimes: Record<string, number> = {};

  for (const tool of analytics.toolBreakdown) {
    const minsPerCall = TIME_SAVINGS_PER_CALL[tool.name] || TIME_SAVINGS_PER_CALL.default;
    const totalMins = tool.count * minsPerCall;
    totalMinSaved += totalMins;
    categoryTimes[tool.name] = totalMins;
  }

  const hoursSaved = totalMinSaved / 60;
  const valueUsd = hoursSaved * config.hourlyRate;
  const roi = analytics.totalCostUsd > 0
    ? ((valueUsd - analytics.totalCostUsd) / analytics.totalCostUsd) * 100
    : 0;

  return {
    totalCostUsd: analytics.totalCostUsd,
    estimatedTimeSavedHours: hoursSaved,
    estimatedValueUsd: valueUsd,
    roi,
    topTimeSavers: Object.entries(categoryTimes)
      .map(([category, mins]) => ({ category, timeSavedHours: mins / 60 }))
      .sort((a, b) => b.timeSavedHours - a.timeSavedHours)
      .slice(0, 5),
  };
}
```

### 6.7 CLI

```bash
# Ver insights
kcode insights

# Analytics detallados
kcode stats --period 30 --charts

# Comparar modelos
kcode stats models --compare

# ROI report
kcode stats roi --hourly-rate 50 --period 30

# Exportar datos
kcode stats export --format csv --output ./analytics.csv
kcode stats export --format json --output ./analytics.json
```

### 6.8 Tests y Criterios

- [ ] Insights detectan al menos 3 tipos de patrones
- [ ] Graficos ASCII se renderizan correctamente
- [ ] Model compare muestra metricas correctas
- [ ] ROI calcula con hourly rate configurable
- [ ] Export CSV/JSON es valido y completo
- [ ] Sparklines funcionan con datos de 7+ dias

---

## RESUMEN PATH C

| Feature | Archivos | LoC | Tests |
|---------|:--------:|:---:|:-----:|
| C1. Plugin SDK | 12 | ~2,630 | ~1,400 |
| C2. Community Marketplace | 8 | ~1,480 | ~750 |
| C3. KCode Cloud | 8 | ~1,480 | ~900 |
| C4. Extension API | 8 | ~1,580 | ~850 |
| C5. Multi-language CLI | 12 | ~3,630 | ~200 |
| C6. Analytics & Insights | 10 | ~1,760 | ~950 |
| **TOTAL PATH C** | **58** | **~12,560** | **~5,050** |

## ORDEN DE IMPLEMENTACION

```
Semana 1-3:  C1 (Plugin SDK) ───── Base para C2 (marketplace necesita SDK)
    │
Semana 3-4:  C5 (i18n) ─────────── Independiente, mejora UX global
    │
Semana 4-6:  C2 (Marketplace) ──── Depende de C1 para publish flow
    │
Semana 6-8:  C4 (Extension API) ── Independiente, habilita integraciones
    │
Semana 8-10: C6 (Analytics) ────── Independiente, usa datos existentes
    │
Semana 10-13: C3 (Cloud) ────────── Mas complejo, requiere backend server
```

**Dependencias:**
- C2 (Marketplace) depende de C1 (Plugin SDK) para publish
- C3 (Cloud) requiere un backend server separado (no incluido en este plan)
- C1, C4, C5, C6 son independientes entre si

---

## RESUMEN GLOBAL DE LOS 3 CAMINOS

| Camino | Features | Archivos | LoC | Tests | Semanas |
|--------|:--------:|:--------:|:---:|:-----:|:-------:|
| A: Local-First | 6 | 54 | ~10,530 | ~6,220 | 14 |
| B: UX Premium | 6 | 47 | ~12,180 | ~5,300 | 12 |
| C: Ecosistema | 6 | 58 | ~12,560 | ~5,050 | 13 |
| **TOTAL** | **18** | **159** | **~35,270** | **~16,570** | **~39** |

## ORDEN GLOBAL RECOMENDADO (3 caminos en paralelo)

Si hay 3 desarrolladores o equipos, cada uno puede tomar un camino.
Si es 1 desarrollador, el orden recomendado es:

```
Fase 1 (semanas 1-5):
  A1 (Offline) + C1 (Plugin SDK) + B3 (Diff/Merge)

Fase 2 (semanas 5-10):
  A3 (Hardware) + C5 (i18n) + B1 (Web UI)

Fase 3 (semanas 10-16):
  A2 (RAG) + C2 (Marketplace) + B4 (Dashboard)

Fase 4 (semanas 16-22):
  A4 (Ensemble) + C4 (Extension API) + B2 (Collaboration)

Fase 5 (semanas 22-30):
  A5 (Distillation) + C6 (Analytics) + B5 (Templates)

Fase 6 (semanas 30-39):
  A6 (P2P Mesh) + C3 (Cloud) + B6 (Voice)
```
