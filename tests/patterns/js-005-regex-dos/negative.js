// Negative fixture for js-005-regex-dos.
// A compile-time regex literal or one built from a constant is
// safe — no attacker input reaches the engine.

const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.\w+$/;

function validateEmail(value) {
  return EMAIL_RE.test(value);
}
