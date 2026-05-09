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

echo "[1/3] Building ANEEmbedder via swift build..."
swift build -c release --arch arm64

echo "[2/3] Installing to ~/.kcode/ane/ane-embedder..."
TARGET_DIR="$HOME/.kcode/ane"
mkdir -p "$TARGET_DIR"

BUILT="$(swift build -c release --arch arm64 --show-bin-path)/ANEEmbedder"
if [[ ! -x "$BUILT" ]]; then
    echo "Built binary not found at $BUILT" >&2
    exit 2
fi
cp "$BUILT" "$TARGET_DIR/ane-embedder"
chmod +x "$TARGET_DIR/ane-embedder"

echo "[3/3] Done."
echo "  Helper:  $TARGET_DIR/ane-embedder"
echo "  Model:   $TARGET_DIR/BGE-M3.mlmodelc  (run scripts/convert-bge-m3.py to produce)"
echo
echo "Sanity check:"
"$TARGET_DIR/ane-embedder" 2>&1 | head -1 || true
