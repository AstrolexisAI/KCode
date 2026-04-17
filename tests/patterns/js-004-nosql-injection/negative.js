// Negative fixture for js-004-nosql-injection.
// Querying with sanitized / type-coerced input means user-supplied
// operators can't smuggle through. Pattern requires direct req.* in
// the query object.

async function authenticate(db, sanitized) {
  return db.users.findOne({ name: sanitized.name, password: sanitized.password });
}
