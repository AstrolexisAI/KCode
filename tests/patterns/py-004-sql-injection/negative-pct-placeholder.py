"""Negative fixture for py-004-sql-injection — %s placeholder regression.

Before the Phase 3 fix, the regex branch `["'].*%` matched `%s`
placeholder strings because any `%` after a quote triggered it.
The fix requires `%[\s(]` — Python %-format operator is always
`%` + whitespace (e.g. `"x" % var`) or `%(` for named dicts.
SQL placeholders `%s` / `%d` / `%i` are `%` + letter and no
longer match.
"""

def get_user(cursor, username: str):
    # Parameterized query using %s placeholder (psycopg2 / MySQLdb).
    cursor.execute("SELECT * FROM users WHERE name = %s", (username,))
    return cursor.fetchone()

def multi_insert(cursor, rows):
    # %s with multiple placeholders, still parameterized.
    cursor.executemany(
        "INSERT INTO logs (level, message, created) VALUES (%s, %s, %s)",
        rows,
    )
