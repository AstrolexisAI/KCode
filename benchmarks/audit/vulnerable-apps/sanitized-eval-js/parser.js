// Negative fixture: no eval, no innerHTML, no exec — pure data parsing.
function parseConfig(jsonString) {
  return JSON.parse(jsonString);
}

function buildResponse(data) {
  return { status: "ok", payload: data };
}

module.exports = { parseConfig, buildResponse };
