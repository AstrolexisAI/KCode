#!/usr/bin/env bash
# KCode installer - copies the built binary to a location on PATH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BINARY="$PROJECT_DIR/dist/kcode"

# Read version from package.json
VERSION=$(grep '"version"' "$PROJECT_DIR/package.json" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')

if [ ! -f "$BINARY" ]; then
  echo "Error: Binary not found at $BINARY"
  echo "Run 'bun run build' first to compile the standalone binary."
  exit 1
fi

# Determine install location
if [ "${1:-}" = "--system" ] || [ "${1:-}" = "-s" ]; then
  INSTALL_DIR="/usr/local/bin"
  echo "Installing to $INSTALL_DIR (requires sudo)..."
  sudo cp "$BINARY" "$INSTALL_DIR/kcode"
  sudo chmod +x "$INSTALL_DIR/kcode"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
  cp "$BINARY" "$INSTALL_DIR/kcode"
  chmod +x "$INSTALL_DIR/kcode"
fi

# Create config directory
mkdir -p "$HOME/.kcode"

echo ""
echo "KCode v${VERSION} installed successfully!"
echo "  Binary:  $INSTALL_DIR/kcode"
echo "  Config:  ~/.kcode/"
echo ""

# Check if install dir is on PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo "Warning: $INSTALL_DIR is not in your PATH."
  echo "Add it with:  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo ""
fi
