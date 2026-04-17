"""Negative fixture for py-015-os-system-user-input.

os.system with a static literal string is benign.
"""
import os

def uptime() -> int:
    return os.system("uptime")
