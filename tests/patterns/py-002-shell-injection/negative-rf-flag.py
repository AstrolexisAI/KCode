"""Negative fixture for py-002-shell-injection — 'rf' substring regression.

Before Phase 3b, the f-string detector was `f["']` without a word
boundary, so literal strings like "-rf" or "rm -rf" would match
because the `f` inside them is followed by `"`. This fixture uses
exactly that construct (`-rf` flag to `rm`) and must stay FALSE —
the fix is `\bf["']` with a word boundary.
"""
import subprocess

def clean_tree(root: str) -> None:
    # List argv — safe form. Before the fix, the `f"` inside `"-rf"`
    # tripped the pattern; after, word boundary saves us.
    subprocess.run(["rm", "-rf", root], check=True)

def archive_old(dir_path: str) -> None:
    subprocess.run(["find", dir_path, "-type", "f", "-mtime", "+30"], check=True)
