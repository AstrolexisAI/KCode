// Negative fixture for go-001-sql-injection.
// Parameterized queries with placeholders are the safe form —
// the driver handles escaping, the user input never touches SQL.
package main

import (
	"database/sql"
)

func GetUser(db *sql.DB, username string) *sql.Row {
	return db.QueryRow("SELECT * FROM users WHERE name = $1", username)
}
