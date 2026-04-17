// Positive fixture for js-004-nosql-injection.
// MongoDB find with a query object that embeds req.body directly
// lets an attacker smuggle operators like $ne or $gt.

async function authenticate(db, req) {
  // CONFIRMED: req.body.password could be {"$ne": null} → auth bypass.
  return db.users.findOne({ name: req.body.name, password: req.body.password });
}
