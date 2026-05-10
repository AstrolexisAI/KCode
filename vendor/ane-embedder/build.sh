#!/usr/bin/env bash
# KCode ANE Embedder helper — Mac-only build script.
#
# What it does:
#   1. swift build -c release --arch arm64 (compiles the helper)
#   2. mkdir -p ~/.kcode/ane/
#   3. cp .build/.../release/ANEEmbedder ~/.kcode/ane/ane-embedder
#   4. chmod +x
#
# Prereqs (macOS only):
#   - Xcode Command Line Tools (provides swift)
#   - The .mlmodelc model is converted separately by
#     scripts/convert-bge-m3.py and copied to
#     ~/.kcode/ane/BGE-M3.mlmodelc
#
# Run:
#   cd vendor/ane-embedder
#   ./build.sh

set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(uname)" != "Darwin" ]]; then
    echo "ANE helper is macOS-only. Skipping on $(uname)." >&2
    exit 0
fi

if ! command -v swift >/dev/null 2>&1; then
    echo "swift not found — install Xcode Command Line Tools first:" >&2
    echo "  xcode-select --install" >&2
    exit 1
fi

echo "[1/4] Building ANEEmbedder via swift build..."
swift build -c release --arch arm64

echo "[2/4] Installing to ~/.kcode/ane/ane-embedder..."
TARGET_DIR="$HOME/.kcode/ane"
mkdir -p "$TARGET_DIR"

BUILT="$(swift build -c release --arch arm64 --show-bin-path)/ANEEmbedder"
if [[ ! -x "$BUILT" ]]; then
    echo "Built binary not found at $BUILT" >&2
    exit 2
fi
cp "$BUILT" "$TARGET_DIR/ane-embedder"
chmod +x "$TARGET_DIR/ane-embedder"
# Re-sign in-place. macOS taskgated rejects the binary with
# SIGKILL "Code Signature Invalid" if the adhoc signature embedded at
# build time doesn't validate after cp (seen 2026-05-09 on Apple
# Silicon, macOS 26.4). Re-signing with `-s -` produces a fresh adhoc
# signature whose hashes match the file at its installed path.
codesign --remove-signature "$TARGET_DIR/ane-embedder" 2>/dev/null || true
codesign -s - "$TARGET_DIR/ane-embedder"

echo "[3/4] Installing tokenize-server.py sidecar..."
SIDECAR_SRC="$(pwd)/scripts/tokenize-server.py"
if [[ -f "$SIDECAR_SRC" ]]; then
    cp "$SIDECAR_SRC" "$TARGET_DIR/tokenize-server.py"
    chmod +x "$TARGET_DIR/tokenize-server.py"
    echo "  Sidecar installed at $TARGET_DIR/tokenize-server.py"
else
    echo "  WARNING: $SIDECAR_SRC not found — tokenizer will fall back to byte stub"
fi

echo "[4/4] Done."
echo "  Helper:    $TARGET_DIR/ane-embedder"
echo "  Sidecar:   $TARGET_DIR/tokenize-server.py"
echo "  Model:     $TARGET_DIR/BGE-M3.mlmodelc  (run scripts/convert-bge-m3.py to produce)"
echo "  Tokenizer: $TARGET_DIR/tokenizer/      (auto-saved by convert-bge-m3.py)"
echo
echo "Python venv (for tokenizer sidecar):"
echo "  Set ANE_PYTHON=/path/to/python3 if you don't use the default discovery,"
echo "  or create one with: python3.11 -m venv \$HOME/.kcode/ane/venv && \$HOME/.kcode/ane/venv/bin/pip install transformers"
echo
echo "Sanity check:"
"$TARGET_DIR/ane-embedder" 2>&1 | head -1 || true
