// Negative fixture for js-006-hardcoded-secret.
// Secrets fetched from env / vault at runtime don't match a
// literal-string-assignment pattern.

const API_KEY = process.env.API_KEY;
const PRIVATE_KEY = await vault.read("private-key");
const PASSWORD = null; // set by login flow, not hard-coded

module.exports = { API_KEY, PRIVATE_KEY, PASSWORD };
