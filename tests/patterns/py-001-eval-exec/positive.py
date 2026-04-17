"""Positive fixture for py-001-eval-exec.

eval() / exec() on anything that isn't a literal is the textbook
remote-code-execution footgun. Both call sites here trip the regex.
"""

def run_user_expression(expr: str) -> object:
    # CONFIRMED: expr is attacker-controlled, eval() on it is RCE.
    return eval(expr)

def run_user_code(src: str) -> None:
    # CONFIRMED: exec() with untrusted src is RCE.
    exec(src)
