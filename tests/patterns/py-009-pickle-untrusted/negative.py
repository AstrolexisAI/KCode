"""Negative fixture for py-009-pickle-untrusted.

pickle.loads from a local, trusted file is not flagged —
the regex targets untrusted source identifiers specifically.
"""
import pickle

def restore_cache(path: str):
    with open(path, "rb") as f:
        return pickle.loads(f.read())
