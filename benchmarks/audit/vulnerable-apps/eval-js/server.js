// Vulnerable: user-controlled HTTP body flows directly into eval.
const express = require("express");
const app = express();
app.use(express.json());

app.post("/api/run", (req, res) => {
  const result = eval(req.body.code);
  res.json({ result });
});

app.listen(3000);
