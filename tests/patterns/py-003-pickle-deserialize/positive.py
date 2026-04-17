"""Positive fixture for py-003-pickle-deserialize.

pickle.loads / marshal.loads / shelve.open on attacker-controlled
data is arbitrary-code execution at deserialize time.
"""
import pickle

def restore_session(blob: bytes) -> dict:
    # CONFIRMED: blob comes from network → RCE on deserialization.
    return pickle.loads(blob)
