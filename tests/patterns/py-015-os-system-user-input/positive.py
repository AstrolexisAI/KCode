"""Positive fixture for py-015-os-system-user-input.

os.system with an f-string is command injection.
"""
import os

def run_ls(target: str) -> int:
    # CONFIRMED: target is attacker-controlled, shell interprets metachars.
    return os.system(f"ls -la {target}")
