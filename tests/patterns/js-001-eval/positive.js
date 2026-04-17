// Positive fixture for js-001-eval.
// Bare eval() is always suspicious; with dynamic input it's RCE.

function runUserExpression(expr) {
  // CONFIRMED: expr is attacker-controlled input reaching eval().
  return eval(expr);
}

module.exports = { runUserExpression };
