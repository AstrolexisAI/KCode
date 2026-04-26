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

  # Assets are published as kcode-<version>-<platform>.tar.gz + .sha256
  # sidecar. The version in the filename drops the leading `v` to match
  # what the publish workflow writes.
  VERSION_NO_V="${VERSION#v}"
  TARBALL_NAME="kcode-${VERSION_NO_V}-${PLATFORM}.tar.gz"
  CHECKSUM_NAME="${TARBALL_NAME}.sha256"

  # Find download URLs by exact filename match.
  TARBALL_URL=$(printf '%s' "$RELEASE_JSON" | sed -n "s|.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*/${TARBALL_NAME}\)\".*|\1|p" | head -1)
  if [ -z "$TARBALL_URL" ]; then
    error "No binary found for ${PLATFORM} in release ${VERSION}.\nExpected asset: ${TARBALL_NAME}\nAvailable at: https://github.com/${GITHUB_REPO}/releases/tag/${VERSION}"
  fi
  CHECKSUM_URL=$(printf '%s' "$RELEASE_JSON" | sed -n "s|.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*/${CHECKSUM_NAME}\)\".*|\1|p" | head -1)

  # Download tarball + checksum to a temp dir.
  TMPDIR="${TMPDIR:-/tmp}"
  TMP_DIR=$(mktemp -d "${TMPDIR}/kcode-install-XXXXXX")
  trap 'rm -rf "$TMP_DIR"' EXIT

  TARBALL_PATH="${TMP_DIR}/${TARBALL_NAME}"
  info "Downloading ${TARBALL_NAME}..."
  download "$TARBALL_URL" "$TARBALL_PATH"

  # Verify tarball checksum if the sidecar is published.
  if [ -n "$CHECKSUM_URL" ]; then
    CHECKSUM_PATH="${TMP_DIR}/${CHECKSUM_NAME}"
    download "$CHECKSUM_URL" "$CHECKSUM_PATH"
    # sha256sum sidecar format: "<hash>  <filename>"
    EXPECTED_HASH=$(awk '{print $1}' "$CHECKSUM_PATH" | head -1)
    if [ -n "$EXPECTED_HASH" ]; then
      verify_sha256 "$TARBALL_PATH" "$EXPECTED_HASH"
    else
      warn "Checksum file ${CHECKSUM_NAME} was empty. Skipping verification."
    fi
  else
    warn "No checksum sidecar in release. Skipping verification."
  fi

  # Extract. The tarball contains a single file named `kcode`.
  info "Extracting..."
  tar -xzf "$TARBALL_PATH" -C "$TMP_DIR"
  EXTRACTED_BIN="${TMP_DIR}/${BINARY_NAME}"
  if [ ! -f "$EXTRACTED_BIN" ]; then
    error "Archive did not contain a '${BINARY_NAME}' binary."
  fi
  chmod +x "$EXTRACTED_BIN"

  # Determine install directory
  INSTALL_DIR=$(determine_install_dir)
  INSTALL_PATH="${INSTALL_DIR}/${BINARY_NAME}"

  # Install (use sudo if needed for /usr/local/bin).
  # Use cp+rm instead of mv because mv across filesystems falls back to
  # copy but on some shells fails if the dest file is in use.
  if [ "$INSTALL_DIR" = "/usr/local/bin" ] && [ ! -w "$INSTALL_DIR" ]; then
    info "Installing to ${INSTALL_PATH} (requires sudo)..."
    sudo cp "$EXTRACTED_BIN" "$INSTALL_PATH"
    sudo chmod +x "$INSTALL_PATH"
  else
    info "Installing to ${INSTALL_PATH}..."
    # Remove first to avoid "Text file busy" when updating in place.
    rm -f "$INSTALL_PATH"
    cp "$EXTRACTED_BIN" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"
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
  printf "  ${BOLD}Setup guide:${RESET} kcode setup\n"
  # v2.10.372 — bsdiff hint. KCode's self-hosted updater ships
  # binary deltas (typical 0.5% of full size) when bsdiff is on
  # PATH; without it the user falls back to the full ~117 MB
  # download every release. Mention it once at install time so
  # the user doesn't pay 200x bandwidth on every update.
  if ! command -v bspatch >/dev/null 2>&1; then
    printf "\n  ${BOLD}Tip:${RESET} install ${BOLD}bsdiff${RESET} for 99%% smaller updates\n"
    printf "       (\`apt install bsdiff\` / \`brew install bsdiff\` / \`dnf install bsdiff\`)\n"
  fi
  printf "\n"
}

main "$@"
