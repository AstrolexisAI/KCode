"""Negative fixture for py-004-sql-injection.

Parameterized execute with `?` placeholders (sqlite3, MySQL
connector with named params, psycopg2 named style) is the safe
form. Using `?` instead of `%s` also avoids false-matching the
regex's `["'].*%` branch — py-004 can't tell %s placeholders
apart from % string formatting.
"""

def get_user(cursor, username: str):
    cursor.execute("SELECT * FROM users WHERE name = ?", (username,))
    return cursor.fetchone()
