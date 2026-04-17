// Positive fixture for js-005-regex-dos.
// Building a RegExp from user input can enable catastrophic
// backtracking if the input contains nested quantifiers.

function search(req, corpus) {
  // CONFIRMED: req.query.pattern is attacker-controlled.
  const rex = new RegExp(req.query.pattern);
  return corpus.filter((s) => rex.test(s));
}
