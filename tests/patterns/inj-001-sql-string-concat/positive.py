# Positive fixture for inj-001-sql-string-concat.
# Concatenating user input into SQL is the canonical injection
# vector — `username = "admin' OR 1=1 --"` bypasses auth.
def login(cursor, username: str, password: str):
    cursor.execute(f"SELECT * FROM users WHERE name = '{username}' AND pw = '{password}'")
    return cursor.fetchone()
