// Negative fixture for js-002-innerhtml.
// textContent is the safe, always-escaped counterpart of innerHTML
// and never trips the innerHTML/outerHTML regex.

function setSafeText(el, text) {
  el.textContent = text;
}

function appendChild(parent, child) {
  parent.appendChild(child);
}

module.exports = { setSafeText, appendChild };
