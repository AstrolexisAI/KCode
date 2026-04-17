"""Negative fixture for py-005-yaml-unsafe-load.

yaml.safe_load is the explicit safe variant — no code execution
path. The pattern regex targets yaml.load specifically.
"""
import yaml

def load_config(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f.read())
