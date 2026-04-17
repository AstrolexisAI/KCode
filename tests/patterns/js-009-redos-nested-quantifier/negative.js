// Negative fixture for js-009-redos-nested-quantifier.
// Constant literal regex tested against user input is safe.
// The pattern requires BOTH the RegExp constructor and
// .test/.match/.exec on user input nearby.

const SLUG = /^[a-z0-9-]+$/;

function isSlug(value) {
  return SLUG.test(value);
}
