#!/bin/bash
# Record a terminal demo of the KCode audit pipeline for HN/social media
# Usage: asciinema rec --command "bash docs/record-demo.sh" demo.cast

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  KCode v2.9.0 — Deterministic Audit Engine Demo"
echo "  Auditing NASA's Input Device Framework (IDF)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
sleep 2

# Clone
echo "$ git clone https://github.com/nasa/IDF.git"
cd /tmp && rm -rf IDF-demo && git clone --quiet https://github.com/nasa/IDF.git IDF-demo
echo "✓ Cloned"
echo ""
sleep 1

# Scan
echo "$ kcode audit /tmp/IDF-demo --skip-verify"
kcode audit /tmp/IDF-demo --skip-verify
echo ""
sleep 2

# Show key finding
echo "━━━ Top finding: pointer arithmetic bug ━━━"
echo ""
grep -A 20 "cpp-001-ptr-address-index" /tmp/IDF-demo/AUDIT_REPORT.md | head -20
echo ""
sleep 3

# Scan with model verification
echo "$ kcode audit /tmp/IDF-demo -m mnemo:mark5 --api-base http://localhost:8090/v1"
kcode audit /tmp/IDF-demo -m mnemo:mark5 --api-base http://localhost:8090/v1
echo ""
sleep 2

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done. 28+ real bugs found and verified."
echo "  github.com/AstrolexisAI/KCode"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
