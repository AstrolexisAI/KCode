// Positive fixture for js-008-prototype-pollution-bracket.
// obj[userKey] = value with userKey coming from req/body/query/input
// etc. enables __proto__ pollution attacks.

function mergeUserInput(target, req) {
  for (const key in req.body) {
    // CONFIRMED: req.body[key] is attacker-controlled, 'key' may be
    // "__proto__" — target[key] = value then overwrites prototype.
    target[key] = req.body[key];
  }
  return target;
}
