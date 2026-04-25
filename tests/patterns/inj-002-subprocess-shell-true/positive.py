# Positive fixture for inj-002-subprocess-shell-true.
# shell=True with user-controllable input is RCE — any `;`, `|`,
# `` ` ``, `$()` in the argument is executed by /bin/sh.
import subprocess

def clone(repo_url: str) -> None:
    subprocess.run(f"git clone {repo_url}", shell=True)
