// KCode - Injection Patterns (SQL, command, SSRF, template, XXE)
//
// v2.10.314 — these are the highest-CVE-volume classes per OWASP Top 10
// and NVD data. The patterns intentionally trigger broadly; the LLM
// verifier's mitigation checklist filters to cases with untrusted input.

import type { BugPattern } from "../types";

export const INJECTION_PATTERNS: BugPattern[] = [
  // ── SQL injection via string concat ─────────────────────────────
  {
    id: "inj-001-sql-string-concat",
    title: "SQL query built via string concatenation with variables",
    severity: "critical",
    languages: [
      "python",
      "javascript",
      "typescript",
      "go",
      "java",
      "csharp",
      "php",
      "ruby",
      "rust",
    ],
    pack: "web",
    regex:
      /(?:execute|query|cursor\.execute|db\.query|connection\.query|Raw|exec_sql)\s*\(\s*[^,)]*\s*(?:\+|\|\||f['"`]|format\s*\(|%\s*\(?)\s*[^,)]+\)/g,
    explanation:
      "Concatenating user input into SQL queries is SQL injection. The canonical attack: login form with username `admin' OR 1=1 --` bypasses auth. CVE-2023-32707 and thousands of variants.",
    verify_prompt:
      "Check before confirming. FALSE_POSITIVE if ANY:\n1. Are the interpolated values compile-time CONSTANTS (table names from config, enum values)? → FALSE_POSITIVE\n2. Is the function signature taking only `int` / `bool` / validated IDs? → FALSE_POSITIVE\n3. Is this an ORM `Raw` call where the string is a query name, not content? → FALSE_POSITIVE\nOnly CONFIRMED when user-controllable strings (request params, form fields, URL path components) reach the query body.",
    cwe: "CWE-89",
    fix_template:
      "Use parameterized queries: `cursor.execute('SELECT * FROM u WHERE id = ?', (user_id,))` — NOT `f'... {user_id}'`.",
  },

  // ── Command injection via shell=True ────────────────────────────
  {
    id: "inj-002-subprocess-shell-true",
    title: "subprocess.run / Popen with shell=True and variable argument",
    severity: "critical",
    languages: ["python"],
    pack: "web",
    // Categorical: `subprocess.run(..., shell=True, ...)` is the
    // exact shape that turns any caller-controlled value into
    // shell injection. The regex requires `shell=True`, no
    // ambiguity. Tagged high_precision.
    maturity: "high_precision",
    regex:
      /\b(?:subprocess\.(?:run|Popen|call|check_output|check_call)|os\.system|os\.popen|commands\.getoutput)\s*\([^)]*shell\s*=\s*True[^)]*\)/g,
    explanation:
      "shell=True passes the string to /bin/sh — any `;`, `|`, `` ` ``, `$()` in the argument gets executed. Combined with user input, this is remote code execution. CVE-2019-19274, CVE-2020-13956, many others.",
    verify_prompt:
      "Is the command string built from a user-provided value? If the command is a static string with no variable interpolation, FALSE_POSITIVE. If any part comes from request.args / env var / file contents / argv[n], CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      "Pass args as a list: `subprocess.run(['git', 'clone', url])`. Don't use shell=True. If you must, sanitize via shlex.quote().",
  },

  // ── Command injection via os.system / eval-like ─────────────────
  {
    id: "inj-003-os-system-with-var",
    title: "os.system / os.popen / exec with concatenated user input",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "ruby", "php", "c", "cpp"],
    pack: "web",
    regex:
      /\b(?:os\.system|os\.popen|system|exec|popen|Runtime\.getRuntime\(\)\.exec|child_process\.exec|spawn)\s*\(\s*[^)]*(?:\+|\|\||f['"`]|format\s*\()\s*[^)]+\)/g,
    explanation:
      "Passing a concatenated command to system/exec/popen is command injection, same class as shell=True but without the flag. Every unescaped shell metacharacter is an RCE vector.",
    verify_prompt:
      "Is the command string built from user-controllable data? Respond CONFIRMED only if an external input (argv, request, env, file) reaches the command. If it's hardcoded constants, FALSE_POSITIVE.",
    cwe: "CWE-78",
    fix_template:
      "Use the list-argument form (execv, spawn with args array). For shells, escape with shlex.quote (Python) or shell-quote (Node).",
  },

  // ── SSRF via fetch of user-controlled URL ───────────────────────
  {
    id: "inj-004-ssrf-fetch",
    title: "HTTP fetch / urlopen of user-provided URL without allowlist",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "ruby"],
    pack: "web",
    regex:
      /\b(requests\.get|requests\.post|urllib\.request\.urlopen|urlopen|fetch|axios\.get|axios\.post|http\.get|http\.post|Http\.newCall|WebClient|HttpClient\.(?:Get|Post)Async)\s*\(\s*[^,)]*(?:request|params|body|user|input|query|url)\b/gi,
    explanation:
      "Server-Side Request Forgery: the server fetches a URL chosen by the attacker. Used to reach internal services (Redis, metadata endpoints like 169.254.169.254 on AWS, admin panels), bypassing network boundaries. Capital One 2019 breach = SSRF.",
    verify_prompt:
      "Is the URL argument user-controllable? If so, is there an allowlist check (host == allowed-list, or scheme restricted to https) BEFORE the fetch? Also check: is metadata endpoint (169.254.169.254, ::1, localhost, 127.0.0.0/8) blocked?\n- If allowlist present AND metadata blocked → FALSE_POSITIVE\n- If user input goes directly to fetch → CONFIRMED",
    cwe: "CWE-918",
    fix_template:
      "Add allowlist of permitted hosts. Block RFC1918 + loopback + cloud metadata endpoints. Resolve the hostname first and validate the IP, not just the input string.",
  },

  // ── Path traversal beyond filename check ────────────────────────
  {
    id: "inj-005-path-traversal",
    title: "File open on user-controlled path without realpath check",
    severity: "high",
    languages: [
      "python",
      "javascript",
      "typescript",
      "go",
      "java",
      "csharp",
      "php",
      "ruby",
      "c",
      "cpp",
    ],
    pack: "web",
    regex:
      /\b(open|fopen|readFile|File\.ReadAllText|File\.Open|os\.open|io\.open|Files\.readString|ioutil\.ReadFile)\s*\(\s*[^,)]*(?:request|params|body|user|input|query|args|argv|param)\b/gi,
    explanation:
      "Opening a file whose path is derived from user input allows path traversal (`../../../etc/passwd`). Even `basename()` isn't enough — symlinks in the target directory can redirect.",
    verify_prompt:
      "Does the code call `realpath()` / `path.resolve()` / `Path.normalize()` AND verify the result starts with an expected base directory? If yes, FALSE_POSITIVE. If just `basename` or a blacklist of `..` exists, CONFIRMED — those bypass via Unicode, symlinks, or double-encoding.",
    cwe: "CWE-22",
    fix_template:
      "Resolve to absolute path, verify it's within an expected base dir. Example: `abs = os.path.realpath(os.path.join(base, filename)); if not abs.startswith(base + os.sep): reject`.",
  },

  // ── NoSQL injection (MongoDB $where) ────────────────────────────
  {
    id: "inj-006-nosql-where",
    title: "MongoDB $where clause with user input",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp"],
    pack: "web",
    regex: /\$where\s*[:=]\s*(?:function\s*\(|\(?.*?\)?\s*=>|['"`].*?\$\{|f['"`].*?\{|`[^`]*\$\{)/g,
    explanation:
      "MongoDB's `$where` operator runs arbitrary JavaScript on the server. Combined with user input, it's equivalent to eval on the database. Similar: `$function`, `mapReduce` with user-provided JS.",
    verify_prompt:
      "Is the $where expression built from user-controllable data, or is it a static string? If static (e.g. `{$where: 'this.a > this.b'}` with no interpolation), FALSE_POSITIVE. Any interpolation → CONFIRMED.",
    cwe: "CWE-943",
    fix_template:
      "Use standard query operators ($eq, $gt, $in, $regex with escape) instead of $where. Never interpolate user input into JS code strings.",
  },

  // ── LDAP injection ──────────────────────────────────────────────
  {
    id: "inj-007-ldap-filter-concat",
    title: "LDAP filter built via string concatenation with user input",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php"],
    pack: "web",
    regex:
      /\b(search|searchEntries|search_s|ldap\.search|DirectoryEntry|DirSearcher)\s*\([^)]*(?:\(uid=|\(cn=|\(mail=|\(sAMAccountName=)[^)]*(?:\+|\{|%s|%\()/g,
    explanation:
      "LDAP filters like `(uid=${username})` with unescaped user input allow injection of logical operators `*`, `)`, `|`, which bypass authentication or extract attributes.",
    verify_prompt:
      "Does the code escape LDAP special characters (`* ( ) \\ / NUL`) in user input before building the filter? If yes, FALSE_POSITIVE.",
    cwe: "CWE-90",
    fix_template:
      "Escape LDAP metacharacters: python-ldap's `ldap.filter.escape_filter_chars`, Node's `ldap-escape`, Java's `Rdn.escapeValue`.",
  },

  // ── XXE (XML external entity) ───────────────────────────────────
  {
    id: "inj-008-xxe-default-parser",
    title: "XML parser configured with external entities enabled",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php"],
    pack: "web",
    regex:
      /\b(DocumentBuilderFactory|SAXParserFactory|XMLReader|xml\.etree\.ElementTree\.parse|xml\.sax\.parse|lxml\.etree\.parse|libxml_disable_entity_loader\s*\(\s*false\s*\))\b/g,
    explanation:
      "XXE: default XML parsers in Java (pre-2014), PHP, some .NET configs load external entities. Attacker submits `<!ENTITY x SYSTEM 'file:///etc/passwd'>` and the parser returns the file contents. CVE-2019-12384 (jackson-databind), CVE-2019-6249.",
    verify_prompt:
      "Does the code explicitly disable external entities / DTDs BEFORE parsing? (setFeature('http://apache.org/xml/features/disallow-doctype-decl', true), resolve_entities=False, XMLConstants.FEATURE_SECURE_PROCESSING.)\n- If disabled, FALSE_POSITIVE.\n- If the default is used (and defaults are unsafe for this library/version), CONFIRMED.",
    cwe: "CWE-611",
    fix_template:
      "Java: factory.setFeature('http://apache.org/xml/features/disallow-doctype-decl', true). Python: use defusedxml package.",
  },

  // ── Template injection (SSTI) ───────────────────────────────────
  {
    id: "inj-009-ssti-render-string",
    title: "Template engine renders a string that contains user input",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "java", "ruby", "php"],
    pack: "web",
    regex:
      /\b(render_template_string|Template\s*\(\s*(?:request|params|body)|Jinja2\.Environment[^(]*\(\s*[^)]*\)\.from_string\s*\([^)]*(?:request|params|user)|new\s+Function\s*\([^)]*(?:request|params|user))\b/g,
    explanation:
      "Passing user input as the TEMPLATE (not as a variable) lets an attacker execute template directives — Jinja2's `{{config.__class__}}` chain gives RCE. CVE-2019-8341 (Jinja2), CVE-2020-35476 (Flask).",
    verify_prompt:
      "Is the user input being rendered AS a template (first argument to render_template_string / Template constructor)? Or is it being PASSED TO an existing static template as a variable (second arg)? Only CONFIRMED if user input is the template string itself.",
    cwe: "CWE-1336",
    fix_template:
      "Render a fixed template and pass user input as context vars: `render_template('page.html', user_name=request.form['name'])`.",
  },

  // ── Open redirect ───────────────────────────────────────────────
  {
    id: "inj-010-open-redirect",
    title: "Redirect to URL taken from query parameter without allowlist",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "ruby"],
    pack: "web",
    regex:
      /\b(redirect|Redirect|res\.redirect|response\.redirect|sendRedirect|HttpRedirect)\s*\(\s*(?:request\.(?:args|query|params|GET)|req\.query|params\[['"]redirect|\$_GET\[['"]redirect)[^)]*\)/gi,
    explanation:
      "Open redirect lets an attacker craft a link to your domain that redirects to evil.com. Used in phishing + OAuth token theft.",
    verify_prompt:
      "Does the code validate the redirect target against an allowlist of hosts (or is it always a relative path)? If allowlist check present or target is `/relative/only`, FALSE_POSITIVE.",
    cwe: "CWE-601",
    fix_template:
      "Restrict to relative URLs (startswith('/') && not '//'), or check host against a fixed allowlist of permitted domains.",
  },

  // ── ReDoS (catastrophic regex backtracking) ─────────────────────
  {
    id: "inj-011-redos-pattern",
    title: "Regex with catastrophic backtracking on user input",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "ruby"],
    pack: "web",
    regex:
      /(?:re\.match|re\.search|re\.findall|\.test\s*\(|\.match\s*\(|Regex\.Match|Pattern\.compile)\s*\([^)]*['"`][^'"`]*(?:\(\.\*\)[+*]|\(\.\+\)[+*]|\([a-z0-9.*+?|[\]^$]+\)[+*][+*]|\([^)]*\|[^)]*\)\+)[^)]*/gi,
    explanation:
      "Regexes with nested quantifiers like `(a+)+`, `(a|a)+`, `.*.*` exhibit catastrophic backtracking on pathological inputs — seconds to minutes to match a short string, causing DoS. CVE-2019-5413 (ms package), CVE-2020-7598 (minimist).",
    verify_prompt:
      "Is this regex applied to user-supplied input, or only to internal / constant strings? If applied only to server-controlled values, FALSE_POSITIVE. If user input → CONFIRMED. Also note whether the regex engine is RE2-based (Go's default) — RE2 has no backtracking, so FALSE_POSITIVE.",
    cwe: "CWE-1333",
    fix_template:
      "Rewrite to avoid nested quantifiers. Prefer RE2 / Go's regexp. Set a match timeout (Java `.match(timeout=...)`, Node `re2` package).",
  },

  // ── Prototype pollution (JS) ────────────────────────────────────
  {
    id: "inj-012-proto-pollution",
    title: "Object merge / assign from user input without __proto__ guard",
    severity: "high",
    languages: ["javascript", "typescript"],
    pack: "web",
    regex:
      /\b(Object\.assign|_\.merge|_\.defaultsDeep|jQuery\.extend\s*\(\s*true|lodash\.merge|\.\.\.(?:request\.(?:body|query|params)))\b/g,
    explanation:
      "Merging a user-provided object into a target without filtering `__proto__` or `constructor.prototype` keys pollutes Object.prototype globally, leading to RCE in subsequent code paths. Jest, Mongoose, Kibana all had this class of CVE.",
    verify_prompt:
      "Is the source object user-controllable AND the merge either recursive (deep) OR on a trusted target like `req.app.locals`? If the merge rejects / strips `__proto__`, `constructor`, `prototype` keys before merging, FALSE_POSITIVE.",
    cwe: "CWE-1321",
    fix_template:
      "Use `Object.create(null)` for the target, or deny-list `__proto__`/`constructor`/`prototype` keys. Prefer immutable merge (`{ ...a, ...b }` is shallow-safe).",
  },

  // ── Mass assignment ─────────────────────────────────────────────
  {
    id: "inj-013-mass-assignment",
    title: "Model save / update with raw request body",
    severity: "high",
    languages: ["python", "javascript", "typescript", "java", "ruby", "php"],
    pack: "web",
    regex:
      /\b(User\(|User\.create|User\.update|Model\(|save\s*\(\s*request\.(?:body|args|params)|update\s*\(\s*request\.(?:body|args|params)|Object\.assign\s*\(\s*user\s*,\s*req\.body)\b/g,
    explanation:
      "Assigning the entire request body to a model lets an attacker set fields like `is_admin=true`, `role='admin'`, `balance=99999` if the model has those columns. Rails mass-assignment CVEs, Parse Platform CVE-2022-24773.",
    verify_prompt:
      "Does the assignment use a FIELD ALLOWLIST (`pick`, `permit`, schema validator that strips unknown keys)? If yes, FALSE_POSITIVE. If the raw body is assigned, CONFIRMED — and the model must not contain privileged fields.",
    cwe: "CWE-915",
    fix_template:
      "Use field allowlists: Rails `params.permit(:name, :email)`, Pydantic schema validation with `extra='forbid'`, manual field-by-field assignment.",
  },

  // ── HTTP response splitting ─────────────────────────────────────
  {
    id: "inj-014-response-splitting",
    title: "HTTP header / cookie set with unescaped user input",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "ruby"],
    pack: "web",
    regex:
      /\b(set_header|setHeader|setCookie|set_cookie|addHeader|response\.headers\[)\s*\([^)]*(?:request|params|body|user|input)\b/gi,
    explanation:
      "Writing unvalidated user input into a response header allows CRLF injection — attacker embeds `\\r\\n` to terminate the header and inject a new one (or inject an entire second HTTP response). Modern web servers filter CRLF, but not always.",
    verify_prompt:
      "Does the framework automatically strip CRLF from header values (Node 16+, Go net/http, recent Java Servlet)? If yes (and the code doesn't set the header via a raw socket), FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-113",
    fix_template:
      "Strip `\\r` and `\\n` from any user value before passing it to a header setter. Prefer framework-level header APIs over raw string writes.",
  },

  // ── Zip slip / archive extraction ───────────────────────────────
  {
    id: "inj-015-zipslip",
    title: "Archive extraction without checking entry path (Zip Slip)",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "ruby"],
    pack: "web",
    regex:
      /\b(zipfile\.ZipFile[^.]*\.extractall|tarfile\.open[^.]*\.extractall|ZipInputStream|ZipEntry|TarArchiveEntry|AdmZip\.extractAllTo|yauzl\.open[^.]*\.(?:readEntry|on)|extract\s*\(\s*[^,)]+)/g,
    explanation:
      "`extractall()` without per-entry path validation lets an attacker embed entries like `../../../etc/passwd` or `../etc/cron.d/backdoor` that escape the destination directory. Zip Slip = CVE-2018-1002200 and many variants.",
    verify_prompt:
      "Does the code iterate entries and verify each entry's resolved path stays within the target directory BEFORE extracting? If yes, FALSE_POSITIVE. If it uses the convenience `extractall()` / `extractAllTo()` without validation, CONFIRMED.",
    cwe: "CWE-22",
    fix_template:
      "Iterate entries manually; for each, compute `abs = realpath(join(dest, entry.name))` and verify `abs.startswith(realpath(dest) + sep)` before extracting.",
  },
];
