// Positive fixture for js-007-command-injection.
// Template literals in child_process.exec pass everything to the
// shell — any variable interpolation becomes injection.

const { exec } = require("child_process");

function listUserDir(req) {
  // CONFIRMED: req.body.path → shell.
  exec(`ls -la ${req.body.path}`, (err, stdout) => {
    console.log(stdout);
  });
}
