"""Positive fixture for py-005-yaml-unsafe-load.

yaml.load() without an explicit safe Loader deserializes arbitrary
Python objects and executes __reduce__ — remote code execution.
"""
import yaml

def load_config(path: str) -> dict:
    with open(path) as f:
        # CONFIRMED: default Loader is unsafe before PyYAML 6.0 and
        # even then explicit Loader= is required for SafeLoader.
        return yaml.load(f.read())
