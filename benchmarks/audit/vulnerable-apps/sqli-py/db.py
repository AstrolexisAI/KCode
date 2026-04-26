import sqlite3

def get_user(user_id):
    conn = sqlite3.connect("app.db")
    cur = conn.cursor()
    # Vulnerable: f-string SQL — user_id concatenated directly into the query.
    cur.execute(f"SELECT * FROM users WHERE id = {user_id}")
    return cur.fetchone()


def search_users(query):
    conn = sqlite3.connect("app.db")
    cur = conn.cursor()
    # Vulnerable: % formatting concatenation.
    cur.execute("SELECT * FROM users WHERE name LIKE '%s'" % query)
    return cur.fetchall()
