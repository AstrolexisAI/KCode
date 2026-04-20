#!/bin/sh
# KCode Install Script
# Usage: curl -fsSL https://kulvex.ai/install.sh | sh
#
# Detects OS/arch, downloads the correct binary from GitHub releases,
# verifies SHA256 checksum, and installs to PATH.

set -e

# ─── Constants ──────────────────────────────────────────────────

GITHUB_REPO="AstrolexisAI/KCode"
BINARY_NAME="kcode"

# ─── Colors (only when terminal supports it) ────────────────────

if [ -t 1 ] && [ -n "${TERM:-}" ] && [ "${TERM}" != "dumb" ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BOLD=''
  RESET=''
fi

# ─── Helpers ────────────────────────────────────────────────────

info() {
  printf "${GREEN}==>${RESET} %s\n" "$1"
}

warn() {
  printf "${YELLOW}warning:${RESET} %s\n" "$1"
}

error() {
  printf "${RED}error:${RESET} %s\n" "$1" >&2
  exit 1
}

# ─── Platform Detection ────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    *)       error "Unsupported operating system: $(uname -s). KCode supports Linux and macOS." ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)             error "Unsupported architecture: $(uname -m). KCode supports x64 and arm64." ;;
  esac
}

# ─── Checksum Verification ─────────────────────────────────────

verify_sha256() {
  file="$1"
  expected="$2"

  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | cut -d ' ' -f 1)
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
  else
    warn "Neither sha256sum nor shasum found. Skipping checksum verification."
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    error "Checksum verification failed.\n  Expected: ${expected}\n  Got:      ${actual}\n\nThe download may be corrupted. Please try again."
  fi

  info "Checksum verified."
}

# ─── Download Helper ───────────────────────────────────────────

download() {
  url="$1"
  dest="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --progress-bar -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$dest" "$url"
  else
    error "Neither curl nor wget found. Please install one and try again."
  fi
}

# ─── Install Location ─────────────────────────────────────────

determine_install_dir() {
  # Prefer /usr/local/bin if we have write access (or can sudo)
  if [ -w "/usr/local/bin" ]; then
    echo "/usr/local/bin"
    return
  fi

  # Fall back to ~/.local/bin
  local_bin="${HOME}/.local/bin"
  mkdir -p "$local_bin"
  echo "$local_bin"
}

ensure_in_path() {
  dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
  esac

  warn "${dir} is not in your PATH."
  printf "\n  Add it by appending this to your shell profile:\n\n"
  printf "    ${BOLD}export PATH=\"%s:\$PATH\"${RESET}\n\n" "$dir"

  # Try to detect shell and suggest the right file
  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh)  profile_file="~/.zshrc" ;;
    bash) profile_file="~/.bashrc" ;;
    fish) profile_file="~/.config/fish/config.fish" ;;
    *)    profile_file="your shell profile" ;;
  esac
  printf "  Suggested file: ${BOLD}%s${RESET}\n\n" "$profile_file"
}

# ─── Main ──────────────────────────────────────────────────────

main() {
  printf "\n  ${BOLD}KCode Installer${RESET}\n\n"

  OS=$(detect_os)
  ARCH=$(detect_arch)
  PLATFORM="${OS}-${ARCH}"

  info "Detected platform: ${PLATFORM}"

  # Fetch latest release info from GitHub
  info "Fetching latest release..."

  RELEASE_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"

  if command -v curl >/dev/null 2>&1; then
    RELEASE_JSON=$(curl -fsSL -H "User-Agent: KCode-Installer" "$RELEASE_URL")
  elif command -v wget >/dev/null 2>&1; then
    RELEASE_JSON=$(wget -qO- --header="User-Agent: KCode-Installer" "$RELEASE_URL")
  else
    error "Neither curl nor wget found. Please install one and try again."
  fi

  # Parse version (POSIX-compatible, no jq dependency)
  VERSION=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$VERSION" ]; then
    error "Failed to determine latest version. Check your network connection."
  fi

  info "Latest version: ${VERSION}"

  # Determine binary asset name
  ASSET_NAME="kcode-${PLATFORM}"

  # Find download URL for the binary
  DOWNLOAD_URL=$(printf '%s' "$RELEASE_JSON" | sed -n "s|.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*${ASSET_NAME}[^\"]*\)\".*|\1|p" | head -1)
  if [ -z "$DOWNLOAD_URL" ]; then
    error "No binary found for ${PLATFORM} in release ${VERSION}.\nAvailable at: https://github.com/${GITHUB_REPO}/releases"
  fi

  # Look for checksum file
  CHECKSUM_URL=$(printf '%s' "$RELEASE_JSON" | sed -n 's|.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*checksums\.txt[^"]*\)".*|\1|p' | head -1)

  # Download binary
  TMPDIR="${TMPDIR:-/tmp}"
  TMP_FILE="${TMPDIR}/kcode-install-$$"
  trap 'rm -f "$TMP_FILE" "${TMP_FILE}.checksums"' EXIT

  info "Downloading ${ASSET_NAME}..."
  download "$DOWNLOAD_URL" "$TMP_FILE"

  # Verify checksum if checksums file is available
  if [ -n "$CHECKSUM_URL" ]; then
    info "Downloading checksums..."
    download "$CHECKSUM_URL" "${TMP_FILE}.checksums"
    EXPECTED_HASH=$(grep "$ASSET_NAME" "${TMP_FILE}.checksums" | cut -d ' ' -f 1 | head -1)
    if [ -n "$EXPECTED_HASH" ]; then
      verify_sha256 "$TMP_FILE" "$EXPECTED_HASH"
    else
      warn "No checksum found for ${ASSET_NAME} in checksums file. Skipping verification."
    fi
  else
    warn "No checksums file in release. Skipping checksum verification."
  fi

  # Make executable
  chmod +x "$TMP_FILE"

  # Determine install directory
  INSTALL_DIR=$(determine_install_dir)
  INSTALL_PATH="${INSTALL_DIR}/${BINARY_NAME}"

  # Install (use sudo if needed for /usr/local/bin)
  if [ "$INSTALL_DIR" = "/usr/local/bin" ] && [ ! -w "$INSTALL_DIR" ]; then
    info "Installing to ${INSTALL_PATH} (requires sudo)..."
    sudo mv "$TMP_FILE" "$INSTALL_PATH"
    sudo chmod +x "$INSTALL_PATH"
  else
    info "Installing to ${INSTALL_PATH}..."
    mv "$TMP_FILE" "$INSTALL_PATH"
  fi

  # Ensure PATH includes install dir
  ensure_in_path "$INSTALL_DIR"

  # Verify installation
  printf "\n"
  if command -v kcode >/dev/null 2>&1; then
    info "KCode ${VERSION} installed successfully."
    printf "\n"
    info "Running verification (kcode doctor)..."
    printf "\n"
    kcode doctor || warn "kcode doctor reported issues. Run 'kcode doctor' for details."
  else
    info "KCode ${VERSION} installed to ${INSTALL_PATH}."
    warn "kcode is not yet in your PATH. Add ${INSTALL_DIR} to PATH, then run 'kcode doctor' to verify."
  fi

  printf "\n  ${BOLD}Get started:${RESET} kcode\n"
  printf "  ${BOLD}Setup guide:${RESET} kcode setup\n\n"
}

main "$@"
