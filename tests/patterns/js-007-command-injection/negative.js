// Negative fixture for js-007-command-injection.
// spawn() with an argv array bypasses the shell — user-controlled
// args stay as a single token regardless of metacharacters.

const { spawn } = require("child_process");

function listUserDir(userPath) {
  return spawn("ls", ["-la", userPath]);
}
