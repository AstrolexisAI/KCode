# Negative fixture for inj-002-subprocess-shell-true.
# Args as a list — no shell interpretation; metacharacters in repo_url
# stay as data.
import subprocess

def clone(repo_url: str) -> None:
    subprocess.run(["git", "clone", repo_url])
