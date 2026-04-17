// Negative fixture for js-001-eval.
// Variables whose names contain the letters "eval" must not trip
// the \beval\s*\( regex because the word boundary + adjacent open
// paren is what the pattern actually targets.

function runPolicy(rule) {
  const evaluatedText = rule.trim();
  const prefixOk = evaluatedText.startsWith("allow:");
  return prefixOk && evaluatedText.length > 0;
}

module.exports = { runPolicy };
