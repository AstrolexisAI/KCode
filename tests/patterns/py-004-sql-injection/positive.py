"""Positive fixture for py-004-sql-injection.

cursor.execute with f-string / .format / % formatting = SQL
injection. The driver treats the whole string as one query.
"""

def get_user(cursor, username: str):
    # CONFIRMED: username interpolated into SQL string.
    cursor.execute(f"SELECT * FROM users WHERE name = '{username}'")
    return cursor.fetchone()
