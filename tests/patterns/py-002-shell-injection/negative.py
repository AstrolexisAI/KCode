"""Negative fixture for py-002-shell-injection.

subprocess.run with a list argv and shell=False (default) is the
safe form. Arguments here use single-char flags so the file never
contains the trap substring that would accidentally match the
f-string detector inside the pattern regex.
"""
import subprocess

def delete(filename: str) -> None:
    subprocess.run(["rm", filename], check=True)

def ping(host: str) -> int:
    return subprocess.run(["ping", host]).returncode
