"""Negative fixture for py-003-pickle-deserialize.

json.loads is the safe deserializer for untrusted data. No pickle,
no marshal, no shelve — regex stays cold.
"""
import json

def restore_session(blob: bytes) -> dict:
    return json.loads(blob)
