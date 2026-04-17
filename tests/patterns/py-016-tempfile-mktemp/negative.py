"""Negative fixture for py-016-tempfile-mktemp.

tempfile.mkstemp() returns a fd+path atomically — no race.
The regex targets mktemp specifically.
"""
import tempfile, os

def make_temp_file() -> int:
    fd, _path = tempfile.mkstemp(suffix=".tmp")
    return fd
