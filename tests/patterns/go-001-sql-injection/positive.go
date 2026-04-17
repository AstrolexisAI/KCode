// Positive fixture for go-001-sql-injection.
// fmt.Sprintf inside db.Query / QueryRow / Exec is classic
// injection — user input ends up unparameterized.
package main

import (
	"database/sql"
	"fmt"
)

func GetUser(db *sql.DB, username string) *sql.Row {
	// CONFIRMED: username is attacker-controlled, Sprintf'd inline.
	return db.QueryRow(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", username))
}
