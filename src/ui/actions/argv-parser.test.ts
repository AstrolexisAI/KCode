// Tests for the CL.4 shell-quote-aware argv parser.

import { describe, expect, test } from "bun:test";
import { parseArgv, tokenize } from "./argv-parser";

describe("parseArgv — basic tokenization", () => {
  test("empty input → empty array", () => {
    expect(parseArgv("")).toEqual([]);
    expect(parseArgv("   ")).toEqual([]);
  });

  test("single bare word", () => {
    expect(parseArgv("scan")).toEqual(["scan"]);
  });

  test("multiple bare words split on whitespace", () => {
    expect(parseArgv("scan . --skip-verify")).toEqual(["scan", ".", "--skip-verify"]);
  });

  test("collapses runs of whitespace", () => {
    expect(parseArgv("scan    .   --json")).toEqual(["scan", ".", "--json"]);
  });

  test("handles tabs and newlines as whitespace", () => {
    expect(parseArgv("scan\t.\n--json")).toEqual(["scan", ".", "--json"]);
  });
});

describe("parseArgv — quoting", () => {
  test("double-quoted preserves spaces", () => {
    expect(parseArgv(`scan "my project" --json`)).toEqual(["scan", "my project", "--json"]);
  });

  test("single-quoted preserves spaces literally (no escape interpretation)", () => {
    expect(parseArgv(`note 1 'verbatim \\n text'`)).toEqual(["note", "1", "verbatim \\n text"]);
  });

  test("backslash inside double quotes escapes the next char", () => {
    expect(parseArgv(`note 1 "say \\"hi\\""`)).toEqual(["note", "1", 'say "hi"']);
  });

  test("backslash outside quotes escapes whitespace", () => {
    expect(parseArgv(`scan my\\ project`)).toEqual(["scan", "my project"]);
  });

  test("concatenated quoted+unquoted forms one token", () => {
    expect(parseArgv(`prefix"middle"suffix`)).toEqual(["prefixmiddlesuffix"]);
  });

  test("mixed single + double quotes both preserved verbatim", () => {
    // Single inside double is literal; double inside single is literal.
    expect(parseArgv(`note 1 "it's"`)).toEqual(["note", "1", "it's"]);
    expect(parseArgv(`note 1 'say "hi"'`)).toEqual(["note", "1", `say "hi"`]);
  });

  test("empty quoted string produces an empty-string token", () => {
    expect(parseArgv(`note 1 ""`)).toEqual(["note", "1", ""]);
    expect(parseArgv(`note 1 ''`)).toEqual(["note", "1", ""]);
  });
});

describe("parseArgv — error handling", () => {
  test("unterminated double quote throws", () => {
    expect(() => parseArgv(`note 1 "no end`)).toThrow(/Unterminated double/);
  });

  test("unterminated single quote throws", () => {
    expect(() => parseArgv(`note 1 'no end`)).toThrow(/Unterminated single/);
  });

  test("trailing lone backslash treated as literal", () => {
    expect(parseArgv(`note 1 trailing\\`)).toEqual(["note", "1", "trailing\\"]);
  });
});

describe("tokenize — convenience wrapper", () => {
  test("null/undefined → empty", () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  test("trims surrounding whitespace before parsing", () => {
    expect(tokenize("   review .   ")).toEqual(["review", "."]);
  });
});

describe("realistic /review note scenarios", () => {
  test("note with quoted free text", () => {
    expect(tokenize(`. note 1 "validated by auth middleware"`)).toEqual([
      ".",
      "note",
      "1",
      "validated by auth middleware",
    ]);
  });

  test("ignore with quoted reason after --reason flag", () => {
    expect(tokenize(`. ignore 4,8 --reason "tracked in JIRA-1234"`)).toEqual([
      ".",
      "ignore",
      "4,8",
      "--reason",
      "tracked in JIRA-1234",
    ]);
  });

  test("path with spaces survives", () => {
    expect(tokenize(`"my client" --since main`)).toEqual(["my client", "--since", "main"]);
  });
});
