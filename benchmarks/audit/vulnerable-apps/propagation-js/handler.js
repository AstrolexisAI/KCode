// Vulnerable: taint propagates from req.body through a local variable
// into eval. The regex catches the eval(...) call but cannot prove the
// argument is attacker-controlled — this is exactly what AST taint
// analysis adds.
const express = require("express");
const app = express();

app.post("/exec", (req, res) => {
  const code = req.body.code;
  const result = eval(code);
  res.json({ result });
});

// Vulnerable: req.body member written into innerHTML through
// concatenation with literal HTML. Concat does not launder taint.
function renderUserCard(req, container) {
  const html = "<div class='card'>" + req.body.username + "</div>";
  container.innerHTML = html;
}

app.listen(3000);
