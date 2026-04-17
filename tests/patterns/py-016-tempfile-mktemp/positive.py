"""Positive fixture for py-016-tempfile-mktemp.

tempfile.mktemp() has a TOCTOU race — the path is returned but
not created, so an attacker can create a symlink before open().
Use tempfile.mkstemp() which returns an open fd atomically.
"""
import tempfile

def make_temp_path() -> str:
    # CONFIRMED: race-prone, returns just a name.
    return tempfile.mktemp(suffix=".tmp")
