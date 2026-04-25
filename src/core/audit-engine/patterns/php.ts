// KCode - PHP Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const PHP_PATTERNS: BugPattern[] = [
  {
    id: "php-001-sql-injection",
    title: "SQL query with variable interpolation",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:mysql_query|mysqli_query|->query)\s*\(\s*["'].*\$/g,
    explanation: "SQL queries with PHP variable interpolation ($var) are vulnerable to injection.",
    verify_prompt: "Is user input interpolated? If using prepared statements (bind_param), respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: "Use prepared statements: $stmt = $pdo->prepare('SELECT * FROM t WHERE id = ?'); $stmt->execute([$id]);",
  },
  {
    id: "php-002-eval",
    title: "eval() with dynamic input",
    severity: "critical",
    languages: ["php"],
    regex: /\beval\s*\(\s*\$/g,
    explanation: "eval() executes arbitrary PHP code. If input is user-controlled, this is RCE.",
    verify_prompt: "Is the argument from user input? If hardcoded/internal, respond FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template: "Remove eval(). Use specific functions for the intended operation.",
  },
  {
    id: "php-003-file-include",
    title: "Dynamic file include (LFI/RFI)",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:include|require|include_once|require_once)\s*\(\s*\$/g,
    explanation: "Including files from user input enables Local/Remote File Inclusion attacks.",
    verify_prompt: "Is the path from user input? If from internal config/constant, respond FALSE_POSITIVE.",
    cwe: "CWE-98",
    fix_template: "Whitelist allowed files: $allowed = ['page1', 'page2']; if (in_array($input, $allowed)) include($input.'.php');",
  },
  {
    id: "php-004-xss",
    title: "Unescaped output (XSS)",
    severity: "high",
    languages: ["php"],
    regex: /echo\s+\$(?:_GET|_POST|_REQUEST|_COOKIE)\s*\[/g,
    explanation: "Echoing superglobal variables directly enables XSS. Always escape output.",
    verify_prompt: "Is htmlspecialchars() or equivalent applied before output? If escaped, respond FALSE_POSITIVE.",
    cwe: "CWE-79",
    fix_template: "echo htmlspecialchars($_GET['param'], ENT_QUOTES, 'UTF-8');",
  },
  {
    id: "php-005-sql-superglobal",
    title: "SQL injection via $_GET/$_POST in query",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:query|execute|prepare)\s*\([^)]*\$_(?:GET|POST|REQUEST)\s*\[/g,
    explanation:
      "Superglobal variables ($_GET, $_POST) used directly in SQL queries without parameterization enable SQL injection.",
    verify_prompt:
      "Is the superglobal value passed through a prepared statement with bind_param or execute([...])? " +
      "If parameterized, respond FALSE_POSITIVE. If interpolated into SQL string, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "$stmt = $pdo->prepare('SELECT * FROM t WHERE id = ?'); $stmt->execute([$_GET['id']]);",
  },
  {
    id: "php-006-unserialize",
    title: "unserialize() with untrusted data",
    severity: "critical",
    languages: ["php"],
    regex: /\bunserialize\s*\(\s*\$(?:_GET|_POST|_REQUEST|_COOKIE|input|data|body)/g,
    explanation:
      "unserialize() with user-controlled data enables PHP Object Injection. Attackers craft serialized payloads that trigger __wakeup/__destruct chains for RCE.",
    verify_prompt:
      "Is the serialized data from an untrusted source (request, cookie, user upload)? " +
      "If from trusted internal cache with HMAC verification, respond FALSE_POSITIVE. " +
      "If from user input without signature check, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template: "Use json_decode() instead of unserialize(), or pass allowed_classes: ['ClassName'] option.",
  },
  {
    id: "php-007-path-traversal",
    title: "Path traversal via $_GET/$_POST in file operations",
    severity: "high",
    languages: ["php"],
    regex: /\b(?:file_get_contents|fopen|readfile|file)\s*\([^)]*\$_(?:GET|POST|REQUEST)\s*\[/g,
    explanation:
      "Using $_GET/$_POST in file operations allows path traversal (../../etc/passwd). Attacker can read arbitrary files on the server.",
    verify_prompt:
      "Is the path validated (basename(), realpath() + prefix check)? " +
      "If the path is sanitized before use, respond FALSE_POSITIVE. " +
      "If user input goes directly to file operation, respond CONFIRMED.",
    cwe: "CWE-22",
    fix_template: "$path = basename($_GET['file']); readfile('/safe/dir/' . $path);",
  },
  {
    id: "php-008-csrf-no-token",
    title: "POST handler without CSRF token validation",
    severity: "medium",
    languages: ["php"],
    regex: /\$_SERVER\s*\[\s*['"]REQUEST_METHOD['"]\s*\]\s*===?\s*['"]POST['"](?![\s\S]{0,300}?(?:csrf|token|nonce|verify))/gi,
    explanation:
      "POST handler without CSRF token validation. An attacker can craft a form on another site that submits to this endpoint on behalf of an authenticated user.",
    verify_prompt:
      "Does this POST handler validate a CSRF token (hidden field, header, or session check) " +
      "within the handler body? If token is checked, respond FALSE_POSITIVE. " +
      "If this is an API endpoint using Bearer tokens (not cookies), respond FALSE_POSITIVE. " +
      "If no CSRF protection exists, respond CONFIRMED.",
    cwe: "CWE-352",
    fix_template: "Add CSRF token: if ($_POST['csrf_token'] !== $_SESSION['csrf_token']) die('CSRF');",
  },
  {
    id: "php-009-type-juggling",
    title: "Loose comparison (==) with security-sensitive value",
    severity: "medium",
    languages: ["php"],
    regex: /\$(?:password|token|hash|secret|api_key)\s*==\s*(?!\s*=)/g,
    explanation:
      "PHP loose comparison (==) causes type juggling. '0e123' == '0e456' is true, 0 == 'any-string' is true. This breaks password/token comparisons.",
    verify_prompt:
      "Is this a security-sensitive comparison (password, token, hash, API key)? " +
      "If it's a non-security comparison (feature flag, pagination), respond FALSE_POSITIVE. " +
      "If comparing credentials/tokens with ==, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template: "Use strict comparison (===) or hash_equals() for timing-safe comparison.",
  },
  {
    id: "php-010-extract-user-input",
    title: "extract() with user input (variable injection)",
    severity: "high",
    languages: ["php"],
    regex: /\bextract\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/g,
    explanation:
      "extract() creates local variables from array keys. With user input, attackers can overwrite any variable including $isAdmin, $authenticated, etc.",
    verify_prompt:
      "Is extract() called on user-controlled data ($_GET, $_POST, $_REQUEST)? " +
      "If called with EXTR_SKIP or EXTR_PREFIX_ALL flag, respond FALSE_POSITIVE. " +
      "If called without protection on superglobals, respond CONFIRMED.",
    cwe: "CWE-621",
    fix_template: "Access values explicitly: $name = $_POST['name']; or use extract($data, EXTR_SKIP);",
  },
  {
    id: "php-011-shell-exec",
    title: "Shell execution with user input",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:shell_exec|exec|system|passthru|popen|proc_open)\s*\([^)]*\$_(?:GET|POST|REQUEST)/g,
    explanation:
      "Passing user input to shell execution functions enables command injection. Attacker can chain commands with ; | && etc.",
    verify_prompt:
      "Is the user input escaped with escapeshellarg()/escapeshellcmd() before use? " +
      "If properly escaped, respond FALSE_POSITIVE. " +
      "If raw superglobal goes to shell function, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "$output = shell_exec('ls ' . escapeshellarg($_GET['dir']));",
  },
  {
    id: "php-012-hardcoded-credentials",
    title: "Hardcoded credentials in PHP",
    severity: "high",
    languages: ["php"],
    regex: /\$(?:password|db_pass|secret|api_key|auth_token)\s*=\s*['"][A-Za-z0-9!@#$%^&*+/=_-]{8,}['"]\s*;/g,
    explanation:
      "Hardcoded credentials in source code are exposed to anyone with repo access and persist in version history even after removal.",
    verify_prompt:
      "Is this a real credential or a placeholder/example (e.g., 'changeme', 'your-key-here')? " +
      "If placeholder or test fixture, respond FALSE_POSITIVE. " +
      "If it looks like a real password/key, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "$password = getenv('DB_PASSWORD'); or use .env with vlucas/phpdotenv.",
  },
  {
    id: "php-013-weak-hash-password",
    title: "md5/sha1 used for password hashing",
    severity: "high",
    languages: ["php"],
    regex: /\b(?:md5|sha1)\s*\(\s*\$(?:password|pass|pwd|user_pass)/g,
    explanation:
      "md5/sha1 are fast hashes unsuitable for passwords. GPU cracking breaks them trivially. Use password_hash() with bcrypt/argon2.",
    verify_prompt:
      "Is md5/sha1 being used to hash a PASSWORD specifically? " +
      "If used for a non-security purpose (checksum, cache key, file hash), respond FALSE_POSITIVE. " +
      "If hashing a password or credential, respond CONFIRMED.",
    cwe: "CWE-328",
    fix_template: "$hash = password_hash($password, PASSWORD_DEFAULT); // bcrypt by default",
  },
  {
    id: "php-014-print-xss",
    title: "print/printf of user input without escaping (XSS)",
    severity: "high",
    languages: ["php"],
    regex: /\b(?:print|printf)\s*\(?[^)]*\$_(?:GET|POST|REQUEST|COOKIE)\s*\[/g,
    explanation:
      "Printing user input without htmlspecialchars() enables reflected XSS attacks.",
    verify_prompt:
      "Is the output HTML-escaped with htmlspecialchars() or htmlentities()? " +
      "If escaped, respond FALSE_POSITIVE. If raw output, respond CONFIRMED.",
    cwe: "CWE-79",
    fix_template: "print htmlspecialchars($_GET['name'], ENT_QUOTES, 'UTF-8');",
  },
  {
    id: "php-015-backtick-injection",
    title: "Backtick operator with user input (command injection)",
    severity: "critical",
    languages: ["php"],
    regex: /`[^`]*\$_(?:GET|POST|REQUEST)[^`]*`/g,
    explanation:
      "PHP backtick operator executes shell commands. With user input interpolated, this is command injection.",
    verify_prompt:
      "Is user input interpolated inside backticks? " +
      "If the entire command is a hardcoded constant, respond FALSE_POSITIVE. " +
      "If superglobals appear inside backticks, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use escapeshellarg(): $out = shell_exec('cmd ' . escapeshellarg($_GET['arg']));",
  },

  // ── v2.10.333 — Phase A round 2 (PHP SSRF) ────────────────────
  {
    id: "php-016-ssrf-fetch",
    title: "file_get_contents / cURL on user-controllable URL (SSRF)",
    severity: "high",
    languages: ["php"],
    regex:
      /\b(?:file_get_contents|fopen|curl_setopt\s*\([^,]+,\s*CURLOPT_URL\s*,)\s*\(?\s*\$_(?:GET|POST|REQUEST|COOKIE)\b/g,
    explanation:
      "PHP's file_get_contents accepts http:// / https:// / phar:// URLs. cURL likewise. Passing a user-controllable URL without an allowlist lets the attacker reach internal services (Redis, metadata endpoints, admin panels) from inside the perimeter.",
    verify_prompt:
      "Is there an allowlist check (host comparison against a fixed list, scheme restricted to https) BEFORE the call?\n" +
      "1. Allowlist present → FALSE_POSITIVE.\n" +
      "2. URL parsed and IP resolved + checked against RFC1918 / loopback / metadata IPs → FALSE_POSITIVE.\n" +
      "3. URL comes from a config file the operator owns, not a superglobal → FALSE_POSITIVE.\n" +
      "Only CONFIRMED when a $_GET / $_POST / $_REQUEST value reaches the URL argument unfiltered.",
    cwe: "CWE-918",
    fix_template:
      "Validate the URL: check scheme is https, host is in an allowlist, and the resolved IP is NOT RFC1918 / 127/8 / 169.254.169.254.",
  },
];
