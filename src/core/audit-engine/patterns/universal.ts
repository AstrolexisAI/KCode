// KCode - UNIVERSAL Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const UNIVERSAL_PATTERNS: BugPattern[] = [
  // Shell
  {
    id: "sh-001-eval-injection",
    title: "eval with variable expansion in shell script",
    severity: "critical",
    languages: ["shell"],
    regex: /\beval\s+["']?\$[\{(]/g,
    explanation: "eval with variable expansion in shell enables command injection.",
    verify_prompt: "Is the variable from trusted internal source or user input? CONFIRMED if user-controlled." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The variable is set from a trusted internal source (hardcoded config, internal script logic)\n" +
      "2. The variable is validated/sanitized before reaching eval\n" +
      "3. This is in a build script or CI/CD pipeline with controlled inputs\n" +
      "4. The eval operates on a compile-time constant or environment variable set by the system\n" +
      "Only respond CONFIRMED if user-controlled or external input can reach the eval through the variable.",
    cwe: "CWE-78",
    fix_template: "Avoid eval in shell. Use direct execution or arrays for args.",
  },
  // Hardcoded IPs / URLs
  {
    id: "uni-001-hardcoded-ip",
    title: "Hardcoded IP address or internal URL",
    severity: "low",
    languages: ["python", "javascript", "typescript", "go", "java", "c", "cpp", "rust"],
    regex: /["']\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?["']/g,
    explanation: "Hardcoded IP addresses make the code environment-dependent and may expose internal infrastructure.",
    verify_prompt: "Is this IP 127.0.0.1/localhost or 0.0.0.0 (standard)? If standard loopback, respond FALSE_POSITIVE. If it's a specific internal/production IP, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "Move to configuration file or environment variable.",
  },
  // TODO/FIXME security markers
  {
    id: "uni-002-security-todo",
    title: "Security-related TODO/FIXME/HACK comment",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "go", "java", "c", "cpp", "rust"],
    regex: /(?:TODO|FIXME|HACK|XXX).*(?:security|auth|password|token|secret|vuln|inject|sanitiz|escap)/gi,
    explanation: "A developer left a security-related TODO. This may indicate a known vulnerability that was deferred.",
    verify_prompt: "Is this TODO about a real security concern that hasn't been addressed? If it's already fixed (comment is stale), respond FALSE_POSITIVE.",
    cwe: "CWE-1035",
    fix_template: "Address the security concern or remove the stale comment.",
  },

  // ── CWE Top 25 gap closers ───────────────────────────────────
  // The following patterns close the 8 CWEs from the 2024 CWE Top 25
  // that the audit engine was missing.

  // CWE-918: Server-Side Request Forgery (SSRF)
  {
    id: "uni-003-ssrf",
    title: "User input flows into HTTP request URL (SSRF)",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php"],
    regex: /(?:requests\.(?:get|post|put|delete|patch|head)\s*\(\s*(?:f["']|[a-z_]+\s*\+|[a-z_]+\.format)|fetch\s*\(\s*(?:[a-z_]+\s*\+|`\$\{)|http\.(?:Get|Post|Do)\s*\(\s*[a-z_]|HttpClient\..*\(\s*[a-z_]|open-uri|URI\.parse\s*\(\s*(?:params|request|args))/g,
    explanation:
      "When user-controlled input is used as a URL in server-side HTTP requests, " +
      "an attacker can make the server request internal resources (metadata endpoints, " +
      "internal APIs, cloud provider credentials at 169.254.169.254).",
    verify_prompt:
      "Does the URL or any part of it (host, path, query) come from user input " +
      "(request params, headers, body, database values from users)? " +
      "Respond FALSE_POSITIVE if: the URL is fully hardcoded, comes from a " +
      "trusted config file, or is validated against an allowlist of hosts. " +
      "Respond CONFIRMED if user input can influence the request destination.",
    cwe: "CWE-918",
    fix_template: "Validate the URL against an allowlist of permitted hosts. Block private IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, localhost).",
  },
  // CWE-862: Missing Authorization
  {
    id: "uni-004-missing-auth",
    title: "Route/endpoint handler without authorization check",
    severity: "high",
    languages: ["python", "javascript", "typescript", "java", "ruby", "php", "go"],
    // Each branch requires the route path to be SENSITIVE — without
    // this filter the Flask branch matched every single @app.route,
    // generating dozens of false-positive candidates per project.
    regex: /(?:@app\.(?:route|get|post|put|delete|patch)\s*\(\s*["']\/(?:admin|api|internal|dashboard|manage|settings|users|config|root|sudo|super))|(?:app\.(?:get|post|put|delete|patch|all)\s*\(\s*["']\/(?:admin|api|internal|dashboard|manage|settings|users|config|root|sudo|super))|(?:@(?:Get|Post|Put|Delete|Patch)Mapping\s*\(\s*["']\/(?:admin|api|internal|dashboard|manage|settings|users|config|root|sudo|super))/g,
    explanation:
      "Routes handling sensitive operations (admin, API, internal, settings, user management) " +
      "without visible authorization decorators or middleware. An unauthenticated user may " +
      "access privileged functionality.",
    verify_prompt:
      "Does this route handler have an authorization check? Look for: " +
      "@login_required, @auth_required, @requires_auth, @Secured, " +
      "@PreAuthorize, auth middleware, isAuthenticated(), requireAuth(), " +
      "session check, JWT validation, or an auth guard at the router level. " +
      "Also check if the file or class has a class-level auth decorator. " +
      "Respond FALSE_POSITIVE if ANY auth mechanism is present at handler, " +
      "class, or router level. Respond CONFIRMED only if the endpoint " +
      "handles sensitive operations with NO auth check at any level.",
    cwe: "CWE-862",
    fix_template: "Add authorization middleware/decorator: @login_required (Flask/Django), auth middleware (Express), @PreAuthorize (Spring).",
  },
  // CWE-287: Improper Authentication
  {
    id: "uni-005-weak-auth-compare",
    title: "Authentication credential compared with == instead of constant-time comparison",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php"],
    // Negative lookaheads exclude existence checks (null, undefined,
    // None, "", '') which are almost always innocuous existence
    // probes, not credential comparisons. Applied symmetrically to
    // BOTH alternatives — the first covers `password === "foo"` and
    // the second covers Yoda-style `"foo" === password`. Without
    // the LHS lookahead on the second alternative, `null === password`
    // slipped through.
    regex: /(?:password|token|secret|api_key|apiKey|auth_token|session_id|csrf)\s*(?:===?|!==?|==|!=)\s*(?!null\b|undefined\b|None\b|["'] *["']|["']\s*\))(?:["']|[a-z_])|(?!null\b|undefined\b|None\b|["'] *["'])(?:["']|[a-z_])\w*\s*(?:===?|!==?)\s*(?:password|token|secret|api_key|apiKey|auth_token)/g,
    explanation:
      "Comparing authentication credentials with == or === is vulnerable to timing " +
      "side-channel attacks. An attacker can determine the correct credential one " +
      "character at a time by measuring response time differences.",
    verify_prompt:
      "Is this comparing an authentication credential (password, token, API key, " +
      "session ID) using == or === instead of a constant-time comparison? " +
      "Respond FALSE_POSITIVE if: (1) this is comparing against null/undefined/empty, " +
      "(2) this is checking IF a credential exists (truthiness check), " +
      "(3) this uses hmac.compare_digest, crypto.timingSafeEqual, or equivalent, " +
      "(4) this is a non-sensitive comparison (e.g., comparing user roles or status). " +
      "Respond CONFIRMED if a raw credential is compared character-by-character.",
    cwe: "CWE-287",
    fix_template: "Use constant-time comparison: hmac.compare_digest() (Python), crypto.timingSafeEqual() (Node.js), subtle.ConstantTimeCompare() (Go).",
  },
  // CWE-306: Missing Authentication for Critical Function
  {
    id: "uni-006-critical-no-auth",
    title: "Critical operation (delete, shutdown, reset, grant) without authentication",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php"],
    regex: /(?:@app\.(?:route|delete|post)\s*\(\s*["'][^"']*(?:delete|remove|destroy|shutdown|reset|grant|revoke|admin|sudo|escalate|impersonate))|(?:app\.(?:delete|post)\s*\(\s*["'][^"']*(?:delete|remove|destroy|shutdown|reset|grant|revoke|admin))/g,
    explanation:
      "Routes handling destructive or privileged operations (delete, shutdown, reset, " +
      "grant, revoke, admin, impersonate) must require authentication. Missing auth on " +
      "these endpoints allows any unauthenticated user to perform critical operations.",
    verify_prompt:
      "Does this critical endpoint have authentication AND authorization? " +
      "Check for auth decorators, middleware, session checks, JWT validation. " +
      "Respond FALSE_POSITIVE if auth is present at handler, router, or app level. " +
      "Respond CONFIRMED only if a destructive/privileged operation has no auth.",
    cwe: "CWE-306",
    fix_template: "Add authentication + authorization middleware before the handler. Use @login_required + @admin_required or equivalent.",
  },
  // CWE-77: Command Injection (broader than CWE-78)
  {
    id: "uni-007-command-injection-concat",
    title: "Command built from string concatenation with variable",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php"],
    regex: /(?:exec\s*\(\s*["'`].*\$\{|child_process\.exec\s*\(\s*`|os\.system\s*\(\s*f["']|Runtime\.getRuntime\(\)\.exec\s*\(\s*[a-z_]+\s*\+|system\s*\(\s*["'].*\#\{|Process\.Start\s*\(\s*[a-z_]+\s*\+)/g,
    explanation:
      "Building shell commands via string concatenation or interpolation with user-controlled " +
      "variables allows command injection. The attacker can break out of the intended " +
      "command and execute arbitrary commands.",
    verify_prompt:
      "Is the interpolated/concatenated variable derived from user input? " +
      "Respond FALSE_POSITIVE if: (1) all variables are internal constants, " +
      "(2) the command is fully hardcoded with no dynamic parts, " +
      "(3) variables are validated against a strict allowlist before interpolation. " +
      "Respond CONFIRMED if any user-controlled data reaches the command string.",
    cwe: "CWE-77",
    fix_template: "Use parameterized execution: subprocess.run([cmd, arg1, arg2]) instead of shell string. Never pass user input through a shell.",
  },
  // CWE-269: Improper Privilege Management
  {
    id: "uni-008-privilege-escalation",
    title: "Dangerous privilege operation (setuid, chmod 777, running as root)",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "c", "cpp", "ruby", "shell"],
    regex: /(?:os\.set(?:uid|gid|euid|egid)\s*\(\s*0|chmod\s+(?:777|666|a\+rwx)|setuid\s*\(\s*0\)|seteuid\s*\(\s*0\)|os\.chmod\s*\(\s*[^,]+,\s*0o?777\)|running.*as.*root|if.*os\.getuid\(\)\s*(?:!=|==)\s*0)/g,
    explanation:
      "Setting UID to 0, chmod 777, or running as root introduces privilege escalation " +
      "risks. Processes should run with minimum required privileges.",
    verify_prompt:
      "Is this privilege operation necessary and properly guarded? " +
      "Respond FALSE_POSITIVE if: (1) the code drops privileges after setup (setuid to non-root), " +
      "(2) chmod is on a temp file that's deleted after use, " +
      "(3) the root check is used to REFUSE running as root (not to require it). " +
      "Respond CONFIRMED if the code escalates privileges or sets overly permissive permissions.",
    cwe: "CWE-269",
    fix_template: "Run with minimum required privileges. Use 0o755 instead of 0o777. Drop root after binding privileged ports.",
  },
  // CWE-94: Code Injection (broader than CWE-95 eval)
  {
    id: "uni-009-code-injection",
    title: "Dynamic code generation/compilation from external input",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "java", "ruby", "php"],
    regex: /(?:new\s+Function\s*\(\s*[a-z_]|compile\s*\(\s*(?:[a-z_]+\s*[,)]|f["']|[a-z_]+\s*\+)|CodeDom|Roslyn.*Compile|GroovyShell|ScriptEngine.*eval|instance_eval\s*\(\s*(?:params|request|args)|create_function\s*\(\s*["']\$)/g,
    explanation:
      "Dynamically generating and executing code from external input enables arbitrary " +
      "code injection. Unlike eval() which executes existing strings, code injection " +
      "patterns involve building new code constructs (Function objects, compiled assemblies, " +
      "template engines) from attacker-controlled input.",
    verify_prompt:
      "Is the code being generated/compiled from user-controlled input? " +
      "Respond FALSE_POSITIVE if: (1) the source is an internal template, " +
      "(2) this is a code-generation build tool (not runtime), " +
      "(3) the input is from a trusted config file. " +
      "Respond CONFIRMED if external/user input reaches the code compilation.",
    cwe: "CWE-94",
    fix_template: "Never compile user input into executable code. Use a sandboxed interpreter or a safe template engine.",
  },
  // CWE-327: Use of Broken/Risky Cryptographic Algorithm
  {
    id: "uni-011-weak-crypto",
    title: "Use of broken cryptographic algorithm (MD5, SHA1, DES, RC4, MD4)",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php", "c", "cpp", "rust", "csharp"],
    regex: /\b(?:MD5|md5|sha1|SHA1|SHA-1|DES|RC4|rc4|MD4|md4|hashlib\.md5|hashlib\.sha1|crypto\.createHash\s*\(\s*["'](?:md5|sha1)|MessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1)|CryptoJS\.(?:MD5|SHA1))\b/g,
    explanation:
      "MD5, SHA1, DES, RC4, and MD4 are cryptographically broken. They should NEVER be used for password hashing, digital signatures, HMAC keys, or any security-sensitive operation. Use SHA-256+, bcrypt/argon2 for passwords, AES-GCM for encryption.",
    verify_prompt:
      "Is this broken algorithm used for a SECURITY-sensitive purpose? " +
      "Respond FALSE_POSITIVE if: " +
      "(1) used for non-security hashing (cache key, ETag, file checksum, bloom filter), " +
      "(2) used for compatibility with a legacy system that requires MD5/SHA1 (document it), " +
      "(3) used for integrity verification against a trusted value (not attacker-controlled), " +
      "(4) this is in test code or a crypto library's own implementation. " +
      "Respond CONFIRMED if used for passwords, signatures, MAC, key derivation, or TLS.",
    cwe: "CWE-327",
    fix_template: "Replace with SHA-256+ for hashing, bcrypt/argon2 for passwords, AES-GCM for encryption, Ed25519 for signatures.",
  },
  // CWE-90: LDAP Injection
  {
    id: "uni-012-ldap-injection",
    title: "LDAP query built via string concatenation with user input",
    severity: "high",
    languages: ["python", "javascript", "typescript", "java", "csharp", "php"],
    regex: /(?:ldap.*search.*\(\s*[^,]*\+|ldap_search\s*\([^)]*\$|DirectorySearcher.*Filter\s*=\s*[^"]*\+|LdapContext.*search\s*\([^)]*\+|ldap3.*search\s*\(\s*search_filter\s*=\s*f["'])/g,
    explanation:
      "LDAP queries built via string concatenation with user input allow LDAP injection. An attacker can modify the filter to bypass authentication or extract unauthorized records.",
    verify_prompt:
      "Does user input flow into the LDAP filter? " +
      "Respond FALSE_POSITIVE if the filter uses parameterized substitution, " +
      "LDAP-escape functions (ldap.filter.escape_filter_chars), or an allowlist. " +
      "Respond CONFIRMED if raw user input is concatenated into the filter string.",
    cwe: "CWE-90",
    fix_template: "Use parameterized LDAP queries or escape user input with ldap.filter.escape_filter_chars / LdapEncoder.filterEncode.",
  },
  // CWE-384: Session Fixation
  {
    id: "uni-013-session-fixation",
    title: "Session ID not regenerated after authentication",
    severity: "high",
    languages: ["python", "javascript", "typescript", "java", "php", "ruby"],
    regex: /(?:def\s+login|function\s+login|public.*login|app\.post\s*\(\s*["'][^"']*login)/gi,
    explanation:
      "After successful authentication, the session ID must be regenerated. Otherwise, an attacker who fixed the session ID before login can hijack the authenticated session.",
    verify_prompt:
      "Does this login handler regenerate the session ID after successful auth? " +
      "Look for: session.regenerate(), req.session.regenerate(), " +
      "HttpServletRequest.changeSessionId(), session_regenerate_id(true). " +
      "Respond FALSE_POSITIVE if session regeneration is present within 20 lines of the login success. " +
      "Respond CONFIRMED only if the function clearly authenticates and returns without regenerating.",
    cwe: "CWE-384",
    fix_template: "Call session regeneration immediately after successful authentication: req.session.regenerate() (Express), request.session.cycle_key() (Django), session_regenerate_id(true) (PHP).",
  },
  // CWE-613: Insufficient Session Expiration
  {
    id: "uni-014-no-session-timeout",
    title: "Session cookie/token without expiration or with excessive lifetime",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "java", "php", "ruby"],
    regex: /(?:session\.permanent\s*=\s*True|maxAge\s*:\s*(?:null|undefined|Infinity|[1-9][0-9]{9,})|expires\s*:\s*null|session_config.*expire.*0|cookie.*maxAge.*86400000\s*\*\s*[3-9][0-9]+)/g,
    explanation:
      "Sessions without expiration (or with >30 day lifetimes) increase the blast radius of a leaked token. Stolen session IDs remain valid indefinitely.",
    verify_prompt:
      "Is this session/cookie lacking an expiration OR set to an excessively long lifetime (>30 days)? " +
      "Respond FALSE_POSITIVE if: (1) it's a 'remember me' feature with rotating refresh tokens, " +
      "(2) the expiration is managed server-side by a separate mechanism, " +
      "(3) this is a configuration default that gets overridden elsewhere. " +
      "Respond CONFIRMED if sessions persist indefinitely.",
    cwe: "CWE-613",
    fix_template: "Set session expiration to 1-24 hours for sensitive apps. Use refresh token rotation for long-lived sessions.",
  },
  // CWE-59: Symlink TOCTOU (link following)
  {
    id: "uni-015-symlink-toctou",
    title: "File operation following symlinks without resolution check (TOCTOU)",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "c", "cpp", "ruby", "java"],
    regex: /(?:os\.stat\s*\([^)]*\)[\s\S]{0,100}?open\s*\(|if\s+os\.path\.(?:exists|isfile)[\s\S]{0,100}?open\s*\(|access\s*\([^)]*F_OK\s*\)[\s\S]{0,100}?open\s*\(|fs\.existsSync[\s\S]{0,100}?fs\.(?:read|write)FileSync)/g,
    explanation:
      "Check-then-use patterns on files are vulnerable to TOCTOU attacks via symlinks. " +
      "Between the check (exists/stat/access) and the use (open/read/write), an attacker " +
      "can replace the file with a symlink pointing to a sensitive location.",
    verify_prompt:
      "Is this a classic check-then-use pattern on an attacker-controllable path? " +
      "Respond FALSE_POSITIVE if: (1) the path is a hardcoded trusted location, " +
      "(2) the check uses O_NOFOLLOW or fstatat with AT_SYMLINK_NOFOLLOW, " +
      "(3) realpath() is called and validated before the file operation. " +
      "Respond CONFIRMED if an attacker can swap the file between check and use.",
    cwe: "CWE-59",
    fix_template: "Use atomic operations (openat with O_NOFOLLOW, fstat on the open fd, realpath + prefix check).",
  },
  // CWE-73: External Control of File Name or Path
  {
    id: "uni-016-external-file-path",
    title: "File path directly controlled by user input",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php"],
    regex: /(?:open\s*\(\s*(?:request\.|req\.|params\[|args\.|input|sys\.argv)|fs\.(?:read|write|append)File\s*\(\s*(?:req\.|request\.|params\[)|File\s*\(\s*(?:request\.|req\.|params\[)|fopen\s*\(\s*\$_(?:GET|POST|REQUEST))/g,
    explanation:
      "Passing user input directly as a file path gives attackers control over which file " +
      "is read or written. Even without path traversal, an attacker can access any file the " +
      "process can reach (config, logs, keys).",
    verify_prompt:
      "Does the file path come directly from user input without allowlist validation? " +
      "Respond FALSE_POSITIVE if: (1) the path is validated against a fixed allowlist, " +
      "(2) it's joined with a fixed directory and os.path.realpath verifies containment, " +
      "(3) the user only supplies an ID/slug that's used to look up the real path server-side. " +
      "Respond CONFIRMED if raw user input reaches a file operation.",
    cwe: "CWE-73",
    fix_template: "Use an allowlist of permitted filenames, or look up the real path from a user-supplied ID via a trusted mapping.",
  },
  // CWE-200: Information Exposure (generic)
  {
    id: "uni-017-info-exposure",
    title: "Debug info / internal state exposed in response",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php"],
    regex: /(?:return\s+(?:jsonify|Response|res\.json)\s*\(\s*\{[^}]*(?:password|token|secret|api_key|hash|salt|private_key)|res\.send\s*\(\s*(?:err|error|exception|traceback)|DEBUG\s*=\s*True.*return)/g,
    explanation:
      "Returning sensitive internal state (passwords, tokens, stack traces, debug info) in HTTP " +
      "responses leaks information to attackers. Error responses especially tend to include " +
      "database errors or internal paths that aid reconnaissance.",
    verify_prompt:
      "Does this response include sensitive data (credentials, internal paths, stack traces, DB errors)? " +
      "Respond FALSE_POSITIVE if: (1) the response is a sanitized error message with no internal details, " +
      "(2) this is a development-only endpoint behind auth, " +
      "(3) the 'password' field is actually a password confirmation input, not an output. " +
      "Respond CONFIRMED if sensitive data reaches the client.",
    cwe: "CWE-200",
    fix_template: "Strip sensitive fields before serializing. Use a generic error message in production and log details server-side.",
  },
  // CWE-209: Error Messages Containing Sensitive Information
  {
    id: "uni-018-sensitive-error",
    title: "Raw exception / stack trace returned to client",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "java", "csharp", "php", "ruby"],
    regex: /(?:return\s+(?:str\s*\(\s*)?e(?:xception)?\s*\)|res\.(?:send|json|status\s*\(\s*500\s*\)\.send)\s*\(\s*(?:err|error|e\.stack|e\.message)|printStackTrace\s*\(\s*(?:response|resp|writer)|echo\s+\$(?:e|exception)|raise\s+HTTPException\s*\([^)]*str\s*\(\s*e)/g,
    explanation:
      "Returning exception details (stack traces, error messages) to the client leaks internal " +
      "implementation details: file paths, function names, dependency versions, SQL queries, " +
      "environment config. Attackers use this for reconnaissance.",
    verify_prompt:
      "Is a raw exception/stack trace sent back to the client? " +
      "Respond FALSE_POSITIVE if: (1) only in development mode (check for DEBUG flag), " +
      "(2) the error is sanitized first (e.g., only message, no stack), " +
      "(3) it's an internal admin endpoint that needs detailed errors. " +
      "Respond CONFIRMED if unconditional raw exceptions reach the client in production paths.",
    cwe: "CWE-209",
    fix_template: "In production, return a generic 'Internal server error' and log the exception server-side with a correlation ID the user can reference.",
  },
  // CWE-863: Incorrect Authorization
  {
    id: "uni-010-client-side-auth",
    title: "Authorization decision based on client-controlled data",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "ruby", "php"],
    regex: /(?:(?:is_admin|isAdmin|is_superuser|isSuperuser|role|permission)\s*=\s*(?:request\.|req\.|params\[|args\.|body\.|query\.))|(?:if\s*\(\s*(?:req|request)\.(?:body|query|params|cookies)\s*\.\s*(?:admin|role|permission|is_admin|isAdmin|is_superuser))/g,
    explanation:
      "Authorization decisions must be made from server-side session data, not from " +
      "client-supplied values. Reading is_admin/role/permission from request body, query " +
      "params, or cookies allows any user to escalate their own privileges.",
    verify_prompt:
      "Is the authorization value (admin, role, permission) read from the client " +
      "request (body, query, params, cookies) instead of from a server-side session " +
      "or database lookup? " +
      "Respond FALSE_POSITIVE if: the value is read from a server session, JWT that " +
      "was validated server-side, or a database lookup using the session user ID. " +
      "Respond CONFIRMED if the client can directly set their own role/admin/permission.",
    cwe: "CWE-863",
    fix_template: "Read authorization data from the server session or a validated JWT — never from request body/query/cookies.",
  },
];
