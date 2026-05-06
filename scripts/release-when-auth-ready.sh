#!/usr/bin/env bash
# KCode — release script for the post-auth path.
#
# Run AFTER `gh auth login -h github.com -w` completes. The script:
#   1. Confirms gh auth + git push both work
#   2. Pushes any unpushed commits on master
#   3. Tags v$(package.json version) and pushes the tag
#      → triggers .github/workflows/build.yml on GitHub
#      → which produces signed binaries via .github/workflows/publish.yml
#   4. Waits for the GH Actions run to finish (polls every 30 s, max 30 min)
#   5. Runs ~/kulvex-models/sync-kcode-releases.sh to mirror artefacts to
#      the kulvex.ai CDN and bump the website's KCODE_VERSION constant
#
# Idempotent: safe to re-run if the tag already exists or the build is
# in progress. Aborts loudly on any failure rather than continuing past
# a problem.

set -euo pipefail

cd "$(dirname "$0")/.."  # repo root
REPO_ROOT="$(pwd)"

log() { printf "\033[1m[%s]\033[0m %s\n" "$(date +%H:%M:%S)" "$*"; }
fail() { printf "\033[31m[%s] FAIL\033[0m %s\n" "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

# ─── 1. Pre-flight ──────────────────────────────────────────────

log "checking gh auth…"
if ! gh auth status >/dev/null 2>&1; then
  fail "gh is not authenticated. Run: gh auth login -h github.com -w"
fi

log "checking git push credentials…"
if ! git ls-remote origin HEAD >/dev/null 2>&1; then
  fail "git cannot reach origin. Configure a credential helper or SSH key first."
fi

# ─── 2. Push commits on master ──────────────────────────────────

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "master" ]; then
  fail "expected to be on master, got '$CURRENT_BRANCH'. Switch with: git checkout master"
fi

UNPUSHED="$(git log --oneline origin/master..master 2>/dev/null | wc -l | tr -d ' ')" || UNPUSHED="?"
log "unpushed commits on master: $UNPUSHED"

if [ "$UNPUSHED" != "0" ]; then
  log "pushing master to origin…"
  git push origin master
else
  log "no unpushed commits — skipping push"
fi

# ─── 3. Tag + push tag ──────────────────────────────────────────

VERSION="$(node -e "console.log(require('./package.json').version)" 2>/dev/null \
           || bun -e "console.log(JSON.parse(require('fs').readFileSync('./package.json','utf-8')).version)")"
TAG="v${VERSION}"
log "package.json version: $VERSION → tag $TAG"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  log "local tag $TAG already exists — skipping local tag creation"
else
  git tag -a "$TAG" -m "$TAG"
  log "created local tag $TAG"
fi

# Has the tag been pushed?
if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  log "remote tag $TAG already exists — skipping push"
else
  log "pushing tag $TAG…"
  git push origin "$TAG"
fi

# ─── 4. Wait for the workflow run ───────────────────────────────

log "looking up the workflow run for $TAG…"
RUN_ID=""
for attempt in 1 2 3 4 5; do
  RUN_ID="$(gh run list --workflow=build.yml --limit=20 --json databaseId,headBranch,event \
            --jq ".[] | select(.headBranch==\"$TAG\" and .event==\"push\") | .databaseId" \
            | head -1 || true)"
  [ -n "$RUN_ID" ] && break
  log "  no run yet, retrying in 5s ($attempt/5)…"
  sleep 5
done

if [ -z "$RUN_ID" ]; then
  fail "could not find a workflow run for tag $TAG. Check https://github.com/AstrolexisAI/KCode/actions"
fi

log "watching workflow run $RUN_ID (this is the long part — ~10-15 min)…"
gh run watch "$RUN_ID" --exit-status

# ─── 5. Mirror to kulvex.ai CDN ─────────────────────────────────

SYNC_SCRIPT="$HOME/kulvex-models/sync-kcode-releases.sh"
if [ ! -x "$SYNC_SCRIPT" ]; then
  log "WARN: $SYNC_SCRIPT not found or not executable — skipping CDN sync"
  log "      Once it's available, run manually: $SYNC_SCRIPT"
else
  log "syncing $TAG to kulvex.ai CDN…"
  "$SYNC_SCRIPT" "$TAG"
fi

# ─── Done ───────────────────────────────────────────────────────

log "release $TAG complete."
log "  binaries:    https://github.com/AstrolexisAI/KCode/releases/tag/$TAG"
log "  signatures:  cosign verify-blob (see docs/security/verify-binary.md)"
log "  CDN:         https://kulvex.ai/downloads/kcode/"
