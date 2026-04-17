"""Positive fixture for py-008-path-traversal.

open() with an f-string or string-concat path lets an attacker
slip ../../ traversal through. Regex catches the common building
forms: f-string, concat, .format, or % interpolation.
"""

def read_user_file(filename: str) -> str:
    # CONFIRMED: filename is attacker-controlled.
    with open(f"/srv/uploads/{filename}") as f:
        return f.read()
