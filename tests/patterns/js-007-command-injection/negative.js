// Negative fixture for js-007-command-injection.
// spawn() with an argv array bypasses the shell — user-controlled
// args stay as a single token regardless of metacharacters.

const { spawn } = require("child_process");

function listUserDir(userPath) {
  return spawn("ls", ["-la", userPath]);
}

// SQLite's Database#exec takes SQL, not a shell command — the dotted
// receiver must not match (this exact shape produced 35 false
// candidates in KCode's own db.ts).
const db = openDatabase();
db.exec(`CREATE TABLE IF NOT EXISTS narrative (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL
)`);

// RegExp#exec with a template literal is string matching, not a shell.
const matcher = /v(\d+)/;
matcher.exec(`v${42}`);
