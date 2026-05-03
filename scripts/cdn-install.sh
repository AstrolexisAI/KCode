#!/usr/bin/env bash
# KCode public installer — fetches the right binary from the kulvex.ai
# CDN and (on Apple Silicon) bootstraps MLX in one shot.
#
# Usage:
#   curl -fsSL https://kulvex.ai/downloads/kcode/install.sh | bash
#
# Env overrides:
#   KCODE_VERSION=2.10.407   pin a specific version (default: latest)
#   KCODE_INSTALL_DIR=...    where to put the binary (default: ~/.local/bin)
#   KCODE_NO_MLX=1           skip MLX bootstrap on macOS arm64
#   KCODE_MODEL=...          override MLX model codename (default: auto)

set -u
CDN="https://kulvex.ai/downloads/kcode"
INSTALL_DIR="${KCODE_INSTALL_DIR:-$HOME/.local/bin}"
RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; DIM=$'\e[2m'; BLD=$'\e[1m'; RST=$'\e[0m'

step() { printf "${BLD}==>${RST} %s\n" "$*"; }
ok()   { printf "  ${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "  ${YLW}⚠${RST} %s\n" "$*"; }
die()  { printf "  ${RED}✗${RST} %s\n" "$*" >&2; exit 1; }

# ── Detect platform ──────────────────────────────────────────────────────
detect_target() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$os-$arch" in
    darwin-arm64)  echo "macos-arm64" ;;
    darwin-x86_64) echo "macos-x64" ;;
    linux-aarch64|linux-arm64) echo "linux-arm64" ;;
    linux-x86_64)  echo "linux-x64" ;;
    *) die "Unsupported platform: $os-$arch" ;;
  esac
}

TARGET=$(detect_target)
step "Platform detected: ${BLD}${TARGET}${RST}"

# ── Resolve version ──────────────────────────────────────────────────────
if [ -n "${KCODE_VERSION:-}" ]; then
  VERSION="$KCODE_VERSION"
  step "Pinned version: v${VERSION}"
else
  step "Resolving latest version from CDN…"
  LATEST_JSON=$(curl -fsSL "${CDN}/latest.json" 2>/dev/null) || die "Cannot reach ${CDN}/latest.json"
  VERSION=$(printf "%s" "$LATEST_JSON" | grep -oE '"latest"[[:space:]]*:[[:space:]]*"[0-9.]+"' | head -1 | grep -oE '[0-9.]+')
  [ -n "$VERSION" ] || die "Could not parse latest version from latest.json"
  ok "Latest stable: v${VERSION}"
fi

# ── Download binary ──────────────────────────────────────────────────────
BINARY_NAME="kcode-${VERSION}-${TARGET}"
[ "$TARGET" = "windows-x64" ] && BINARY_NAME="${BINARY_NAME}.exe"
URL="${CDN}/${BINARY_NAME}"

step "Downloading ${BINARY_NAME}…"
mkdir -p "$INSTALL_DIR" || die "Cannot create $INSTALL_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fL --progress-bar -o "$TMP" "$URL" || die "Download failed: $URL"
mv "$TMP" "$INSTALL_DIR/kcode"
chmod +x "$INSTALL_DIR/kcode"
ok "Installed: $INSTALL_DIR/kcode"

# ── macOS quarantine ─────────────────────────────────────────────────────
if [ "$(uname -s)" = "Darwin" ]; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR/kcode" 2>/dev/null || true
fi

# ── PATH check ───────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ok "$INSTALL_DIR already in PATH" ;;
  *)
    warn "$INSTALL_DIR not in PATH — adding to your shell rc"
    SHELL_RC=""
    case "${SHELL:-}" in
      */zsh)  SHELL_RC="$HOME/.zshrc" ;;
      */bash) SHELL_RC="$HOME/.bashrc" ;;
    esac
    if [ -n "$SHELL_RC" ]; then
      printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$SHELL_RC"
      ok "Appended to $SHELL_RC — restart your shell or: export PATH=\"$INSTALL_DIR:\$PATH\""
    fi
    ;;
esac

# ── Verify binary runs ───────────────────────────────────────────────────
INSTALLED_VER=$("$INSTALL_DIR/kcode" --version 2>/dev/null | head -1 | tr -d '[:space:]')
[ -n "$INSTALLED_VER" ] || die "Binary installed but '$INSTALL_DIR/kcode --version' produced no output"
ok "kcode --version → $INSTALLED_VER"

# ── MLX bootstrap (Apple Silicon only) ───────────────────────────────────
if [ "$TARGET" = "macos-arm64" ] && [ -z "${KCODE_NO_MLX:-}" ]; then
  step "Bootstrapping MLX (Apple Silicon)…"

  if [ -f "$HOME/.kcode/.mlx-engine" ]; then
    ok "MLX engine already installed — skipping"
  else
    if ! command -v python3 >/dev/null 2>&1; then
      warn "python3 not found"
      printf "       Run: ${BLD}xcode-select --install${RST} (or ${BLD}brew install python@3.12${RST}), then re-run this installer.\n"
      exit 0
    fi
    PY_VER=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)
    ok "python3 found: $PY_VER"

    step "Running 'kcode setup --yes' (installs mlx-lm + downloads model — may take 10-30 min)…"
    SETUP_ARGS=("setup" "--yes")
    [ -n "${KCODE_MODEL:-}" ] && SETUP_ARGS+=("--model" "$KCODE_MODEL")
    if "$INSTALL_DIR/kcode" "${SETUP_ARGS[@]}"; then
      ok "MLX setup complete"
    else
      warn "MLX setup exited non-zero — re-run manually: kcode setup --yes"
    fi
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────
printf "\n${GRN}${BLD}KCode v%s installed.${RST}\n" "$INSTALLED_VER"
printf "  Run ${BLD}kcode${RST} to start.\n"
printf "  Docs: https://kulvex.ai/kcode\n\n"
