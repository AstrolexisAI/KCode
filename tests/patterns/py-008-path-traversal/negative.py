"""Negative fixture for py-008-path-traversal.

open() with a hardcoded literal path has no traversal surface.
"""

def read_static_config() -> str:
    with open("/etc/myapp/config.toml") as f:
        return f.read()
