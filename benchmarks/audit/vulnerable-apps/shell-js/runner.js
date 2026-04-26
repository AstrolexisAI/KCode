// Vulnerable: shell injection via child_process.exec with concatenated user input.
const { exec } = require("child_process");

function listDir(userPath) {
  exec("ls " + userPath, (err, stdout) => {
    if (err) console.error(err);
    else console.log(stdout);
  });
}

listDir(process.argv[2]);
