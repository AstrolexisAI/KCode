// Negative fixture for go-003-command-injection.
// exec.Command with separate argv entries bypasses the shell —
// no injection surface.
package main

import "os/exec"

func ListDir(dir string) ([]byte, error) {
	cmd := exec.Command("ls", "-la", dir)
	return cmd.Output()
}
