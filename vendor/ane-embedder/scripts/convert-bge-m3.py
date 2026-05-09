#!/usr/bin/env python3
"""
Convert BAAI/bge-m3 (multilingual embedding model) to a Core ML
.mlpackage that runs on Apple Neural Engine.

Run on the Mac (Linux can't use coremltools for ANE-targeted models).

Prereqs:
    pip install transformers torch coremltools sentencepiece

Output:
    ~/.kcode/ane/BGE-M3.mlmodelc
    ~/.kcode/ane/tokenizer.json     (for the Swift helper to use)

Notes:
    - BGE-M3 is xlm-roberta-large based, 568M params.
    - Quantized to FP16 for ANE compatibility (INT8 needs more work).
    - Sequence length is fixed at 512 tokens; longer inputs truncate.
"""

import os
import sys
from pathlib import Path

OUTPUT_DIR = Path.home() / ".kcode" / "ane"
MODEL_NAME = "BAAI/bge-m3"
MAX_SEQ_LEN = 512


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[1/4] Loading {MODEL_NAME} from HuggingFace...")
    from transformers import AutoModel, AutoTokenizer
    import torch

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME).eval()

    print("[2/4] Tracing the model with a representative input...")
    example = tokenizer(
        "una oración de ejemplo en español",
        return_tensors="pt",
        padding="max_length",
        max_length=MAX_SEQ_LEN,
        truncation=True,
    )
    # Some HF models expect (input_ids, attention_mask). For the Core ML
    # export we produce a wrapped module that does mean-pooling +
    # L2 normalize so the helper output is a sentence embedding directly.

    class WrappedEmbedder(torch.nn.Module):
        def __init__(self, base):
            super().__init__()
            self.base = base

        def forward(self, input_ids, attention_mask):
            out = self.base(input_ids=input_ids, attention_mask=attention_mask)
            # mean-pool last_hidden_state over seq_len (mask-aware)
            hidden = out.last_hidden_state
            mask = attention_mask.unsqueeze(-1).float()
            pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
            # L2 normalize
            return torch.nn.functional.normalize(pooled, p=2, dim=1)

    wrapped = WrappedEmbedder(model).eval()
    traced = torch.jit.trace(
        wrapped,
        (example["input_ids"], example["attention_mask"]),
    )

    print("[3/4] Converting to Core ML (FP16, ANE-targeted)...")
    import coremltools as ct
    from coremltools.converters.mil import Builder as mb  # noqa: F401

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
    mlmodel.author = "BAAI / Kulvex"
    mlmodel.short_description = "BGE-M3 multilingual embedding (ANE)"

    # Save as .mlmodel first, then compile to .mlmodelc which is the
    # format the helper loads.
    mlmodel_path = OUTPUT_DIR / "BGE-M3.mlpackage"
    mlmodel.save(str(mlmodel_path))
    print(f"  Wrote {mlmodel_path}")

    print("[4/4] Compiling to .mlmodelc (Core ML runtime format)...")
    # `xcrun coremlc compile <pkg> <out_dir>` produces the .mlmodelc bundle.
    import subprocess
    compiled = subprocess.run(
        ["xcrun", "coremlc", "compile", str(mlmodel_path), str(OUTPUT_DIR)],
        capture_output=True, text=True
    )
    if compiled.returncode != 0:
        print(f"coremlc failed:\n{compiled.stderr}", file=sys.stderr)
        return 1

    target = OUTPUT_DIR / "BGE-M3.mlmodelc"
    print(f"  Wrote {target}")

    # Save tokenizer config alongside the model so the Swift helper
    # can use it (when the pure-Swift tokenizer lands).
    tokenizer_path = OUTPUT_DIR / "tokenizer.json"
    tokenizer.save_pretrained(str(OUTPUT_DIR / "tokenizer"))
    print(f"  Tokenizer written under {OUTPUT_DIR / 'tokenizer'}")

    print()
    print("Done. Next:")
    print(f"  cd {Path(__file__).parent.parent}")
    print(f"  ./build.sh   # compile the Swift helper")
    print(f"  kcode license install  # ensure ane-embedder addon is licensed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
