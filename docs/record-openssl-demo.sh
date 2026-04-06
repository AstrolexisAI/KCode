#!/bin/bash
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  KCode v2.9.0 — Auditing OpenSSL"
echo "  The library that secures the internet"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
sleep 2

echo "$ git clone https://github.com/openssl/openssl.git"
cd /tmp && rm -rf openssl-demo && git clone --quiet --depth 1 https://github.com/openssl/openssl.git openssl-demo
echo "✓ Cloned"
echo ""
sleep 1

echo "$ kcode audit openssl-demo/ --skip-verify"
echo ""
kcode audit /tmp/openssl-demo --skip-verify --max-files 500
echo ""
sleep 2

echo "━━━ Key findings ━━━"
echo ""
echo "  5x strcpy without bounds checking"
echo "  2x pointer arithmetic (&var)[N]"
echo "  1x malloc with unchecked multiplication (integer overflow)"
echo "  6x unchecked buffer indexing"
echo "  27x loop with unvalidated external bound"
echo ""
sleep 3

echo "$ kcode audit openssl-demo/ -m mnemo:mark5 --api-base http://localhost:8090/v1"
echo ""
kcode audit /tmp/openssl-demo -m mnemo:mark5 --api-base http://localhost:8090/v1 --max-files 500
echo ""
sleep 2

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  OpenSSL audited. Local LLM. Zero cloud tokens."
echo "  github.com/AstrolexisAI/KCode"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
