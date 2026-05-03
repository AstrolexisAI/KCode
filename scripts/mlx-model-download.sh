#!/usr/bin/env bash
# Download an MLX model directly from HuggingFace using hf_transfer
# (Rust-based, parallel, resumable). Bypasses the in-process Python
# download path that stalls on slow/jittery links.
#
# After this script finishes, the model lives in ~/.cache/huggingface/hub/
# and KCode picks it up automatically — no extra "mount" step needed,
# `mlx_lm.load(repo)` finds cached files and skips re-download.
#
# Usage:
#   bash mlx-model-download.sh                 # default: Qwen3-Coder-30B 8bit
#   bash mlx-model-download.sh <hf-repo>       # any MLX repo (owner/name)
#
# One-liner from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/AstrolexisAI/KCode/master/scripts/mlx-model-download.sh | bash

set -u
REPO="${1:-mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit}"
VENV="$HOME/.kcode/mlx-venv"

BLD=$'\e[1m'; GRN=$'\e[32m'; RED=$'\e[31m'; YLW=$'\e[33m'; RST=$'\e[0m'
step() { printf "${BLD}==>${RST} %s\n" "$*"; }
ok()   { printf "  ${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "  ${YLW}⚠${RST} %s\n" "$*"; }
die()  { printf "  ${RED}✗${RST} %s\n" "$*" >&2; exit 1; }

step "Repo:  ${BLD}${REPO}${RST}"
step "Venv:  ${VENV}"

# 1. Sanity check: the MLX venv must exist (kcode setup creates it).
if [ ! -x "$VENV/bin/python3" ]; then
  warn "MLX venv not found at $VENV"
  printf "    Run ${BLD}kcode setup --yes${RST} first to create it.\n"
  printf "    The setup will probably stall at \"Downloading…\" — interrupt with Ctrl+C\n"
  printf "    once the venv is built, then re-run this script.\n"
  exit 1
fi

# 2. Kill any stuck downloads from previous attempts (silent if none).
pkill -f mlx_lm 2>/dev/null || true
pkill -f huggingface_hub 2>/dev/null || true

# 3. Install the official HF CLI + the Rust transfer accelerator.
step "Installing huggingface-cli + hf_transfer in the kcode venv…"
if ! "$VENV/bin/pip" install -q -U "huggingface_hub[cli]" hf_transfer; then
  die "pip install failed — check network / Python version"
fi
ok "Installed"

# 4. Pull the model. hf_transfer writes a real progress bar to stderr and
#    resumes from partial files on retry.
step "Downloading ${REPO} (parallel, resumable)…"
echo
if HF_HUB_ENABLE_HF_TRANSFER=1 "$VENV/bin/huggingface-cli" download "$REPO"; then
  echo
  ok "Model cached at ~/.cache/huggingface/hub/"
else
  echo
  die "Download failed — re-run the script to resume from where it stopped"
fi

# 5. Tell the user what to do next.
printf "\n${GRN}${BLD}Done.${RST} The model is on disk and KCode will use it automatically.\n\n"
printf "Next steps:\n"
printf "  1. Re-run setup so KCode marks the model as installed:\n"
printf "       ${BLD}kcode setup --yes${RST}\n"
printf "     (mlx_lm.load will find the cached files and skip re-downloading)\n\n"
printf "  2. Start KCode:\n"
printf "       ${BLD}kcode${RST}\n\n"
