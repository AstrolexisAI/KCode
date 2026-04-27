// KCode - JS Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const JS_PATTERNS: BugPattern[] = [
  {
    id: "js-001-eval",
    title: "eval() with potentially untrusted input",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\beval\s*\(/g,
    explanation:
      "eval() executes arbitrary JavaScript. If input is user-controlled, this is XSS/RCE.",
    verify_prompt:
      "Is the argument entirely hardcoded or internal? If ANY external input reaches eval(), respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The argument is a compile-time constant or hardcoded string literal\n" +
      "2. The input comes from a trusted internal source (not user/network input)\n" +
      "3. This is in test/example/documentation code\n" +
      "4. The eval is used for JSON.parse fallback on a validated string\n" +
      "Only respond CONFIRMED if user-controlled or external input can reach the eval() argument.",
    cwe: "CWE-95",
    fix_template:
      "Remove eval() or use JSON.parse() for data, Function constructor for controlled cases.",
  },
  {
    id: "js-002-innerhtml",
    title: "innerHTML/outerHTML with dynamic content (XSS)",
    severity: "high",
    languages: ["javascript", "typescript"],
    // Skip only clearly-benign empty-literal assignments:
    // `= ""`, `= ''`, `= ` `` `` (template) — optionally followed by
    // `;` and end-of-line. `m` flag makes `$` mean end-of-line
    // (not end-of-input), so benign empty-literal lines don't get
    // flagged just because more code follows them in the file.
    //
    // Before Phase 3b the lookahead was `(?!["'`]\s*$)` — matched a
    // single quote char, not a paired literal, and used `$` without
    // `m`. Every multi-line file with `innerHTML = "";` tripped the
    // fixture harness.
    // `(?=\S)` pins position to the first non-whitespace char of
    // the RHS so the `\s*` before it can't backtrack to zero chars
    // (which would slip past the paired-literal check). `[ \t]*`
    // in the inner stops the lookahead from crossing a newline
    // before hitting `$`. Together they correctly skip assignments
    // of empty literal strings without false-negating real XSS.
    regex: /\.(innerHTML|outerHTML)\s*=\s*(?=\S)(?!(?:""|''|``)[ \t]*;?[ \t]*$)/gm,
    explanation:
      "Setting innerHTML with dynamic content enables XSS. Use textContent or a sanitizer.",
    verify_prompt:
      "Is the assigned value from user input or external data? If hardcoded HTML, respond FALSE_POSITIVE.",
    cwe: "CWE-79",
    fix_template: "Use element.textContent = value, or DOMPurify.sanitize(html).",
  },
  {
    id: "js-003-prototype-pollution",
    title: "Object merge/assign without prototype pollution guard",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex:
      /\b(?:Object\.assign|_\.merge|_\.extend|_\.defaultsDeep)\s*\([^,]+,\s*(?:req\.|params\.|body\.|query\.|input)/g,
    explanation:
      "Merging user input into objects without filtering __proto__, constructor, prototype allows prototype pollution → RCE in some frameworks.",
    verify_prompt:
      "Does the source object come from untrusted input (request body, query params)? If internal-only, respond FALSE_POSITIVE.",
    cwe: "CWE-1321",
    fix_template:
      "Filter dangerous keys: delete input.__proto__; delete input.constructor; or use structuredClone().",
  },
  {
    id: "js-004-nosql-injection",
    title: "NoSQL query with user input (injection risk)",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex:
      /\b(?:find|findOne|updateOne|deleteOne|aggregate)\s*\(\s*\{[^}]*(?:req\.|params\.|body\.|query\.)/g,
    explanation:
      "MongoDB queries with user-controlled operators ($gt, $ne, $regex) enable NoSQL injection.",
    verify_prompt:
      "Is user input passed directly as a query filter without sanitization? If parameterized/validated, respond FALSE_POSITIVE.",
    cwe: "CWE-943",
    fix_template: "Validate/cast input types explicitly: { email: String(req.body.email) }",
  },
  {
    id: "js-005-regex-dos",
    title: "Regex with user input (ReDoS risk)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /new\s+RegExp\s*\(\s*(?:req\.|params\.|body\.|query\.|input|arg|user)/g,
    explanation:
      "Constructing regex from user input enables ReDoS (catastrophic backtracking). An attacker can send a pattern that hangs the event loop.",
    verify_prompt:
      "Is the regex pattern from user input? If from internal/hardcoded source, respond FALSE_POSITIVE.",
    cwe: "CWE-1333",
    fix_template: "Use a regex timeout library, or escape user input with escapeRegExp().",
  },
  {
    id: "js-006-hardcoded-secret",
    title: "Hardcoded secret/key in JavaScript/TypeScript",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex:
      /(?:SECRET|API_KEY|PRIVATE_KEY|PASSWORD|TOKEN|AUTH)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/g,
    explanation: "Hardcoded secrets in source code are exposed to anyone with repo access.",
    verify_prompt:
      "Is this a real secret or a placeholder/test value? If it looks like a real key (long, random), respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The value is a placeholder ('changeme', 'xxx', 'your-api-key-here', 'TODO', 'REPLACE_ME')\n" +
      "2. This is in test, example, or documentation code\n" +
      "3. The value is loaded from an environment variable (process.env.X)\n" +
      "4. The value is a well-known public key or non-secret identifier\n" +
      "Only respond CONFIRMED if the value appears to be a real secret committed to source code in production code.",
    cwe: "CWE-798",
    fix_template: "Use process.env.SECRET_KEY or a secrets manager.",
  },
  {
    id: "js-007-command-injection",
    title: "Shell command with template literal (injection)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*`/g,
    explanation:
      "Running shell commands with template literals allows injection if any interpolated value is user-controlled.",
    verify_prompt:
      "Does the template literal include ANY external input? If entirely hardcoded, respond FALSE_POSITIVE.",
    cwe: "CWE-78",
    fix_template: "Use spawn/execFile with array args instead of shell string.",
  },
  {
    id: "js-008-prototype-pollution-bracket",
    title: "Prototype pollution via bracket notation with user key",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /\w+\[\s*(?:req\.|params\.|body\.|query\.|input|key|prop|name|field)\w*\s*\]\s*=/g,
    explanation:
      "Setting object properties via bracket notation with a user-controlled key allows prototype pollution. An attacker can set __proto__.isAdmin = true to affect all objects.",
    verify_prompt:
      "Is the key (property name) from user/external input? Check if __proto__, " +
      "constructor, or prototype keys are filtered. If there's a hasOwnProperty check " +
      "or allowlist, respond FALSE_POSITIVE. If user controls the key without filtering, respond CONFIRMED.",
    cwe: "CWE-1321",
    fix_template:
      "Validate keys: if (['__proto__', 'constructor', 'prototype'].includes(key)) return; or use Map instead of plain objects.",
  },
  {
    id: "js-009-redos-nested-quantifier",
    title: "ReDoS: regex with nested quantifiers on user input",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex:
      /new\s+RegExp\s*\([^)]*\)[\s\S]{0,100}?\.(?:test|match|exec)\s*\(\s*(?:req\.|params\.|body\.|query\.|input|user)/g,
    explanation:
      "Regex with nested quantifiers (e.g., (a+)+, (a|b)*c) on user input can cause catastrophic backtracking (ReDoS), freezing the event loop for minutes or hours.",
    verify_prompt:
      "Does this regex run on user-controlled input? If the input is from a trusted " +
      "source or the regex has no nested quantifiers/alternation, respond FALSE_POSITIVE. " +
      "If user input hits a complex regex, respond CONFIRMED.",
    cwe: "CWE-1333",
    fix_template: "Use re2 library for safe regex, or add input length limits and timeouts.",
  },
  {
    id: "js-010-innerhtml-xss",
    title: "innerHTML assignment with dynamic content (XSS)",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /\.innerHTML\s*(?:=|\+=)\s*(?!["'`]\s*;)(?:.*\+|`[^`]*\$\{)/g,
    explanation:
      "Assigning dynamic content to innerHTML enables XSS. Attacker-controlled HTML can execute scripts, steal cookies, and hijack sessions.",
    verify_prompt:
      "Is the assigned value constructed from user input or external data? " +
      "If it's entirely hardcoded HTML or sanitized with DOMPurify, respond FALSE_POSITIVE. " +
      "If any user data is concatenated or interpolated, respond CONFIRMED.",
    cwe: "CWE-79",
    fix_template: "Use textContent for text, or sanitize: el.innerHTML = DOMPurify.sanitize(html).",
  },
  {
    id: "js-011-eval-new-function",
    title: "new Function() with user input (code execution)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\bnew\s+Function\s*\(\s*(?:req\.|params\.|body\.|query\.|input|user|arg|data)/g,
    explanation:
      "new Function() creates a function from a string, equivalent to eval(). If the string contains user input, this is remote code execution.",
    verify_prompt:
      "Is the string passed to new Function() from user/external input? " +
      "If entirely hardcoded or from trusted internal source, respond FALSE_POSITIVE. " +
      "If any user data is interpolated, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template:
      "Avoid new Function() with dynamic strings. Use a safe expression parser or sandbox.",
  },
  {
    id: "js-012-event-listener-leak",
    title: "addEventListener without corresponding removeEventListener",
    severity: "low",
    languages: ["javascript", "typescript"],
    regex:
      /addEventListener\s*\(\s*["'][^"']+["']\s*,\s*(?:function|\([^)]*\)\s*=>|[a-zA-Z_]\w*)\s*\)/g,
    explanation:
      "Adding event listeners without removing them causes memory leaks, especially in SPAs where components mount/unmount. Each re-render adds another listener.",
    verify_prompt:
      "Is this addEventListener in a component or context that gets destroyed/unmounted? " +
      "If there's a corresponding removeEventListener in a cleanup/destroy/unmount handler, " +
      "respond FALSE_POSITIVE. If the listener is added repeatedly without cleanup, respond CONFIRMED.",
    cwe: "CWE-401",
    fix_template:
      "Store reference and remove in cleanup: const handler = () => {}; el.addEventListener('click', handler); // later: el.removeEventListener('click', handler);",
  },
  {
    id: "js-013-loose-equality",
    title: "Loose equality (==) instead of strict equality (===)",
    severity: "low",
    languages: ["javascript", "typescript"],
    regex: /[^!=<>]==[^=]/g,
    explanation:
      "The == operator performs type coercion, leading to surprising results: '' == false, 0 == '', null == undefined. This causes subtle bugs in conditionals.",
    verify_prompt:
      "Is this == comparison intentional for type coercion (e.g., x == null to check " +
      "both null and undefined)? If it's an intentional null-check idiom, respond " +
      "FALSE_POSITIVE. If it's comparing values that should use strict equality, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template: "Use === for strict equality, or == null specifically for null/undefined checks.",
  },
  {
    id: "js-014-json-parse-no-catch",
    title: "JSON.parse without try/catch (crash on invalid input)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex:
      /(?<!try\s*\{[\s\S]{0,200}?)JSON\.parse\s*\(\s*(?:req\.|body\.|data|input|response|text|content)/g,
    explanation:
      "JSON.parse() throws SyntaxError on invalid JSON. Without try/catch, malformed input crashes the process or rejects the promise unhandled.",
    verify_prompt:
      "Does this JSON.parse() have ANY exception handling that absorbs SyntaxError? " +
      "Respond FALSE_POSITIVE for ALL of these cases: " +
      "(1) The JSON.parse is inside a try { ... } catch block anywhere in the " +
      "enclosing function — even if the catch is at the top of the function and the " +
      "JSON.parse is 50+ lines deep, that catch will still absorb the SyntaxError. " +
      "Look UP in the file for any `try {` that hasn't been closed yet at the " +
      "JSON.parse line. " +
      "(2) The JSON.parse is inside an async function called from a Promise.catch(), " +
      ".catch(err => ...), or a global unhandledRejection handler. " +
      "(3) This is a setup/seed/init/CLI script (paths like setup/, scripts/, " +
      "seed/, migrate/, tools/, bin/) where crash-on-bad-input is the DESIRED " +
      "behavior — you want the script to fail loudly if a fixture or config is " +
      "malformed, not silently continue with bad data. " +
      "(4) The input is a hardcoded constant string or the result of JSON.stringify " +
      "(round-trip, can never produce invalid JSON). " +
      "(5) This is in test code (test/, __tests__/, *.test.js, *.spec.js) — test " +
      "fixtures are developer-controlled. " +
      "Respond CONFIRMED only if the JSON.parse runs in a server handler, " +
      "production request path, or long-running process, AND there is NO try/catch " +
      "anywhere in the enclosing function, AND the input comes from an untrusted " +
      "source (user request, external API, file uploaded by users).",
    cwe: "CWE-754",
    fix_template:
      "Wrap in try/catch: try { const obj = JSON.parse(data); } catch (e) { /* handle */ }",
  },
  {
    id: "js-015-promise-no-catch",
    title: "Promise chain without .catch() (unhandled rejection)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /\.then\s*\([^)]+\)\s*(?:;|\n)(?!\s*\.catch)/g,
    explanation:
      "A Promise .then() chain without .catch() leads to unhandled promise rejections. In Node.js, unhandled rejections crash the process by default.",
    verify_prompt:
      "Does this promise chain have a .catch() handler anywhere in the chain? " +
      "If there's a .catch() further down, or it's inside an async function with try/catch, " +
      "respond FALSE_POSITIVE. If no error handler exists, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template:
      "Add .catch(err => { /* handle */ }) at the end of the chain, or use async/await with try/catch.",
  },
  {
    id: "js-016-open-redirect",
    title: "window.location set from user input (open redirect)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex:
      /(?:window\.location|location\.href|location\.assign|location\.replace)\s*(?:=|\()\s*(?:req\.|params\.|query\.|input|user|data|url)/g,
    explanation:
      "Setting window.location from user-controlled input enables open redirect attacks. An attacker can craft a URL that redirects users to a phishing site.",
    verify_prompt:
      "Is the redirect URL from user/external input? If the URL is hardcoded or " +
      "validated against an allowlist of domains, respond FALSE_POSITIVE. " +
      "If user controls the full URL, respond CONFIRMED.",
    cwe: "CWE-601",
    fix_template:
      "Validate redirect URL against allowlist: const allowed = ['/dashboard', '/home']; if (allowed.includes(url)) location.href = url;",
  },
  {
    id: "js-017-hardcoded-secret-inline",
    title: "Hardcoded secret or API key in JavaScript/TypeScript",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex:
      /(?:api[_-]?key|api[_-]?secret|auth[_-]?token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}["']/gi,
    explanation:
      "Hardcoded API keys and secrets in source code are exposed in git history, build artifacts, and client-side bundles. They can be extracted and abused.",
    verify_prompt:
      "Is this a REAL API key/secret or a placeholder/test value (e.g. 'test-key', " +
      "'your-api-key-here', 'sk-test-...')? If it looks like a real credential, " +
      "respond CONFIRMED. If placeholder or test, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Use process.env.API_KEY or a secrets manager. Never commit real keys.",
  },
  {
    id: "js-018-document-write",
    title: "document.write() usage (XSS vector, performance issue)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /\bdocument\.write(?:ln)?\s*\(/g,
    explanation:
      "document.write() can inject arbitrary HTML/scripts into the page. Called after page load, it replaces the entire document. It's both an XSS vector and a performance anti-pattern.",
    verify_prompt:
      "Is the argument to document.write() from user/external input? If entirely " +
      "hardcoded (e.g. analytics snippet), respond FALSE_POSITIVE. If dynamic " +
      "content or if called after DOMContentLoaded, respond CONFIRMED.",
    cwe: "CWE-79",
    fix_template:
      "Use DOM APIs: document.createElement() + appendChild(), or element.textContent for text.",
  },
];
