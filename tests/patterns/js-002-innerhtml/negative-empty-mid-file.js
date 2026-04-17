// Negative fixture for js-002-innerhtml — empty-string assignment
// in the middle of a file regression.
//
// Before Phase 3b, the negative lookahead `(?!["'`]\s*$)` used `$`
// without the `m` flag, so it only matched end-of-input. Any empty
// innerHTML assignment with code AFTER it in the file was flagged
// anyway. With the `m` flag, `$` now means end-of-line and this
// clears the assignment even when the file continues below.

function reset(el) {
  el.innerHTML = "";
}

function render(el, text) {
  el.textContent = text;
}

function clearAll(elements) {
  for (const el of elements) {
    el.innerHTML = "";
    el.classList.remove("has-content");
  }
}

module.exports = { reset, render, clearAll };
