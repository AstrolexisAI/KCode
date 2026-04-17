// Positive fixture for js-003-prototype-pollution.
// Object.assign / lodash merge with req.body directly as source
// can be used to poison Object.prototype.

function updateUser(existing, req) {
  // CONFIRMED: req.body is attacker-controlled and may contain
  // __proto__ that Object.assign recursively copies.
  return Object.assign(existing, req.body);
}
