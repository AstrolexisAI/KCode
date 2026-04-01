// KCode - Streaming Markdown-to-ANSI Renderer
// Renders markdown text with ANSI formatting using Ink components.
// Handles partial/streaming text gracefully — incomplete markdown renders as plain text.

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "../ThemeContext.js";

// ─── Keyword-based Syntax Highlighting ─────────────────────────

const KEYWORD_SETS: Record<
  string,
  { keywords: Set<string>; types: Set<string>; builtins: Set<string>; _hashComment?: boolean }
> = {
  ts: {
    keywords: new Set([
      "import",
      "export",
      "from",
      "const",
      "let",
      "var",
      "function",
      "return",
      "if",
      "else",
      "for",
      "while",
      "switch",
      "case",
      "break",
      "default",
      "new",
      "class",
      "extends",
      "implements",
      "interface",
      "type",
      "enum",
      "async",
      "await",
      "try",
      "catch",
      "finally",
      "throw",
      "typeof",
      "instanceof",
      "in",
      "of",
      "as",
      "is",
      "this",
      "super",
      "yield",
      "delete",
      "void",
      "static",
      "readonly",
      "abstract",
      "declare",
      "namespace",
      "module",
      "require",
    ]),
    types: new Set([
      "string",
      "number",
      "boolean",
      "any",
      "void",
      "null",
      "undefined",
      "never",
      "unknown",
      "object",
      "Array",
      "Map",
      "Set",
      "Promise",
      "Record",
      "Partial",
      "Required",
      "Readonly",
      "Pick",
      "Omit",
    ]),
    builtins: new Set([
      "console",
      "process",
      "Math",
      "JSON",
      "Date",
      "Error",
      "RegExp",
      "parseInt",
      "parseFloat",
      "isNaN",
      "isFinite",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "fetch",
      "Buffer",
      "Symbol",
      "Proxy",
      "Reflect",
    ]),
  },
  py: {
    keywords: new Set([
      "import",
      "from",
      "def",
      "return",
      "if",
      "elif",
      "else",
      "for",
      "while",
      "class",
      "try",
      "except",
      "finally",
      "raise",
      "with",
      "as",
      "is",
      "in",
      "not",
      "and",
      "or",
      "lambda",
      "yield",
      "pass",
      "break",
      "continue",
      "del",
      "global",
      "nonlocal",
      "assert",
      "async",
      "await",
    ]),
    types: new Set([
      "int",
      "float",
      "str",
      "bool",
      "list",
      "dict",
      "tuple",
      "set",
      "None",
      "bytes",
      "type",
      "object",
      "complex",
      "frozenset",
    ]),
    builtins: new Set([
      "print",
      "len",
      "range",
      "enumerate",
      "zip",
      "map",
      "filter",
      "sorted",
      "reversed",
      "isinstance",
      "hasattr",
      "getattr",
      "setattr",
      "super",
      "open",
      "input",
      "format",
      "repr",
      "abs",
      "all",
      "any",
      "min",
      "max",
      "sum",
      "round",
      "id",
      "hash",
      "dir",
      "vars",
      "globals",
      "locals",
    ]),
    _hashComment: true,
  },
  go: {
    keywords: new Set([
      "package",
      "import",
      "func",
      "return",
      "if",
      "else",
      "for",
      "range",
      "switch",
      "case",
      "default",
      "var",
      "const",
      "type",
      "struct",
      "interface",
      "map",
      "chan",
      "go",
      "defer",
      "select",
      "break",
      "continue",
      "fallthrough",
      "goto",
    ]),
    types: new Set([
      "string",
      "int",
      "int8",
      "int16",
      "int32",
      "int64",
      "uint",
      "uint8",
      "uint16",
      "uint32",
      "uint64",
      "float32",
      "float64",
      "bool",
      "byte",
      "rune",
      "error",
      "any",
      "complex64",
      "complex128",
      "uintptr",
    ]),
    builtins: new Set([
      "fmt",
      "make",
      "len",
      "cap",
      "append",
      "copy",
      "delete",
      "new",
      "panic",
      "recover",
      "close",
      "print",
      "println",
      "nil",
      "true",
      "false",
      "iota",
    ]),
  },
  rs: {
    keywords: new Set([
      "use",
      "mod",
      "pub",
      "fn",
      "let",
      "mut",
      "const",
      "return",
      "if",
      "else",
      "for",
      "while",
      "loop",
      "match",
      "struct",
      "enum",
      "impl",
      "trait",
      "type",
      "async",
      "await",
      "move",
      "ref",
      "self",
      "super",
      "crate",
      "where",
      "unsafe",
      "extern",
      "dyn",
      "as",
      "in",
    ]),
    types: new Set([
      "i8",
      "i16",
      "i32",
      "i64",
      "i128",
      "u8",
      "u16",
      "u32",
      "u64",
      "u128",
      "f32",
      "f64",
      "bool",
      "char",
      "str",
      "String",
      "Vec",
      "Box",
      "Option",
      "Result",
      "Some",
      "None",
      "Ok",
      "Err",
      "HashMap",
      "HashSet",
      "usize",
      "isize",
    ]),
    builtins: new Set([
      "println",
      "print",
      "eprintln",
      "format",
      "vec",
      "todo",
      "unimplemented",
      "unreachable",
      "assert",
      "assert_eq",
      "assert_ne",
      "cfg",
      "derive",
      "include",
      "include_str",
    ]),
  },
  sh: {
    keywords: new Set([
      "if",
      "then",
      "else",
      "elif",
      "fi",
      "for",
      "while",
      "do",
      "done",
      "case",
      "esac",
      "in",
      "function",
      "return",
      "local",
      "export",
      "source",
      "alias",
      "unalias",
      "set",
      "unset",
      "readonly",
      "shift",
      "exit",
      "break",
      "continue",
      "trap",
      "eval",
      "exec",
    ]),
    types: new Set([]),
    builtins: new Set([
      "echo",
      "cd",
      "pwd",
      "ls",
      "cat",
      "grep",
      "sed",
      "awk",
      "find",
      "xargs",
      "sort",
      "uniq",
      "wc",
      "head",
      "tail",
      "cut",
      "tr",
      "tee",
      "mkdir",
      "rm",
      "cp",
      "mv",
      "chmod",
      "chown",
      "test",
      "read",
      "printf",
      "true",
      "false",
    ]),
    _hashComment: true,
  },
  java: {
    keywords: new Set([
      "import",
      "package",
      "class",
      "interface",
      "extends",
      "implements",
      "public",
      "private",
      "protected",
      "static",
      "final",
      "abstract",
      "synchronized",
      "volatile",
      "transient",
      "native",
      "strictfp",
      "new",
      "return",
      "if",
      "else",
      "for",
      "while",
      "do",
      "switch",
      "case",
      "break",
      "default",
      "continue",
      "try",
      "catch",
      "finally",
      "throw",
      "throws",
      "this",
      "super",
      "instanceof",
      "void",
      "enum",
      "assert",
      "yield",
      "var",
      "record",
      "sealed",
      "permits",
    ]),
    types: new Set([
      "int",
      "long",
      "short",
      "byte",
      "float",
      "double",
      "boolean",
      "char",
      "String",
      "Integer",
      "Long",
      "Double",
      "Float",
      "Boolean",
      "Object",
      "List",
      "Map",
      "Set",
      "Optional",
      "Stream",
      "Collection",
      "Array",
      "void",
    ]),
    builtins: new Set([
      "System",
      "Math",
      "Arrays",
      "Collections",
      "Objects",
      "Thread",
      "Runnable",
      "Exception",
      "RuntimeException",
      "Override",
      "Deprecated",
      "SuppressWarnings",
      "FunctionalInterface",
      "null",
      "true",
      "false",
    ]),
  },
  c: {
    keywords: new Set([
      "auto",
      "break",
      "case",
      "char",
      "const",
      "continue",
      "default",
      "do",
      "double",
      "else",
      "enum",
      "extern",
      "float",
      "for",
      "goto",
      "if",
      "inline",
      "int",
      "long",
      "register",
      "restrict",
      "return",
      "short",
      "signed",
      "sizeof",
      "static",
      "struct",
      "switch",
      "typedef",
      "union",
      "unsigned",
      "void",
      "volatile",
      "while",
      "_Bool",
      "_Complex",
      "_Imaginary",
    ]),
    types: new Set([
      "int",
      "char",
      "float",
      "double",
      "void",
      "long",
      "short",
      "unsigned",
      "signed",
      "size_t",
      "ssize_t",
      "uint8_t",
      "uint16_t",
      "uint32_t",
      "uint64_t",
      "int8_t",
      "int16_t",
      "int32_t",
      "int64_t",
      "bool",
      "FILE",
      "NULL",
    ]),
    builtins: new Set([
      "printf",
      "fprintf",
      "sprintf",
      "scanf",
      "malloc",
      "calloc",
      "realloc",
      "free",
      "memcpy",
      "memset",
      "strlen",
      "strcmp",
      "strcpy",
      "strcat",
      "fopen",
      "fclose",
      "fread",
      "fwrite",
      "exit",
      "abort",
      "assert",
      "sizeof",
      "NULL",
      "true",
      "false",
      "stdin",
      "stdout",
      "stderr",
    ]),
  },
  rb: {
    keywords: new Set([
      "def",
      "end",
      "class",
      "module",
      "if",
      "elsif",
      "else",
      "unless",
      "case",
      "when",
      "while",
      "until",
      "for",
      "do",
      "begin",
      "rescue",
      "ensure",
      "raise",
      "return",
      "yield",
      "block_given?",
      "require",
      "require_relative",
      "include",
      "extend",
      "attr_accessor",
      "attr_reader",
      "attr_writer",
      "self",
      "super",
      "nil",
      "true",
      "false",
      "and",
      "or",
      "not",
      "in",
      "then",
      "lambda",
      "proc",
    ]),
    types: new Set([
      "String",
      "Integer",
      "Float",
      "Array",
      "Hash",
      "Symbol",
      "NilClass",
      "TrueClass",
      "FalseClass",
      "Regexp",
      "Range",
      "IO",
      "File",
      "Dir",
      "Proc",
      "Method",
      "Struct",
      "Enumerable",
      "Comparable",
    ]),
    builtins: new Set([
      "puts",
      "print",
      "p",
      "gets",
      "chomp",
      "each",
      "map",
      "select",
      "reject",
      "reduce",
      "inject",
      "find",
      "sort",
      "length",
      "size",
      "empty?",
      "nil?",
      "is_a?",
      "respond_to?",
      "send",
      "method_missing",
      "define_method",
      "freeze",
      "frozen?",
      "dup",
      "clone",
    ]),
    _hashComment: true,
  },
  sql: {
    keywords: new Set([
      "SELECT",
      "FROM",
      "WHERE",
      "INSERT",
      "INTO",
      "VALUES",
      "UPDATE",
      "SET",
      "DELETE",
      "CREATE",
      "TABLE",
      "ALTER",
      "DROP",
      "INDEX",
      "VIEW",
      "JOIN",
      "INNER",
      "LEFT",
      "RIGHT",
      "OUTER",
      "FULL",
      "CROSS",
      "ON",
      "AND",
      "OR",
      "NOT",
      "IN",
      "BETWEEN",
      "LIKE",
      "IS",
      "NULL",
      "AS",
      "ORDER",
      "BY",
      "GROUP",
      "HAVING",
      "LIMIT",
      "OFFSET",
      "UNION",
      "ALL",
      "DISTINCT",
      "EXISTS",
      "CASE",
      "WHEN",
      "THEN",
      "ELSE",
      "END",
      "PRIMARY",
      "KEY",
      "FOREIGN",
      "REFERENCES",
      "CONSTRAINT",
      "DEFAULT",
      "CHECK",
      "UNIQUE",
      "AUTO_INCREMENT",
      "CASCADE",
      "TRIGGER",
      "PROCEDURE",
      "FUNCTION",
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
      "TRANSACTION",
      "GRANT",
      "REVOKE",
      "WITH",
      "RECURSIVE",
    ]),
    types: new Set([
      "INT",
      "INTEGER",
      "BIGINT",
      "SMALLINT",
      "TINYINT",
      "FLOAT",
      "DOUBLE",
      "DECIMAL",
      "NUMERIC",
      "VARCHAR",
      "CHAR",
      "TEXT",
      "BLOB",
      "DATE",
      "DATETIME",
      "TIMESTAMP",
      "BOOLEAN",
      "REAL",
      "SERIAL",
    ]),
    builtins: new Set([
      "COUNT",
      "SUM",
      "AVG",
      "MIN",
      "MAX",
      "COALESCE",
      "IFNULL",
      "NULLIF",
      "CAST",
      "CONVERT",
      "CONCAT",
      "SUBSTRING",
      "TRIM",
      "UPPER",
      "LOWER",
      "LENGTH",
      "REPLACE",
      "NOW",
      "CURRENT_TIMESTAMP",
      "CURRENT_DATE",
      "ROW_NUMBER",
      "RANK",
      "DENSE_RANK",
      "OVER",
      "PARTITION",
    ]),
  },
  css: {
    keywords: new Set([
      "@import",
      "@media",
      "@keyframes",
      "@font-face",
      "@charset",
      "@supports",
      "@layer",
      "@property",
      "@container",
      "!important",
      "from",
      "to",
    ]),
    types: new Set([
      "px",
      "em",
      "rem",
      "vh",
      "vw",
      "vmin",
      "vmax",
      "%",
      "deg",
      "rad",
      "s",
      "ms",
      "fr",
      "auto",
      "none",
      "inherit",
      "initial",
      "unset",
      "revert",
    ]),
    builtins: new Set([
      "var",
      "calc",
      "min",
      "max",
      "clamp",
      "rgb",
      "rgba",
      "hsl",
      "hsla",
      "linear-gradient",
      "radial-gradient",
      "url",
      "attr",
      "env",
      "repeat",
      "minmax",
      "fit-content",
      "grid-template",
      "flex",
    ]),
  },
  html: {
    keywords: new Set([
      "html",
      "head",
      "body",
      "div",
      "span",
      "p",
      "a",
      "img",
      "ul",
      "ol",
      "li",
      "table",
      "tr",
      "td",
      "th",
      "form",
      "input",
      "button",
      "select",
      "option",
      "textarea",
      "label",
      "section",
      "article",
      "nav",
      "header",
      "footer",
      "main",
      "aside",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "script",
      "style",
      "link",
      "meta",
      "title",
      "class",
      "id",
      "href",
      "src",
      "alt",
      "type",
      "name",
      "value",
      "action",
      "method",
    ]),
    types: new Set([]),
    builtins: new Set([]),
  },
  yaml: {
    keywords: new Set(["true", "false", "null", "yes", "no", "on", "off"]),
    types: new Set([]),
    builtins: new Set([]),
    _hashComment: true,
  },
  kt: {
    keywords: new Set([
      "fun",
      "val",
      "var",
      "class",
      "object",
      "interface",
      "enum",
      "sealed",
      "data",
      "abstract",
      "open",
      "override",
      "private",
      "protected",
      "internal",
      "public",
      "companion",
      "import",
      "package",
      "return",
      "if",
      "else",
      "when",
      "for",
      "while",
      "do",
      "try",
      "catch",
      "finally",
      "throw",
      "is",
      "as",
      "in",
      "by",
      "init",
      "constructor",
      "suspend",
      "coroutine",
      "inline",
      "reified",
      "crossinline",
      "noinline",
      "tailrec",
      "operator",
      "infix",
      "typealias",
      "annotation",
      "lateinit",
      "lazy",
    ]),
    types: new Set([
      "Int",
      "Long",
      "Short",
      "Byte",
      "Float",
      "Double",
      "Boolean",
      "Char",
      "String",
      "Unit",
      "Nothing",
      "Any",
      "Array",
      "List",
      "Map",
      "Set",
      "Pair",
      "Triple",
      "Sequence",
      "MutableList",
      "MutableMap",
      "MutableSet",
      "Comparable",
      "Iterable",
    ]),
    builtins: new Set([
      "println",
      "print",
      "listOf",
      "mapOf",
      "setOf",
      "mutableListOf",
      "arrayOf",
      "emptyList",
      "emptyMap",
      "require",
      "check",
      "error",
      "TODO",
      "repeat",
      "run",
      "let",
      "also",
      "apply",
      "with",
      "takeIf",
      "takeUnless",
      "null",
      "true",
      "false",
    ]),
  },
  swift: {
    keywords: new Set([
      "import",
      "class",
      "struct",
      "enum",
      "protocol",
      "extension",
      "func",
      "var",
      "let",
      "return",
      "if",
      "else",
      "guard",
      "switch",
      "case",
      "default",
      "for",
      "while",
      "repeat",
      "do",
      "try",
      "catch",
      "throw",
      "throws",
      "rethrows",
      "in",
      "as",
      "is",
      "self",
      "Self",
      "super",
      "init",
      "deinit",
      "subscript",
      "typealias",
      "associatedtype",
      "where",
      "break",
      "continue",
      "fallthrough",
      "defer",
      "inout",
      "lazy",
      "weak",
      "unowned",
      "static",
      "final",
      "override",
      "mutating",
      "nonmutating",
      "dynamic",
      "optional",
      "required",
      "convenience",
      "async",
      "await",
      "actor",
      "nonisolated",
      "isolated",
      "some",
      "any",
    ]),
    types: new Set([
      "Int",
      "Int8",
      "Int16",
      "Int32",
      "Int64",
      "UInt",
      "Float",
      "Double",
      "Bool",
      "String",
      "Character",
      "Array",
      "Dictionary",
      "Set",
      "Optional",
      "Result",
      "Error",
      "Void",
      "Any",
      "AnyObject",
      "Never",
      "Codable",
      "Equatable",
      "Hashable",
      "Comparable",
      "Identifiable",
      "ObservableObject",
      "View",
      "Published",
      "State",
      "Binding",
      "EnvironmentObject",
    ]),
    builtins: new Set([
      "print",
      "debugPrint",
      "fatalError",
      "precondition",
      "assert",
      "preconditionFailure",
      "assertionFailure",
      "min",
      "max",
      "abs",
      "stride",
      "zip",
      "map",
      "filter",
      "reduce",
      "sorted",
      "forEach",
      "compactMap",
      "flatMap",
      "contains",
      "nil",
      "true",
      "false",
      "some",
      "none",
    ]),
  },
  lua: {
    keywords: new Set([
      "and",
      "break",
      "do",
      "else",
      "elseif",
      "end",
      "for",
      "function",
      "goto",
      "if",
      "in",
      "local",
      "not",
      "or",
      "repeat",
      "return",
      "then",
      "until",
      "while",
    ]),
    types: new Set(["nil", "true", "false"]),
    builtins: new Set([
      "print",
      "type",
      "tostring",
      "tonumber",
      "pairs",
      "ipairs",
      "next",
      "select",
      "unpack",
      "table",
      "string",
      "math",
      "io",
      "os",
      "require",
      "error",
      "pcall",
      "xpcall",
      "assert",
      "setmetatable",
      "getmetatable",
      "rawget",
      "rawset",
      "rawlen",
      "coroutine",
    ]),
    _hashComment: false,
  },
};

const LANG_MAP: Record<string, string> = {
  typescript: "ts",
  ts: "ts",
  tsx: "ts",
  javascript: "ts",
  js: "ts",
  jsx: "ts",
  python: "py",
  py: "py",
  go: "go",
  golang: "go",
  rust: "rs",
  rs: "rs",
  bash: "sh",
  sh: "sh",
  zsh: "sh",
  shell: "sh",
  fish: "sh",
  java: "java",
  kotlin: "kt",
  kt: "kt",
  c: "c",
  cpp: "c",
  "c++": "c",
  h: "c",
  hpp: "c",
  ruby: "rb",
  rb: "rb",
  sql: "sql",
  mysql: "sql",
  postgres: "sql",
  postgresql: "sql",
  sqlite: "sql",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  yaml: "yaml",
  yml: "yaml",
  swift: "swift",
  lua: "lua",
};

// ─── Syntax Highlighting ───────────────────────────────────────

// Pre-compiled token regexes per language key (avoids recompilation per line)
const _tokenRegexCache = new Map<string, RegExp>();

function getTokenRegex(langDef: { _hashComment?: boolean }, cacheKey: string): RegExp {
  let re = _tokenRegexCache.get(cacheKey);
  if (!re) {
    const commentPat = langDef._hashComment ? "\\/\\/.*$|#.*$" : "\\/\\/.*$";
    re = new RegExp(
      `(${commentPat}|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\b\\d+(?:\\.\\d+)?\\b|\\b[a-zA-Z_]\\w*\\b|[^\\s\\w]+|\\s+)`,
      "g",
    );
    _tokenRegexCache.set(cacheKey, re);
  }
  return re;
}

function highlightLine(
  line: string,
  langDef: {
    keywords: Set<string>;
    types: Set<string>;
    builtins: Set<string>;
    _hashComment?: boolean;
  },
  theme: import("../../core/theme.js").Theme,
  langKey: string,
): React.ReactElement[] {
  const parts: React.ReactElement[] = [];
  const cachedRegex = getTokenRegex(langDef, langKey);
  // Create a new instance from the cached source to reset lastIndex (RegExp with /g is stateful)
  const tokenRegex = new RegExp(cachedRegex.source, "g");

  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = tokenRegex.exec(line)) !== null) {
    const token = match[0];
    const key = `t${idx++}`;

    if (token.startsWith("//") || (langDef._hashComment && token.startsWith("#"))) {
      parts.push(
        <Text key={key} color={theme.dimmed} italic>
          {token}
        </Text>,
      );
    } else if (
      (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) &&
      token.length >= 2
    ) {
      parts.push(
        <Text key={key} color={theme.success}>
          {token}
        </Text>,
      );
    } else if (/^\d/.test(token)) {
      parts.push(
        <Text key={key} color={theme.accent}>
          {token}
        </Text>,
      );
    } else if (langDef.keywords.has(token) || langDef.keywords.has(token.toUpperCase())) {
      parts.push(
        <Text key={key} color={theme.primary} bold>
          {token}
        </Text>,
      );
    } else if (langDef.types.has(token) || langDef.types.has(token.toUpperCase())) {
      parts.push(
        <Text key={key} color={theme.warning}>
          {token}
        </Text>,
      );
    } else if (langDef.builtins.has(token) || langDef.builtins.has(token.toUpperCase())) {
      parts.push(
        <Text key={key} color={theme.accent}>
          {token}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={key} color={theme.secondary}>
          {token}
        </Text>,
      );
    }
  }

  if (parts.length === 0) {
    return [<Text key="empty">{""}</Text>];
  }
  return parts;
}

function SyntaxHighlightedCode({
  code,
  lang,
  theme,
  keyPrefix,
}: {
  code: string;
  lang: string;
  theme: import("../../core/theme.js").Theme;
  keyPrefix: string;
}): React.ReactElement {
  const langKey = LANG_MAP[lang.toLowerCase()] ?? "";
  const langDef = KEYWORD_SETS[langKey];

  if (!langDef) {
    return <Text color={theme.warning}>{code}</Text>;
  }

  const lines = code.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, li) => (
        <Text key={`${keyPrefix}-${li}`}>{highlightLine(line, langDef, theme, langKey)}</Text>
      ))}
    </Box>
  );
}

// ─── Inline Markdown Rendering ─────────────────────────────────

/** Render inline markdown: **bold**, *italic*, `code`, [text](url) */
function renderInline(
  line: string,
  keyPrefix: string,
  theme: import("../../core/theme.js").Theme,
): React.ReactElement {
  const parts: React.ReactElement[] = [];
  let remaining = line;
  let partIndex = 0;

  while (remaining.length > 0) {
    // Find earliest match among inline patterns
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/(?<!\*)\*([^*]+?)\*(?!\*)/);
    const codeMatch = remaining.match(/`([^`]+)`/);
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);

    type MatchInfo = {
      type: "bold" | "italic" | "code" | "link";
      index: number;
      fullMatch: string;
    };
    const candidates: MatchInfo[] = [];
    if (boldMatch?.index !== undefined)
      candidates.push({ type: "bold", index: boldMatch.index, fullMatch: boldMatch[0] });
    if (italicMatch?.index !== undefined)
      candidates.push({ type: "italic", index: italicMatch.index, fullMatch: italicMatch[0] });
    if (codeMatch?.index !== undefined)
      candidates.push({ type: "code", index: codeMatch.index, fullMatch: codeMatch[0] });
    if (linkMatch?.index !== undefined)
      candidates.push({ type: "link", index: linkMatch.index, fullMatch: linkMatch[0] });

    if (candidates.length === 0) {
      if (remaining.length > 0) {
        parts.push(<Text key={`${keyPrefix}-${partIndex++}`}>{remaining}</Text>);
      }
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const first = candidates[0]!;

    // Text before the match
    if (first.index > 0) {
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`}>{remaining.slice(0, first.index)}</Text>,
      );
    }

    if (first.type === "bold") {
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`} bold>
          {boldMatch![1]!}
        </Text>,
      );
    } else if (first.type === "italic") {
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`} italic>
          {italicMatch![1]!}
        </Text>,
      );
    } else if (first.type === "code") {
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`} color={theme.warning} dimColor>
          {codeMatch![1]!}
        </Text>,
      );
    } else if (first.type === "link") {
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`} underline>
          {linkMatch![1]!}
        </Text>,
      );
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`} dimColor>{` (${linkMatch![2]!})`}</Text>,
      );
    }

    remaining = remaining.slice(first.index + first.fullMatch.length);
  }

  if (parts.length === 0) return <Text key={keyPrefix}>{""}</Text>;
  if (parts.length === 1) return parts[0]!;
  return <Text key={keyPrefix}>{parts}</Text>;
}

// ─── Table Rendering ───────────────────────────────────────────

function renderTable(
  tableLines: string[],
  theme: import("../../core/theme.js").Theme,
  keyPrefix: string,
): React.ReactElement {
  // Parse rows into cells
  const rows: string[][] = [];
  let separatorIndex = -1;

  for (let i = 0; i < tableLines.length; i++) {
    const line = tableLines[i]!.trim();
    // Detect separator row (e.g. |---|---|)
    if (/^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)*\|?$/.test(line)) {
      separatorIndex = i;
      continue;
    }
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    rows.push(cells);
  }

  if (rows.length === 0) return <Text key={keyPrefix}>{""}</Text>;

  // Compute column widths
  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = 0;
    for (const row of rows) {
      const cell = row[c] ?? "";
      if (cell.length > max) max = cell.length;
    }
    colWidths.push(Math.max(max, 3));
  }

  const horizontalLine = (left: string, mid: string, right: string, fill: string) => {
    return left + colWidths.map((w) => fill.repeat(w + 2)).join(mid) + right;
  };

  const topBorder = horizontalLine("\u250c", "\u252c", "\u2510", "\u2500");
  const midBorder = horizontalLine("\u251c", "\u253c", "\u2524", "\u2500");
  const botBorder = horizontalLine("\u2514", "\u2534", "\u2518", "\u2500");

  const formatRow = (cells: string[]) => {
    const padded = colWidths.map((w, ci) => {
      const cell = cells[ci] ?? "";
      return " " + cell.padEnd(w) + " ";
    });
    return "\u2502" + padded.join("\u2502") + "\u2502";
  };

  const outputLines: React.ReactElement[] = [];
  outputLines.push(
    <Text key={`${keyPrefix}-top`} color={theme.dimmed}>
      {topBorder}
    </Text>,
  );

  for (let ri = 0; ri < rows.length; ri++) {
    const isHeader = ri === 0 && (separatorIndex === 1 || rows.length > 1);
    const rowText = formatRow(rows[ri]!);
    outputLines.push(
      <Text key={`${keyPrefix}-r${ri}`} color={theme.dimmed}>
        {isHeader ? (
          <Text bold color={theme.primary}>
            {rowText}
          </Text>
        ) : (
          <Text>{rowText}</Text>
        )}
      </Text>,
    );
    if (ri === 0 && rows.length > 1) {
      outputLines.push(
        <Text key={`${keyPrefix}-mid`} color={theme.dimmed}>
          {midBorder}
        </Text>,
      );
    }
  }

  outputLines.push(
    <Text key={`${keyPrefix}-bot`} color={theme.dimmed}>
      {botBorder}
    </Text>,
  );

  return (
    <Box key={keyPrefix} flexDirection="column">
      {outputLines}
    </Box>
  );
}

// ─── Main Markdown Renderer ────────────────────────────────────

interface MarkdownRendererProps {
  text: string;
}

export default function MarkdownRenderer({ text }: MarkdownRendererProps): React.ReactElement {
  const { theme } = useTheme();
  const lines = text.split("\n");
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // ── Fenced code block: ```lang ... ``` ──
    const codeBlockStart = line.match(/^```(\w*)$/);
    if (codeBlockStart) {
      const lang = codeBlockStart[1] || "";
      const codeLines: string[] = [];
      i++;

      // Check if this is an incomplete/streaming code block (no closing ```)
      let closed = false;
      while (i < lines.length) {
        if (lines[i]!.match(/^```\s*$/)) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(lines[i]!);
        i++;
      }

      elements.push(
        <Box
          key={`block-${elements.length}`}
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.dimmed}
          paddingLeft={1}
          paddingRight={1}
          marginTop={0}
          marginBottom={0}
        >
          {lang && <Text color={theme.dimmed}>{lang}</Text>}
          <SyntaxHighlightedCode
            code={codeLines.join("\n")}
            lang={lang}
            theme={theme}
            keyPrefix={`code-${elements.length}`}
          />
        </Box>,
      );
      // If not closed, it is a streaming partial block — rendered as-is above
      continue;
    }

    // ── Horizontal rule: --- or ___ or *** ──
    if (/^([-_*])\1{2,}\s*$/.test(line)) {
      const termWidth = process.stdout.columns || 80;
      const ruleWidth = Math.min(termWidth - 4, 60);
      elements.push(
        <Text key={`line-${elements.length}`} color={theme.dimmed}>
          {"\u2500".repeat(ruleWidth)}
        </Text>,
      );
      i++;
      continue;
    }

    // ── Headers: # ## ### ──
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      const headerColors: Record<number, string> = {
        1: theme.primary,
        2: theme.primary,
        3: theme.accent,
        4: theme.accent,
        5: theme.secondary,
        6: theme.secondary,
      };
      elements.push(
        <Text key={`line-${elements.length}`} bold color={headerColors[level] ?? theme.primary}>
          {renderInline(headerMatch[2]!, `h-${elements.length}`, theme)}
        </Text>,
      );
      i++;
      continue;
    }

    // ── Blockquote: > text ──
    const blockquoteMatch = line.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      // Collect consecutive blockquote lines
      const bqLines: string[] = [blockquoteMatch[1]!];
      i++;
      while (i < lines.length) {
        const nextBq = lines[i]!.match(/^>\s?(.*)$/);
        if (nextBq) {
          bqLines.push(nextBq[1]!);
          i++;
        } else {
          break;
        }
      }
      elements.push(
        <Box key={`bq-${elements.length}`} paddingLeft={2} flexDirection="column">
          {bqLines.map((bql, bi) => (
            <Text key={`bq-${elements.length}-${bi}`} dimColor italic>
              {"\u2502 "}
              {renderInline(bql, `bqi-${elements.length}-${bi}`, theme)}
            </Text>
          ))}
        </Box>,
      );
      continue;
    }

    // ── Table: | col | col | ──
    if (/^\|.+\|/.test(line)) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && /^\|.+\|/.test(lines[i]!)) {
        tableLines.push(lines[i]!);
        i++;
      }
      elements.push(renderTable(tableLines, theme, `tbl-${elements.length}`));
      continue;
    }

    // ── Unordered list: - item or * item ──
    const listMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1] ?? "";
      elements.push(
        <Text key={`line-${elements.length}`}>
          {indent} {"\u2022 "}
          {renderInline(listMatch[2]!, `li-${elements.length}`, theme)}
        </Text>,
      );
      i++;
      continue;
    }

    // ── Numbered list: 1. item ──
    const numListMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (numListMatch) {
      const indent = numListMatch[1] ?? "";
      elements.push(
        <Text key={`line-${elements.length}`}>
          {indent} {numListMatch[2]!}.{" "}
          {renderInline(numListMatch[3]!, `nl-${elements.length}`, theme)}
        </Text>,
      );
      i++;
      continue;
    }

    // ── Regular line with inline formatting ──
    elements.push(
      <Box key={`line-${elements.length}`}>
        {renderInline(line, `p-${elements.length}`, theme)}
      </Box>,
    );
    i++;
  }

  return <Box flexDirection="column">{elements}</Box>;
}
