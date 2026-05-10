#!/usr/bin/env python3
"""
Long-lived xlm-roberta tokenizer sidecar for the Swift ANE embedder.

Spawned once by ANEEmbedder (main.swift) when the helper boots. Reads
JSON-Lines requests from stdin, writes JSON responses to stdout. The
HuggingFace AutoTokenizer for BAAI/bge-m3 (saved at the path passed as
argv[1]) is loaded once and reused for the lifetime of the process.

Protocol (one JSON object per line):
    Request:  {"id": <int>, "text": "<string>", "max_len": 512}
    Response: {"id": <int>, "ids": [<int>, ...]}
    Error:    {"id": <int>, "error": "<message>"}

The IDs returned are pre-padded to max_len with the tokenizer's pad
token id so Swift can feed them straight into the Core ML model
without further padding logic.

Usage:
    python3 tokenize-server.py <path-to-tokenizer-dir>
"""

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: tokenize-server.py <tokenizer-dir>", file=sys.stderr)
        return 2

    tokenizer_dir = sys.argv[1]
    try:
        from transformers import AutoTokenizer
    except ImportError:
        sys.stdout.write(
            json.dumps({"id": 0, "error": "transformers not installed in this Python env"}) + "\n"
        )
        sys.stdout.flush()
        return 3

    try:
        tokenizer = AutoTokenizer.from_pretrained(tokenizer_dir)
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"id": 0, "error": f"tokenizer load failed: {e}"}) + "\n")
        sys.stdout.flush()
        return 4

    # Announce ready so Swift can start sending requests.
    sys.stdout.write(json.dumps({"id": 0, "ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = 0
        try:
            req = json.loads(line)
            req_id = int(req.get("id", 0))
            text = req.get("text", "")
            max_len = int(req.get("max_len", 512))
            encoded = tokenizer(
                text,
                max_length=max_len,
                padding="max_length",
                truncation=True,
                return_tensors=None,
            )
            ids = encoded["input_ids"]
            # AutoTokenizer can return either a list or a list-of-lists when
            # called on a single string vs a batch. Normalize to a flat list.
            if ids and isinstance(ids[0], list):
                ids = ids[0]
            sys.stdout.write(json.dumps({"id": req_id, "ids": ids}) + "\n")
            sys.stdout.flush()
        except Exception as e:  # noqa: BLE001
            sys.stdout.write(json.dumps({"id": req_id, "error": str(e)}) + "\n")
            sys.stdout.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
