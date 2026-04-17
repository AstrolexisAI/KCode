// Negative fixture for js-008-prototype-pollution-bracket.
// Assignment via bracket notation with a LITERAL key is safe —
// the regex specifically requires the key to be req./body./query./
// input/key/prop/name/field* variables, not a fixed string.

function setTitle(config, value) {
  // Literal "title" key — no untrusted-input variable in brackets.
  config["title"] = value;
  return config;
}
