#!/usr/bin/env bash
# Run tests in batches to avoid OOM (244 test files × heavy module graph = 25GB+ RAM)
# Usage: ./scripts/test-batched.sh [batch_size]

set -euo pipefail

BATCH_SIZE=${1:-20}
FAILED=0
PASSED=0
ERRORS=()

# Collect all test files
mapfile -t FILES < <(find src -name "*.test.ts" | sort)
TOTAL=${#FILES[@]}

echo "Running $TOTAL test files in batches of $BATCH_SIZE"
echo "=================================================="

for ((i=0; i<TOTAL; i+=BATCH_SIZE)); do
  BATCH=("${FILES[@]:i:BATCH_SIZE}")
  BATCH_NUM=$(( (i / BATCH_SIZE) + 1 ))
  BATCH_TOTAL=$(( (TOTAL + BATCH_SIZE - 1) / BATCH_SIZE ))

  echo ""
  echo "--- Batch $BATCH_NUM/$BATCH_TOTAL (files $((i+1))-$((i+${#BATCH[@]}))/$TOTAL) ---"

  if timeout 120 bun test "${BATCH[@]}" 2>&1 | tail -5; then
    PASSED=$((PASSED + ${#BATCH[@]}))
  else
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
      echo "TIMEOUT in batch $BATCH_NUM"
    fi
    ERRORS+=("Batch $BATCH_NUM: ${BATCH[*]}")
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "=================================================="
echo "Batches passed: $((BATCH_TOTAL - FAILED))/$BATCH_TOTAL"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "Failed batches:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi
echo "All tests passed!"
