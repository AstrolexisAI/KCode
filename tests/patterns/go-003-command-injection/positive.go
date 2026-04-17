// Positive fixture for go-003-command-injection.
// exec.Command with its command string built from fmt.Sprintf over
// user input goes through the shell and gets injected.
package main

import (
	"fmt"
	"os/exec"
)

func ListDir(dir string) ([]byte, error) {
	// CONFIRMED: dir is attacker-controlled, shell interprets metachars.
	return exec.Command(fmt.Sprintf("ls -la %s", dir)).Output()
}
