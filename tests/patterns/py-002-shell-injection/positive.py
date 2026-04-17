"""Positive fixture for py-002-shell-injection.

os.system / subprocess.* with shell=True OR an f-string / format /
% template is a command-injection pipeline. Regex requires one of
those markers right after the open paren.
"""
import os
import subprocess

def delete(filename: str) -> None:
    # CONFIRMED: f-string interpolation + os.system = shell injection.
    os.system(f"rm -rf /tmp/{filename}")

def run_cmd(user_arg: str) -> None:
    # CONFIRMED: shell=True on untrusted input.
    subprocess.run(f"echo {user_arg}", shell=True)
