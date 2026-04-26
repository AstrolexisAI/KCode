// Vulnerable: innerHTML assigned dynamic user input — XSS.
function renderComment(comment) {
  const el = document.getElementById("comment");
  el.innerHTML = "<p>" + comment.body + "</p>";
}

function renderProfile(profile) {
  const profileEl = document.getElementById("profile");
  profileEl.innerHTML = profile.bio;
}
