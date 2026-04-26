// Ambiguous: eval is used to load a config file written by the same
// process. If the config path is hardcoded and the file is created
// only by trusted code, this is benign. If the path is reachable from
// user input, it's RCE. The verifier should mark this needs_context
// without more code.
const fs = require("fs");

function loadConfig(configPath) {
  const text = fs.readFileSync(configPath, "utf-8");
  return eval(text);
}

module.exports = { loadConfig };
