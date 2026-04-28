// KCode - PYTHON Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const PYTHON_PATTERNS: BugPattern[] = [
  {
    id: "py-001-eval-exec",
    title: "eval()/exec() with potentially untrusted input",
    severity: "critical",
    languages: ["python"],
    regex: /\b(eval|exec)\s*\(/g,
    explanation:
      "eval() and exec() execute arbitrary Python code. If the argument contains any user/external input, this is a remote code execution vulnerability.",
    verify_prompt:
      "Is the argument to eval()/exec() derived from external/untrusted input? " +
      "Respond CONFIRMED only if the argument includes user request params, " +
      "HTTP body, query strings, websocket messages, or database values that " +
      "originate from users. " +
      "Respond FALSE_POSITIVE for ALL of the following safe patterns: " +
      "(1) exec(open('hardcoded/local/path.py').read()) — simulation framework " +
      "convention (NASA Trick, Matlab, etc.) for including local config scripts; " +
      "(2) eval() or exec() on a hardcoded string literal; " +
      "(3) exec() in test harness, conftest.py, or fixture setup; " +
      "(4) eval() in CLI/REPL tools that intentionally run user expressions " +
      "in a sandbox (e.g., IPython, Jupyter, debugger); " +
      "(5) exec(compile(...)) patterns from code-generation or template engines " +
      "where the source is an internal template, not user input; " +
      "(6) eval/exec in migration scripts, build scripts, or setup.py; " +
      "(7) exec() where the file path being opened is a relative hardcoded " +
      "string constant (not computed from variables or user input). " +
      "The key question: does an ATTACKER control the string being eval'd/exec'd? " +
      "If the string comes entirely from files the developer controls, it's safe.",
    cwe: "CWE-95",
    fix_template: "Replace eval() with ast.literal_eval() for data, or remove entirely.",
  },
  {
    id: "py-002-shell-injection",
    title: "Shell command execution with potential injection",
    severity: "critical",
    languages: ["python"],
    // Categorical: subprocess.run / Popen / os.system / os.popen
    // with an f-string, format() call, or `+` concat is unconditional
    // shell injection — there's no "safe with shell=True + dynamic
    // content" path. Tagged high_precision because the regex
    // requires an explicit dynamic-string shape.
    maturity: "high_precision",
    // `(?<!["'\w])f["']` requires the `f` to NOT be preceded by a
    // quote or word character — so literal strings like "-rf",
    // "rm -rf", or "f" (single-letter string literal) don't
    // accidentally match the f-string prefix check. Found by the
    // Phase 3 fixture harness. Legit f-strings always start after
    // whitespace, paren, comma, equals, etc. — never after a
    // quote or another letter.
    regex:
      /\b(?:os\.system|os\.popen|subprocess\.call|subprocess\.run|subprocess\.Popen)\s*\([^)]*(?:shell\s*=\s*True|(?<!["'\w])f["']|\.format\(|%\s)/g,
    explanation:
      "Running shell commands with shell=True, f-strings, .format(), or % interpolation allows command injection if any part of the command comes from external input.",
    verify_prompt:
      "Does this shell command include ANY external/user input (request params, " +
      "filenames from user, config values)? If the entire command is a hardcoded " +
      "constant, respond FALSE_POSITIVE. If any variable is interpolated, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use subprocess.run([...], shell=False) with list of args instead of string.",
  },
  {
    id: "py-003-pickle-deserialize",
    title: "Unsafe deserialization (pickle/marshal/shelve)",
    severity: "critical",
    languages: ["python"],
    pack: "ai-ml",
    regex: /\b(?:pickle\.loads?|marshal\.loads?|shelve\.open)\s*\(/g,
    explanation:
      "pickle.load() deserializes arbitrary Python objects. An attacker can craft a pickle payload that executes arbitrary code on load. Never unpickle untrusted data.",
    verify_prompt:
      "Is the data being unpickled from a TRUSTED source (e.g., local file written " +
      "by the same app, internal cache)? Or could it come from an untrusted source " +
      "(network, user upload, shared storage)? CONFIRMED if untrusted, FALSE_POSITIVE if trusted.",
    cwe: "CWE-502",
    fix_template: "Use json.loads() or a safe serialization format instead of pickle.",
  },
  {
    id: "py-004-sql-injection",
    title: "SQL query with string formatting (injection risk)",
    severity: "high",
    languages: ["python"],
    // `%\s` (not bare `%`) so `"... %s"` / `"... %d"` / `"... %i"`
    // parameterized-query placeholders don't accidentally match as
    // if they were `%`-format operators. The Python `%`-format
    // operator is always written with a space (`"x" % var`) or
    // with a paren (`"x" %(dict)s`); never adjacent to the format
    // specifier letter. Found by the Phase 3 fixture harness
    // (tests/patterns/py-004-sql-injection/negative-pct-placeholder.py).
    regex: /\b(?:execute|executemany|raw)\s*\(\s*(?:f["']|["'].*%[\s(]|["'].*\.format\()/g,
    explanation:
      "SQL queries built with f-strings, % formatting, or .format() are vulnerable to SQL injection. Use parameterized queries instead.",
    verify_prompt:
      "Is this SQL query using string interpolation with ANY external input? " +
      "If the query is entirely hardcoded or uses parameterized placeholders (%s, ?), " +
      "respond FALSE_POSITIVE. If user input is interpolated, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template:
      "Use parameterized queries: cursor.execute('SELECT * FROM t WHERE id = %s', (user_id,))",
  },
  {
    id: "py-005-yaml-unsafe-load",
    title: "yaml.load() without safe Loader (code execution)",
    severity: "high",
    languages: ["python"],
    // Categorical: yaml.load() without an explicit SafeLoader is
    // wrong every time — PyYAML's default constructor enables Python
    // object instantiation. The regex's negative lookahead for
    // `Loader` ensures we only match the unsafe form.
    maturity: "high_precision",
    regex: /\byaml\.load\s*\([^)]*(?!\bLoader\b)/g,
    explanation:
      "yaml.load() without Loader=yaml.SafeLoader can execute arbitrary Python code embedded in YAML. Always use yaml.safe_load() or specify SafeLoader.",
    verify_prompt:
      "Does this yaml.load() call specify Loader=yaml.SafeLoader or Loader=yaml.FullLoader? " +
      "If no Loader is specified, respond CONFIRMED. If SafeLoader is used, respond FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template: "Replace yaml.load(data) with yaml.safe_load(data).",
  },
  {
    id: "py-006-hardcoded-secret",
    title: "Hardcoded password, secret, or API key",
    severity: "high",
    languages: ["python", "javascript", "typescript"],
    // Categorical: hardcoded credentials in source are wrong
    // every time. verify_prompt filters obvious placeholders.
    maturity: "high_precision",
    regex: /(?:password|secret|api_key|apikey|token|auth)\s*=\s*["'][^"']{8,}["']/gi,
    explanation:
      "Hardcoded secrets in source code are exposed to anyone with repo access. Use environment variables or a secrets manager.",
    verify_prompt:
      "Is this a REAL secret/password (not a placeholder like 'changeme', not a " +
      "test fixture, not a variable name)? If it looks like a real credential, " +
      "respond CONFIRMED. If it's a placeholder, test value, or example, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Move to environment variable: os.environ.get('SECRET_KEY')",
  },
  {
    id: "py-007-assert-security",
    title: "assert used for security check (stripped in optimized mode)",
    severity: "medium",
    languages: ["python"],
    regex: /\bassert\s+.*(?:auth|permission|allowed|admin|role|access|token|password|secret)/gi,
    explanation:
      "Python assert statements are removed when running with -O (optimized mode). Using assert for security checks means the check disappears in production.",
    verify_prompt:
      "Is this assert checking a security-relevant condition (authentication, " +
      "authorization, permissions)? If it's just a development/debug assertion, " +
      "respond FALSE_POSITIVE. If it guards a security boundary, respond CONFIRMED.",
    cwe: "CWE-617",
    fix_template: "Replace assert with: if not condition: raise PermissionError(...)",
  },
  {
    id: "py-008-path-traversal",
    title: "File open with user-controlled path (path traversal)",
    severity: "high",
    languages: ["python"],
    regex: /\bopen\s*\(\s*(?:f["']|.*\+.*|.*\.format\(|.*%\s)/g,
    explanation:
      "Opening files with paths constructed from user input allows path traversal (../../etc/passwd). Always validate and sanitize file paths.",
    verify_prompt:
      "Is the file path constructed from ANY external/user input? If the path " +
      "is entirely hardcoded or from trusted config, respond FALSE_POSITIVE. " +
      "If user input influences the path, respond CONFIRMED.",
    cwe: "CWE-22",
    fix_template: "Use os.path.abspath() + check it starts with expected base directory.",
  },
  {
    id: "py-009-pickle-untrusted",
    title: "pickle.load() on untrusted data (arbitrary code execution)",
    severity: "critical",
    languages: ["python"],
    pack: "ai-ml",
    regex: /\bpickle\.loads?\s*\(\s*(?:request|data|payload|body|content|recv|read|input)/g,
    explanation:
      "pickle.load() on data from network, user upload, or any untrusted source allows arbitrary code execution. An attacker can craft a pickle payload that runs shell commands on deserialization.",
    verify_prompt:
      "Is the data passed to pickle.load() from an UNTRUSTED source (network, " +
      "user upload, API response, shared storage)? If the pickle data is from a " +
      "local file written only by the same application, respond FALSE_POSITIVE. " +
      "If from any external source, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template:
      "Use json.loads() or a safe serialization format. If pickle is required, use hmac-signed pickles with a secret key.",
  },
  {
    id: "py-010-assert-validation",
    title: "assert used for input validation (stripped in -O mode)",
    severity: "medium",
    languages: ["python"],
    regex:
      /\bassert\s+(?:isinstance|len|type|int|str|float|0\s*<|0\s*<=|\w+\s*(?:>|<|>=|<=|!=|==)\s*\d)/g,
    explanation:
      "assert statements are removed when Python runs with -O (optimized) or -OO flags. Using assert for input validation means the check disappears in production.",
    verify_prompt:
      "Is this assert validating external input or function arguments that could " +
      "be wrong at runtime? If it's a debug-only invariant that documents assumptions " +
      "and is never exposed to external data, respond FALSE_POSITIVE. If it guards " +
      "against bad input, respond CONFIRMED.",
    cwe: "CWE-617",
    fix_template: "Replace assert with: if not condition: raise ValueError('...')",
  },
  {
    id: "py-011-eq-without-hash",
    title: "__eq__ defined without __hash__ (breaks sets/dicts)",
    severity: "medium",
    languages: ["python"],
    regex: /def\s+__eq__\s*\(\s*self[\s\S]{0,500}?(?!def\s+__hash__)/g,
    explanation:
      "Defining __eq__ without __hash__ makes the class unhashable in Python 3. Objects cannot be used in sets or as dict keys, and may cause subtle bugs if inherited __hash__ produces inconsistent results.",
    verify_prompt:
      "Does this class define __eq__ but NOT __hash__? Check the full class body. " +
      "If __hash__ is defined elsewhere in the class, respond FALSE_POSITIVE. " +
      "If the class is intentionally unhashable (e.g. mutable container), respond " +
      "FALSE_POSITIVE. If __hash__ is missing and the object may be used in sets/dicts, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template:
      "Add __hash__ that returns hash of the same fields used in __eq__, or set __hash__ = None explicitly.",
  },
  {
    id: "py-012-mutable-default-arg",
    title: "Mutable default argument (shared between calls)",
    severity: "medium",
    languages: ["python"],
    regex:
      /def\s+\w+\s*\([^)]*(?::\s*(?:list|dict|set)\s*=\s*(?:\[\]|\{\}|set\(\))|=\s*(?:\[\]|\{\}))/g,
    explanation:
      "Mutable default arguments (def foo(x=[])) are created once and shared across all calls. Appending to them accumulates state between invocations, causing hard-to-debug issues.",
    verify_prompt:
      "Is this default argument a mutable object (list, dict, set) that gets modified " +
      "inside the function? If the function never mutates the default (only reads), " +
      "respond FALSE_POSITIVE. If it appends/modifies the default, respond CONFIRMED.",
    cwe: "CWE-665",
    fix_template:
      "Use None as default and create inside: def foo(x=None): x = x if x is not None else []",
  },
  {
    id: "py-013-bare-except",
    title: "Bare except: catches SystemExit and KeyboardInterrupt",
    severity: "medium",
    languages: ["python"],
    regex: /\bexcept\s*:/g,
    explanation:
      "A bare except: clause catches ALL exceptions including SystemExit (sys.exit()), KeyboardInterrupt (Ctrl+C), and GeneratorExit. This can prevent clean shutdown and make the program unkillable.",
    verify_prompt:
      "Is this a bare except: (no exception type specified)? If it catches a specific " +
      "exception type like except Exception: or except ValueError:, respond FALSE_POSITIVE. " +
      "If it's truly bare except:, respond CONFIRMED.",
    cwe: "CWE-396",
    fix_template:
      "Replace except: with except Exception: to allow SystemExit and KeyboardInterrupt to propagate.",
  },
  {
    id: "py-014-late-binding-closure",
    title: "Late binding closure in loop (captures variable reference)",
    severity: "medium",
    languages: ["python"],
    regex: /for\s+(\w+)\s+in\s+[\s\S]{0,100}?(?:lambda\s*[^:]*:\s*\1\b|lambda\s*:\s*\1\b)/g,
    explanation:
      "Closures in Python capture variables by reference, not value. A lambda defined inside a loop that references the loop variable will use the FINAL value of that variable when called, not the value at the time of definition.",
    verify_prompt:
      "Does the lambda/closure reference a loop variable without binding it as a " +
      "default argument? If the variable is bound via default arg (lambda x=x: ...), " +
      "respond FALSE_POSITIVE. If it references the loop variable directly, respond CONFIRMED.",
    cwe: "CWE-758",
    fix_template: "Bind via default arg: lambda i=i: i, or use functools.partial().",
  },
  {
    id: "py-015-os-system-user-input",
    title: "os.system() with user-controlled input",
    severity: "critical",
    languages: ["python"],
    regex: /\bos\.system\s*\(\s*(?:f["']|.*\+|.*\.format\(|.*%\s)/g,
    explanation:
      "os.system() runs commands through the shell. If any part of the command string comes from user input, this is a command injection vulnerability.",
    verify_prompt:
      "Does the command string include ANY external/user input? If the entire command " +
      "is a hardcoded constant with no interpolation, respond FALSE_POSITIVE. " +
      "If any variable is interpolated, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use subprocess.run([...], shell=False) with a list of arguments.",
  },
  {
    id: "py-016-tempfile-mktemp",
    title: "tempfile.mktemp() race condition (use mkstemp)",
    severity: "medium",
    languages: ["python"],
    regex: /\btempfile\.mktemp\s*\(/g,
    explanation:
      "tempfile.mktemp() returns a filename but does not create it, creating a TOCTOU race condition. An attacker can create a symlink at that path between mktemp() and open(), leading to symlink attacks.",
    verify_prompt:
      "Is this code using tempfile.mktemp() to generate a temporary filename? " +
      "If it uses mkstemp(), NamedTemporaryFile, or TemporaryDirectory instead, " +
      "respond FALSE_POSITIVE. If mktemp(), respond CONFIRMED.",
    cwe: "CWE-377",
    fix_template:
      "Use tempfile.mkstemp() (returns fd+name atomically) or tempfile.NamedTemporaryFile().",
  },
  {
    id: "py-017-hardcoded-secret-assign",
    title: "Hardcoded secret or API key in assignment",
    severity: "high",
    languages: ["python"],
    // Categorical: hardcoded credentials in source are wrong
    // every time. The base64-shaped value in the regex makes
    // false positives even rarer (placeholders rarely match
    // 12+ char base64-style strings).
    maturity: "high_precision",
    regex:
      /(?:api_key|api_secret|aws_secret|private_key|database_password|db_password)\s*=\s*["'][A-Za-z0-9+/=_-]{12,}["']/gi,
    explanation:
      "Hardcoded secrets in source code are exposed to anyone with repository access and persist in git history even after deletion.",
    verify_prompt:
      "Is this a REAL secret or a placeholder (e.g. 'your-key-here', 'changeme', " +
      "'xxx', 'test')? If it looks like a real credential (long, random string), " +
      "respond CONFIRMED. If placeholder or test, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template:
      "Use os.environ.get('API_KEY') or a secrets manager (AWS Secrets Manager, Vault).",
  },
  {
    id: "py-018-re-no-raw-string",
    title: "re.compile/re.match without raw string (backslash issues)",
    severity: "low",
    languages: ["python"],
    regex: /\bre\.(?:compile|match|search|findall|sub)\s*\(\s*"(?:[^"]*\\[dDwWsSbB])/g,
    explanation:
      "Using regular strings instead of raw strings (r'...') with regex causes backslash escaping confusion. Python processes \\d as an escape sequence before re sees it. Use r'\\d' instead of '\\\\d'.",
    verify_prompt:
      "Is this regex using a regular string (not r'...') with backslash sequences " +
      "like \\d, \\w, \\s? If it uses a raw string r'...', respond FALSE_POSITIVE. " +
      "If the backslashes are doubled correctly (\\\\d), respond FALSE_POSITIVE. " +
      "If single backslashes in a non-raw string, respond CONFIRMED.",
    cwe: "CWE-185",
    fix_template: "Use raw strings: re.compile(r'\\d+') instead of re.compile('\\\\d+')",
  },
  {
    id: "py-019-fstring-logging",
    title: "f-string in logging call (always evaluates)",
    severity: "low",
    languages: ["python"],
    regex: /\blogger\.(?:debug|info|warning|error|critical)\s*\(\s*f["']/g,
    explanation:
      "Using f-strings in logging always evaluates the string even if the log level is disabled. This wastes CPU on string formatting and can cause errors if the interpolated values are expensive or have side effects. Use lazy % formatting.",
    verify_prompt:
      "Is this a logging call using an f-string? If the string is simple and cheap, " +
      "respond FALSE_POSITIVE. If it involves expensive computation (database queries, " +
      "serialization, repr of large objects), respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template:
      "Use lazy formatting: logger.debug('Value: %s', expensive_value) instead of logger.debug(f'Value: {expensive_value}')",
  },
  {
    id: "py-020-global-keyword",
    title: "global keyword usage (code smell, shared mutable state)",
    severity: "low",
    languages: ["python"],
    regex: /^\s*global\s+\w+/gm,
    explanation:
      "The global keyword creates shared mutable state that makes code harder to test, reason about, and maintain. It can cause subtle bugs in multi-threaded code and makes dependency injection impossible.",
    verify_prompt:
      "Is this global used for a legitimate module-level state pattern? " +
      "Respond FALSE_POSITIVE for any of: " +
      "(1) module-level logger, (2) configuration / settings cache, " +
      "(3) singleton lazy-init (e.g., `_instance`, `_client`, `_pool`), " +
      "(4) circuit breaker state (`_circuit_open_until`, `_failure_count`, `_last_failure`), " +
      "(5) rate limiter / token bucket state, " +
      "(6) connection pool / HTTP session reuse, " +
      "(7) feature flag cache or hot-reloaded config, " +
      "(8) memoization / LRU cache implementation, " +
      "(9) test fixtures or pytest monkeypatch setup. " +
      "These are all well-known Python patterns where module-level state is idiomatic. " +
      "Only respond CONFIRMED if the global is used to pass arbitrary state between " +
      "unrelated functions in a way that suggests the code should have been a class.",
    cwe: "CWE-1054",
    fix_template:
      "Pass the value as a function parameter, use a class to encapsulate state, or use a module-level constant.",
  },

  // ── ML library deserialization (torch / joblib / cloudpickle) ──
  // v2.10.332 — Phase A web/ML expansion.
  {
    id: "py-021-torch-load-untrusted",
    title: "torch.load / joblib.load on untrusted bytes (pickle under the hood)",
    severity: "critical",
    languages: ["python"],
    pack: "ai-ml",
    regex:
      /\b(?:torch\.load|joblib\.load|tf\.keras\.models\.load_model|skops\.io\.load)\s*\([^)]*(?:request|params|body|user|input|args|argv|file|path|url|download)\b/gi,
    explanation:
      "torch.load and joblib.load both use Python pickle internally. Passing an attacker-controllable file (a downloaded model, a user-uploaded checkpoint, a path stored in a request) is full RCE — the pickle's __reduce__ method runs at load time. PyTorch issued a security advisory recommending weights_only=True (default in 2.6+) precisely for this class.",
    verify_prompt:
      "Is the file path / bytes argument user-controllable in this code path? Check for:\n" +
      "1. Hardcoded path to a model file shipped with the project → FALSE_POSITIVE.\n" +
      "2. torch.load(..., weights_only=True) or map_location with explicit type filter → FALSE_POSITIVE.\n" +
      "3. The path comes from an env var or config that the operator controls (not a request) → FALSE_POSITIVE.\n" +
      "4. The blob is HMAC-verified before loading → FALSE_POSITIVE.\n" +
      "Only CONFIRMED when the bytes / path could reach the call from an external boundary (HTTP request, file upload, message queue, etc.).",
    cwe: "CWE-502",
    fix_template:
      "PyTorch: torch.load(..., weights_only=True). joblib: validate the source, sign the artifact (hmac), or load into a sandboxed subprocess.",
  },
];
