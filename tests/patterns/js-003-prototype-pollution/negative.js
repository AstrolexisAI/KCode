// Negative fixture for js-003-prototype-pollution.
// Object.assign with a SANITIZED intermediate object (not req.*)
// is safe — the pattern only matches when the source is a raw
// request property.

function updateUser(existing, sanitized) {
  return Object.assign(existing, sanitized);
}
