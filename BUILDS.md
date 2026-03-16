# KCode — Builds & Releases

Guia completa para compilar, empaquetar y distribuir KCode en todas las plataformas.

---

## Historial de versiones

| Version | Fecha       | Notas                                                        |
|---------|-------------|--------------------------------------------------------------|
| 0.1.0   | 2026-02-xx  | Release inicial — CLI basico, herramientas, conversacion     |
| 0.2.0   | 2026-02-xx  | DB lifecycle, safety guards, tests                           |
| 0.3.0   | 2026-03-xx  | Plugin system, LSP, VS Code extension, temas, build system   |
| 0.4.0   | (pendiente) | Auto-setup, hardware detection, model manager, wizard        |

### Esquema de versionamiento

Seguimos **Semantic Versioning** (SemVer):

```
MAJOR.MINOR.PATCH
  |      |      |
  |      |      └─ Bugfixes, parches de seguridad (0.3.1)
  |      └────── Nuevas features sin romper compatibilidad (0.4.0)
  └──────────── Cambios incompatibles, breaking changes (1.0.0)
```

Scripts en package.json:

```bash
bun run version:patch    # 0.3.0 → 0.3.1
bun run version:minor    # 0.3.0 → 0.4.0
bun run version:major    # 0.3.0 → 1.0.0
```

> La version se lee de `package.json` en tiempo de build. No hay que tocarla manualmente.

---

## Prerequisitos

- **Bun >= 1.1** — runtime y compilador
- **Git** — para tags de release
- **Node.js** — solo para la extension VS Code (vsce)

```bash
# Verificar
bun --version
git --version
```

---

## Build local (desarrollo)

Compila un binario standalone para tu plataforma actual:

```bash
# Build de produccion (minificado)
bun run build

# Build de desarrollo (sin minificar, mas rapido)
bun run build:dev
```

Resultado: `dist/kcode` (~101 MB — 99 MB es el runtime de Bun embebido)

### Alternativa sin compilar

Para desarrollo diario, no necesitas compilar:

```bash
bun run src/index.ts         # Ejecucion directa
bun --watch run src/index.ts  # Hot-reload
```

---

## Build cross-platform (release)

El script `scripts/release.ts` genera binarios para todas las plataformas desde Linux:

```bash
# Todas las plataformas (5 binarios)
bun run scripts/release.ts

# Solo una plataforma
bun run scripts/release.ts --linux
bun run scripts/release.ts --macos
bun run scripts/release.ts --windows
```

### Targets generados

| Target                     | Archivo                              | Notas                          |
|----------------------------|--------------------------------------|--------------------------------|
| Linux x64                  | `kcode-X.Y.Z-linux-x64`             | Servidores, workstations       |
| Linux ARM64                | `kcode-X.Y.Z-linux-arm64`           | Raspberry Pi, ARM servers      |
| macOS x64 (Intel)          | `kcode-X.Y.Z-macos-x64`             | Macs Intel (pre-2020)          |
| macOS ARM64 (Apple Silicon)| `kcode-X.Y.Z-macos-arm64`           | M1/M2/M3/M4                   |
| Windows x64                | `kcode-X.Y.Z-windows-x64.exe`       | Incluye metadatos Windows      |

Resultado: carpeta `release/` con todos los binarios.

### Metadatos Windows

El build de Windows incluye:
- Publisher: Astrolexis
- Description: KCode - Kulvex Code by Astrolexis
- Copyright: Copyright 2026 Astrolexis. All rights reserved.
- Console oculta (`--windows-hide-console`)

---

## Instalacion local

```bash
# Instalar en ~/.local/bin (usuario)
./scripts/install.sh

# Instalar en /usr/local/bin (sistema, requiere sudo)
./scripts/install.sh --system
```

El script:
1. Copia `dist/kcode` al destino
2. Crea `~/.kcode/` si no existe
3. Avisa si el directorio no esta en PATH

---

## Proceso de release completo

### 1. Preparar la version

```bash
# Actualizar version
bun run version:minor  # o version:patch

# Verificar
grep '"version"' package.json
```

### 2. Tests

```bash
bun test
```

### 3. Compilar todos los targets

```bash
bun run scripts/release.ts
```

### 4. Verificar los binarios

```bash
ls -lh release/

# Test rapido del binario local
./release/kcode-*-linux-x64 --version
./release/kcode-*-linux-x64 doctor
```

### 5. Git tag y push

```bash
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')

git add -A
git commit -m "Release v${VERSION}"
git tag -a "v${VERSION}" -m "KCode v${VERSION}"
git push origin main --tags
```

### 6. Crear GitHub Release (opcional)

```bash
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')

gh release create "v${VERSION}" release/kcode-* \
  --title "KCode v${VERSION}" \
  --notes "Release notes aqui"
```

---

## Distribucion de modelos

Los modelos mnemo:mark5 se sirven desde el CDN propio:

- **URL**: `https://kulvex.ai/models/mnemo/`
- **Servidor**: `~/kulvex-models/serve.ts` (Bun, puerto 9400)
- **Systemd**: `kulvex-models.service` (user service, auto-restart)
- **Routing**: Cloudflare Tunnel → `kulvex.ai/models/mnemo` → localhost:9400

### Agregar un modelo nuevo al CDN

```bash
# 1. Descargar el modelo (GGUF) y renombrarlo con codename
mv original-model-name.gguf ~/kulvex-models/mnemo/mark5-XXb.gguf

# 2. Verificar que se sirve
curl -I https://kulvex.ai/models/mnemo/mark5-XXb.gguf

# 3. Agregar al catalogo en src/core/model-manager.ts (MODEL_CATALOG array)
```

### Archivos del CDN

```
~/kulvex-models/
  serve.ts           # Servidor Bun (puerto 9400)
  mnemo/             # Modelos GGUF con codenames
    mark5-0.5b.gguf
    mark5-1.5b.gguf
    mark5-3b.gguf
    mark5-7b.gguf
    mark5-14b.gguf
    mark5-32b.gguf
    mark5-80b.gguf   # (split en 2 partes)
```

---

## Auto-setup del usuario final

Cuando un usuario instala KCode y lo ejecuta por primera vez:

1. **Wizard de instalacion** — banner, pasos animados con spinners
2. **Deteccion de hardware** — GPUs (nvidia-smi / system_profiler), VRAM, RAM, plataforma
3. **Seleccion de modelo** — el mas grande que cabe en la VRAM disponible
4. **Descarga del engine** — llama.cpp desde GitHub Releases (auto-detecta plataforma y CUDA)
5. **Descarga del modelo** — GGUF desde kulvex.ai/models/mnemo/
6. **Configuracion** — registra modelo, guarda server.json, marca setup completo
7. **Servidor auto-start** — llama-server se inicia automaticamente en cada sesion

### Soporte por plataforma

| Componente          | Linux              | macOS              | Windows                |
|---------------------|--------------------|--------------------|------------------------|
| GPU detection       | nvidia-smi         | system_profiler    | nvidia-smi.exe         |
| Engine archive      | .tar.gz            | .tar.gz            | .zip (PowerShell)      |
| Library path        | LD_LIBRARY_PATH    | DYLD_LIBRARY_PATH  | PATH (DLLs)            |
| Libraries           | .so                | .dylib             | .dll                   |
| Process kill        | SIGTERM → SIGKILL  | SIGTERM → SIGKILL  | taskkill /F             |
| Server detach       | detached + unref   | detached + unref   | foreground              |
| File search         | Bun.Glob           | Bun.Glob           | Bun.Glob               |

---

## Estructura de archivos del build system

```
KCode/
  package.json          # Version, scripts (build, version:*)
  build.ts              # Build local (bun build --compile)
  scripts/
    release.ts          # Build cross-platform (5 targets)
    install.sh          # Instalador Unix (cp al PATH)
  dist/
    kcode               # Binario local compilado
  release/
    kcode-X.Y.Z-*       # Binarios de release (todos los targets)
  src/core/
    model-manager.ts    # Catalogo de modelos, auto-setup wizard
    hardware.ts         # Deteccion de hardware
    llama-server.ts     # Gestion del servidor de inferencia
```

---

## Pendiente / Roadmap de builds

- [ ] **Instalador Windows (.msi o .exe)** — usar Inno Setup o WiX
- [ ] **Instalador macOS (.pkg o .dmg)** — pkgbuild o create-dmg
- [ ] **Homebrew formula** — `brew install kcode`
- [ ] **AUR package** — para Arch Linux
- [ ] **Auto-update** — check de nueva version al iniciar, descarga en background
- [ ] **CI/CD** — GitHub Actions para builds automaticos en push a tags
- [ ] **Firma de codigo** — codesign en macOS, Authenticode en Windows
- [ ] **VS Code extension** — publicar en VS Code Marketplace (vsce publish)
- [ ] **Changelog automatico** — generar CHANGELOG.md desde git log/conventional commits
- [ ] **Notarizacion macOS** — `xcrun notarytool` para evitar advertencias de Gatekeeper
