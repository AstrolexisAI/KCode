# Negative fixture for inj-001-sql-string-concat.
# Parameterized query with placeholders — driver escapes the values,
# attacker payload is just data, not SQL.
def login(cursor, username: str, password: str):
    cursor.execute(
        "SELECT * FROM users WHERE name = ? AND pw = ?",
        (username, password),
    )
    return cursor.fetchone()
