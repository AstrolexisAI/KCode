// KCode - Express framework pack (P2.3, v2.10.391)
//
// Express-specific bug shapes complementing the existing
// express-001-nosql-injection, express-002-xss-render,
// express-003-cors-wildcard in framework.ts. Same `pack: "web"`
// tag.

import type { BugPattern } from "../types";

export const EXPRESS_PATTERNS: BugPattern[] = [
  {
    id: "express-004-eval-of-req",
    title: "eval / new Function on req.body / req.query / req.params — RCE",
    severity: "critical",
    languages: ["javascript", "typescript"],
    pack: "web",
    regex: /\b(?:eval|Function|new\s+Function)\s*\(\s*(?:[^)]*?\breq\.(?:body|query|params|cookies|headers))/g,
    explanation:
      "eval() or `new Function()` over request input gives the caller arbitrary JavaScript execution in your Node process. Even when the surrounding code 'sanitizes' (by stripping characters, by checking against a regex), the patterns are bypass-able and the cost of getting it wrong is RCE. There is no scenario where this is the right primitive.",
    verify_prompt:
      "Is the eval / Function arg actually attacker-reachable?\n" +
      "1. The expression includes req.body / req.query / req.params / req.cookies / req.headers — CONFIRMED.\n" +
      "2. The req.* value is whitelisted against a fixed allowlist BEFORE the eval — borderline; FALSE_POSITIVE only if the allowlist is hard-coded and limited.\n" +
      "3. The pattern is in a fixture / unit test clearly marked — FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template:
      "Replace eval with explicit parsing. If the input is JSON, use JSON.parse with a Pydantic-style validator (zod, joi, ajv). If it's a math expression, use a safe library like mathjs.evaluate(). If it's a code expression — DON'T accept code as input.",
  },
  {
    id: "express-005-default-session-secret",
    title: "express-session with hardcoded / placeholder secret",
    severity: "critical",
    languages: ["javascript", "typescript"],
    pack: "web",
    // session({ secret: '<short literal>' }) where the literal is too
    // short or matches well-known placeholders.
    regex: /\bsession\s*\(\s*\{[^}]*?\bsecret\s*:\s*["'`](?:keyboard cat|changeme|secret|change\s*me|placeholder|your-secret-here|default|test|dev|admin|password|[\w-]{1,16})["'`]/gi,
    explanation:
      "express-session uses the secret to sign session cookies. A weak / hardcoded / well-known secret means anyone can forge a session cookie — log in as any user, escalate privileges, replay sessions. The 'keyboard cat' default from the docs ships in production thousands of times per year. The signing key should be at LEAST 32 bytes of entropy, loaded from a secrets manager.",
    verify_prompt:
      "Is the secret actually weak?\n" +
      "1. Literal is 'keyboard cat', 'changeme', 'secret', 'placeholder', or any short hand-typed string — CONFIRMED.\n" +
      "2. Secret is loaded from process.env.SESSION_SECRET (or similar env var) without a default — FALSE_POSITIVE.\n" +
      "3. Secret is loaded from env with a hardcoded fallback (`process.env.X || 'changeme'`) — CONFIRMED. The fallback ships when the env var is missing.",
    cwe: "CWE-798",
    fix_template:
      "Generate a 32-byte random secret (`openssl rand -hex 32`), store in a secrets manager, and load via `process.env.SESSION_SECRET`. Crash on startup if the env var is missing — never use a fallback.",
  },
  {
    id: "express-006-trust-proxy-true",
    title: "app.set('trust proxy', true) — IP spoofing via X-Forwarded-For",
    severity: "high",
    languages: ["javascript", "typescript"],
    pack: "web",
    regex: /\bapp\.set\s*\(\s*["']trust proxy["']\s*,\s*true\b/g,
    explanation:
      "Setting `trust proxy` to `true` makes Express trust ANY X-Forwarded-For value, allowing an attacker to spoof their IP address. This breaks rate limiting, geofencing, IP-based audit logs, and any deny-list. The fix is to set `trust proxy` to a specific number of hops or a list of trusted proxy IPs/CIDRs.",
    verify_prompt:
      "Is the value actually `true` (boolean / blanket trust)?\n" +
      "1. Set to `true` — CONFIRMED. Replace with the count of hops between Express and the public internet (1 for AWS ALB, 2 for ALB → CloudFront, etc.).\n" +
      "2. Set to a number, an array of IPs, or a function — FALSE_POSITIVE.",
    cwe: "CWE-348",
    fix_template:
      "Replace with the exact number of trusted proxies, e.g. `app.set('trust proxy', 1)` for single ALB / nginx, or `app.set('trust proxy', ['10.0.0.0/8', 'loopback'])` for explicit allowlist.",
  },
  {
    id: "express-007-cookie-no-secure-httponly",
    title: "res.cookie for auth-shape value without httpOnly+secure",
    severity: "high",
    languages: ["javascript", "typescript"],
    pack: "web",
    // res.cookie('session'/'token'/'auth'/'jwt', value, OPTIONS) where
    // OPTIONS doesn't contain httpOnly: true. We match the FIRST 200
    // chars of the call to keep the regex tractable.
    regex: /\bres\.cookie\s*\(\s*["'`]\w*(?:session|token|auth|jwt|sid|sess)\w*["'`][^)]{0,200}\)/gi,
    explanation:
      "Auth-bearing cookies (session, token, JWT) without httpOnly are readable by any XSS — an injected script can exfiltrate them via document.cookie. Without `secure: true` the cookie travels over HTTP, exposing the value to any on-path attacker (Wi-Fi, ISP, MITM). Both flags are non-optional for any cookie that grants auth.",
    verify_prompt:
      "Does the options object contain httpOnly: true AND secure: true?\n" +
      "1. Both httpOnly: true AND secure: true present — FALSE_POSITIVE.\n" +
      "2. Only one of the two present — CONFIRMED.\n" +
      "3. Neither flag set — CONFIRMED.\n" +
      "4. The cookie is non-auth (preference, theme, locale) and the name happens to contain one of the matched substrings — borderline; mark NEEDS_CONTEXT.",
    cwe: "CWE-1004",
    fix_template:
      "Add `{ httpOnly: true, secure: true, sameSite: 'strict' }` (or 'lax' for OAuth flows) to the options object. In dev mode, set secure conditional on `process.env.NODE_ENV === 'production'`.",
  },
];
