// Negative fixture: pure utility code, no security-relevant APIs.
function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

module.exports = { clamp, range };
