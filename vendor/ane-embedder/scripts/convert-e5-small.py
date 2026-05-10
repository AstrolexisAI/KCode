#!/usr/bin/env python3
"""
Convert intfloat/multilingual-e5-small to Core ML for ANE.

This is a smaller alternative to BGE-M3 (118M vs 568M params, 384 dim
vs 1024 dim). On Apple Neural Engine BGE-M3 caps at ~50% utilization
because the model is large enough that ANE processes it serially.
e5-small is small enough that ANE can saturate, and a multi-process
pool actually helps.

Tradeoffs vs BGE-M3:
- ~7-10% lower MTEB score on multilingual retrieval (62 vs 67)
- 384-dim vectors → rag.db ~37% the size of M3 indexes
- Throughput: 100+ emb/s expected (vs 18 emb/s for M3)

Output (parallel layout to BGE-M3 for easy A/B):
    ~/.kcode/ane/E5-small.mlmodelc
    ~/.kcode/ane/E5-small.tokenizer/

The Swift helper picks the model via the path argument it gets at
spawn time, so this can run alongside the BGE-M3 install without
clobbering it.
"""

import sys
from pathlib import Path

OUTPUT_DIR = Path.home() / ".kcode" / "ane"
# 2026-05-10: tried intfloat/multilingual-e5-small first — coremltools
# TypeError on a non-scalar int cast op in its trace. Falling back to
# paraphrase-multilingual-MiniLM-L12-v2, also XLM-R-based, also 118M
# params + 384 dim + multilingual, but with a tracing graph known to
# convert cleanly to Core ML.
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MAX_SEQ_LEN = 512
OUT_BASENAME = "MiniLM-L12-multilingual"


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[1/4] Loading {MODEL_NAME} from HuggingFace...")
    from transformers import AutoModel, AutoTokenizer
    import torch

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME).eval()

    print("[2/4] Tracing the model with a representative input (batch=1, fixed shape)...")
    example = tokenizer(
        "una oración de ejemplo en español",
        return_tensors="pt",
        padding="max_length",
        max_length=MAX_SEQ_LEN,
        truncation=True,
    )

    class WrappedEmbedder(torch.nn.Module):
        """Mean-pool last_hidden_state with attention mask + L2 normalize.
        Output is already a sentence embedding ready for cosine similarity."""

        def __init__(self, base):
            super().__init__()
            self.base = base

        def forward(self, input_ids, attention_mask):
            out = self.base(input_ids=input_ids, attention_mask=attention_mask)
            hidden = out.last_hidden_state
            mask = attention_mask.unsqueeze(-1).float()
            pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
            return torch.nn.functional.normalize(pooled, p=2, dim=1)

    wrapped = WrappedEmbedder(model).eval()
    traced = torch.jit.trace(
        wrapped,
        (example["input_ids"], example["attention_mask"]),
    )

    print("[3/4] Converting to Core ML (FP16, ANE-targeted, fixed batch=1)...")
    import coremltools as ct

    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(name="input_ids", shape=example["input_ids"].shape, dtype=int),
            ct.TensorType(name="attention_mask", shape=example["attention_mask"].shape, dtype=int),
        ],
        compute_precision=ct.precision.FLOAT16,
        compute_units=ct.ComputeUnit.CPU_AND_NE,
        minimum_deployment_target=ct.target.macOS13,
    )
    mlmodel.author = "intfloat / Kulvex"
    mlmodel.short_description = "multilingual-e5-small (ANE, 384-dim)"

    mlpkg_path = OUTPUT_DIR / f"{OUT_BASENAME}.mlpackage"
    mlmodel.save(str(mlpkg_path))
    print(f"  Wrote {mlpkg_path}")

    print("[4/4] Compiling to .mlmodelc (Core ML runtime format)...")
    import subprocess

    compiled = subprocess.run(
        ["xcrun", "coremlc", "compile", str(mlpkg_path), str(OUTPUT_DIR)],
        capture_output=True, text=True,
    )
    if compiled.returncode != 0:
        print(f"coremlc failed:\n{compiled.stderr}", file=sys.stderr)
        return 1

    target = OUTPUT_DIR / f"{OUT_BASENAME}.mlmodelc"
    print(f"  Wrote {target}")

    # Save tokenizer alongside (used by the Python sidecar).
    tokenizer.save_pretrained(str(OUTPUT_DIR / f"{OUT_BASENAME}.tokenizer"))
    print(f"  Tokenizer written under {OUTPUT_DIR / (OUT_BASENAME + '.tokenizer')}")

    print()
    print("Done. Test with:")
    print(f"  ~/.kcode/ane/ane-embedder {target}")
    print(f"  # Or for the pool: ANE_POOL_SIZE=4 with {target} as the model")
    return 0


if __name__ == "__main__":
    sys.exit(main())
