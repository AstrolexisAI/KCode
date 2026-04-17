// KCode - FRAMEWORK Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const FRAMEWORK_PATTERNS: BugPattern[] = [
  // Django
  {
    id: "django-001-raw-sql",
    title: "Django raw SQL with string formatting",
    severity: "critical",
    languages: ["python"],
    regex: /\b(?:raw|extra)\s*\(\s*(?:f["']|["'].*%|["'].*\.format)/g,
    explanation: "Django raw()/extra() with string formatting bypasses ORM protections → SQL injection.",
    verify_prompt: "Check ALL: 1. Is this using Django's parameterized form raw(sql, [params])? → FP. 2. Is user input interpolated? Only CONFIRMED if untrusted input is formatted into SQL." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. Parameterized queries are used: raw('SELECT ... WHERE id = %s', [param])\n" +
      "2. The interpolated values are integer IDs from validated/internal sources\n" +
      "3. The query is constructed from trusted constants only (no user input)\n" +
      "4. This is in test/migration code with no user-facing input path\n" +
      "Only respond CONFIRMED if untrusted user input is string-formatted into the SQL query.",
    cwe: "CWE-89",
    fix_template: "Use Model.objects.raw('SELECT * FROM t WHERE id = %s', [user_id])",
  },
  {
    id: "django-002-mark-safe",
    title: "mark_safe() with dynamic content (XSS)",
    severity: "high",
    languages: ["python"],
    regex: /\bmark_safe\s*\(\s*(?:f["']|.*\+|.*\.format|.*%)/g,
    explanation: "mark_safe() tells Django to NOT escape HTML. With dynamic content → XSS.",
    verify_prompt: "Is the argument entirely hardcoded HTML? → FP. Does it include ANY user input? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The argument is entirely hardcoded HTML with no dynamic content\n" +
      "2. The dynamic content is already escaped via django.utils.html.escape() before mark_safe()\n" +
      "3. The content comes from a trusted admin-only source (CMS managed by staff)\n" +
      "4. This is in test or documentation code\n" +
      "Only respond CONFIRMED if user-controlled input is included without escaping.",
    cwe: "CWE-79",
    fix_template: "Use format_html() instead: format_html('<b>{}</b>', user_input)",
  },
  {
    id: "django-003-secret-key",
    title: "Django SECRET_KEY hardcoded in settings",
    severity: "high",
    languages: ["python"],
    regex: /SECRET_KEY\s*=\s*["'][A-Za-z0-9!@#$%^&*]{20,}["']/g,
    explanation: "Hardcoded SECRET_KEY in settings.py. If leaked, session forgery + CSRF bypass.",
    verify_prompt: "Is this in a test/example file? → FP. Is it in production settings? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. This is in a test, example, or template file (not production settings)\n" +
      "2. The value is a placeholder ('changeme', 'your-secret-key-here', 'TODO')\n" +
      "3. The SECRET_KEY is loaded from environment variable with a hardcoded fallback for dev only\n" +
      "4. This is in a settings file explicitly marked as local/development\n" +
      "Only respond CONFIRMED if a real secret key is hardcoded in production settings.",
    cwe: "CWE-798",
    fix_template: "SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY')",
  },
  // Express/Node.js
  {
    id: "express-001-nosql-injection",
    title: "Express MongoDB query with req.body (NoSQL injection)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\b(?:find|findOne|updateOne|deleteOne)\s*\(\s*(?:req\.body|req\.query|req\.params)/g,
    explanation: "Passing req.body directly to MongoDB enables NoSQL injection ($gt, $ne operators).",
    verify_prompt: "Is req.body passed directly without type validation/casting? → CONFIRMED. Is input validated/cast first? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. Input fields are explicitly cast/validated (String(), Number(), mongoose schema validation)\n" +
      "2. A validation middleware (joi, zod, express-validator) runs before this handler\n" +
      "3. Only specific scalar fields are extracted (not the entire req.body object)\n" +
      "4. This is in test code with controlled input\n" +
      "Only respond CONFIRMED if req.body/req.query/req.params is passed directly to a MongoDB query without type validation.",
    cwe: "CWE-943",
    fix_template: "Validate and cast: { email: String(req.body.email) }",
  },
  {
    id: "express-002-xss-render",
    title: "Rendering user input without escaping",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /res\.send\s*\(\s*(?:req\.|`.*\$\{req\.)/g,
    explanation: "Sending user input directly in response without escaping → reflected XSS.",
    verify_prompt: "Is the response HTML with user input interpolated? → CONFIRMED. Is it JSON or escaped? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The response is JSON (res.json()) not HTML\n" +
      "2. The output is already escaped/sanitized before being sent\n" +
      "3. The content comes from a trusted admin-only source\n" +
      "4. Content-Type is set to text/plain (not text/html)\n" +
      "Only respond CONFIRMED if user input is interpolated into an HTML response without escaping.",
    cwe: "CWE-79",
    fix_template: "Use a template engine with auto-escaping, or escape: require('he').encode(input)",
  },
  {
    id: "express-003-cors-wildcard",
    title: "CORS with origin: '*' and credentials",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /cors\s*\(\s*\{[^}]*origin\s*:\s*(?:true|["']\*["'])/g,
    explanation: "CORS with wildcard origin allows any site to make authenticated requests.",
    verify_prompt: "Is credentials: true also set? → CONFIRMED. Is this a public API without auth? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. This is a public API that requires no authentication (no cookies/sessions)\n" +
      "2. credentials is not set or is set to false\n" +
      "3. This is a local development configuration not used in production\n" +
      "4. The wildcard origin is in a development-only code path (e.g., if (isDev))\n" +
      "Only respond CONFIRMED if origin '*' is combined with credentials: true in production code.",
    cwe: "CWE-942",
    fix_template: "Whitelist specific origins: origin: ['https://myapp.com']",
  },
  // React/Next.js
  {
    id: "react-001-dangerously-set",
    title: "dangerouslySetInnerHTML with dynamic content",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!["'`]\s*[}])/g,
    explanation: "dangerouslySetInnerHTML bypasses React's XSS protection. With dynamic content → XSS.",
    verify_prompt: "Is __html a hardcoded constant? → FP. Does it include ANY user/external data? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The __html value is a hardcoded constant string\n" +
      "2. The content is sanitized with DOMPurify or a similar sanitizer before use\n" +
      "3. The content comes from a trusted admin-only CMS source\n" +
      "4. This is in test or storybook code with controlled input\n" +
      "Only respond CONFIRMED if user-controlled or external data is set as __html without sanitization.",
    cwe: "CWE-79",
    fix_template: "Use DOMPurify: { __html: DOMPurify.sanitize(content) }",
  },
  // Flask
  {
    id: "flask-001-render-string",
    title: "Flask render_template_string with user input (SSTI)",
    severity: "critical",
    languages: ["python"],
    regex: /\brender_template_string\s*\(\s*(?:request\.|f["']|.*\+|.*\.format|.*%)/g,
    explanation: "render_template_string() with user input enables Server-Side Template Injection → RCE.",
    verify_prompt: "Is the template string from user input? → CONFIRMED. Is it hardcoded? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The template string is hardcoded (no user input in the template itself)\n" +
      "2. User input is passed only as template variables (not as part of the template string)\n" +
      "3. This is in test or documentation code\n" +
      "4. The template string comes from a trusted internal source (admin config)\n" +
      "Only respond CONFIRMED if user-controlled input is part of the template string itself (not just template variables).",
    cwe: "CWE-1336",
    fix_template: "Use render_template() with a .html file instead of render_template_string().",
  },
  // FastAPI
  {
    id: "fastapi-001-sql-raw",
    title: "FastAPI with raw SQL string formatting",
    severity: "critical",
    languages: ["python"],
    regex: /\b(?:execute|text)\s*\(\s*(?:f["']|["'].*\{)/g,
    explanation: "Raw SQL with f-strings in FastAPI/SQLAlchemy bypasses parameterized queries.",
    verify_prompt: "Is this using text() with :param placeholders? → FP. Is user input in f-string? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. Parameterized queries are used: text('... WHERE id = :id').bindparams(id=val)\n" +
      "2. The interpolated values are integer IDs from validated/internal sources\n" +
      "3. The query is constructed from trusted constants only (table names, column names)\n" +
      "4. This is in test/migration code with no user-facing input path\n" +
      "Only respond CONFIRMED if untrusted user input is string-formatted into the SQL query.",
    cwe: "CWE-89",
    fix_template: "Use text('SELECT * FROM t WHERE id = :id').bindparams(id=user_id)",
  },
  // Rails
  {
    id: "rails-001-html-safe",
    title: "Rails .html_safe on user content (XSS)",
    severity: "high",
    languages: ["ruby"],
    regex: /\.html_safe\b/g,
    explanation: ".html_safe tells Rails to skip HTML escaping. On user content → XSS.",
    verify_prompt: "Is the string entirely hardcoded/internal? → FP. Could it contain user input? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The string is entirely hardcoded HTML (e.g., '<br>'.html_safe)\n" +
      "2. The content is already sanitized with sanitize() or ERB::Util.html_escape before .html_safe\n" +
      "3. The content comes from a trusted admin-only source\n" +
      "4. This is in test, helper, or view code rendering only internal/static content\n" +
      "Only respond CONFIRMED if user-controlled content could reach .html_safe without prior escaping.",
    cwe: "CWE-79",
    fix_template: "Use sanitize() helper: sanitize(user_content, tags: %w[b i em])",
  },
];
