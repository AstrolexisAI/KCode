// Positive fixture for js-002-innerhtml.
// Dynamic HTML assignment via innerHTML/outerHTML is the classic
// stored-XSS vector.

function renderComment(commentEl, user) {
  // CONFIRMED: user.bio is attacker-controlled text rendered as HTML.
  commentEl.innerHTML = `<b>${user.name}</b>: ${user.bio}`;
}

function replaceNode(node, payload) {
  node.outerHTML = payload;
}
