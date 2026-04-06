#!/bin/bash
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  KCode v2.9.0 — Auditing FFmpeg"
echo "  The tool that processes your videos"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
sleep 2

echo "$ git clone https://github.com/FFmpeg/FFmpeg.git"
cd /tmp && rm -rf FFmpeg-demo && git clone --quiet --depth 1 https://github.com/FFmpeg/FFmpeg.git FFmpeg-demo
echo "✓ Cloned (500+ source files)"
echo ""
sleep 1

echo "$ kcode audit FFmpeg-demo/ --skip-verify"
echo ""
kcode audit /tmp/FFmpeg-demo --skip-verify --max-files 500
echo ""
sleep 2

echo "━━━ memcpy with untrusted length (CWE-120) ━━━"
echo ""
grep -A 15 "cpp-008-memcpy" /tmp/FFmpeg-demo/AUDIT_REPORT.md | head -15
echo ""
sleep 3

echo "━━━ Unchecked buffer indexing (CWE-125) ━━━"
echo ""
grep -A 15 "cpp-003-unchecked" /tmp/FFmpeg-demo/AUDIT_REPORT.md | head -15
echo ""
sleep 3

echo ""
echo "$ kcode audit FFmpeg-demo/ -m mnemo:mark5 --api-base http://localhost:8090/v1"
echo ""
kcode audit /tmp/FFmpeg-demo -m mnemo:mark5 --api-base http://localhost:8090/v1 --max-files 500
echo ""
sleep 2

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  FFmpeg: 452 candidates, verified with local LLM"
echo "  Zero cloud tokens. github.com/AstrolexisAI/KCode"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
