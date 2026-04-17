// Positive fixture for js-009-redos-nested-quantifier.
// A RegExp compiled from user input and then executed on another
// piece of user input is the catastrophic-backtracking recipe.

function findMatches(req) {
  const rex = new RegExp(req.query.pattern);
  return rex.test(req.body.haystack);
}
