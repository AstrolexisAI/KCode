// KCode - Django framework pack (P2.3, v2.10.391)
//
// Django-specific bug shapes complementing the existing
// django-001-raw-sql, django-002-mark-safe, django-003-secret-key
// in framework.ts. Same `pack: "web"` tag.

import type { BugPattern } from "../types";

export const DJANGO_PATTERNS: BugPattern[] = [
  {
    id: "django-004-csrf-exempt",
    title: "@csrf_exempt decorator — disables CSRF protection on the view",
    severity: "high",
    languages: ["python"],
    pack: "web",
    regex: /^\s*@csrf_exempt\b/gm,
    explanation:
      "Django's CSRF middleware blocks cross-site requests that don't carry the session's CSRF token. @csrf_exempt switches the protection OFF for that view, meaning a malicious cross-site form submission (`<form action=\"https://your.site/transfer\" method=\"post\">...</form>` on attacker.example) can perform the action with the victim's session cookies. Almost always shipped 'temporarily' to make a webhook work, then forgotten.",
    verify_prompt:
      "Is CSRF actually unnecessary for this view?\n" +
      "1. The view receives WEBHOOK calls from a known third party (Stripe, GitHub, Slack) AND verifies the request signature with the third party's secret — FALSE_POSITIVE; mention the signature check.\n" +
      "2. The view is a public unauthenticated endpoint (signin, robots.txt, healthz) — FALSE_POSITIVE.\n" +
      "3. The view is an authenticated mutation (creates/edits/deletes user data) — CONFIRMED. Re-enable CSRF or use DRF's SessionAuthentication which integrates with CSRF properly.",
    cwe: "CWE-352",
    fix_template:
      "If the view is a webhook, drop @csrf_exempt and verify the upstream signature instead (Stripe.Webhook.construct_event, hmac compare for github_signature, etc.). If the view truly is a public unauthenticated endpoint, document why with a comment so the next audit knows.",
  },
  {
    id: "django-005-debug-true-in-settings",
    title: "DEBUG = True in settings — leaks stack traces + queries to any visitor",
    severity: "critical",
    languages: ["python"],
    pack: "web",
    // Match `DEBUG = True` at module top-level. Restrict to settings-
    // shaped files via filename heuristic. Inline assignment in a
    // function or fixture won't trip this.
    regex: /^DEBUG\s*=\s*True\s*$/gm,
    explanation:
      "Django's debug page renders the full request, environment, settings (including SECRET_KEY when not Field()-protected), local variables, and the SQL query log on every unhandled exception — to whoever caused the exception, including remote attackers. Production deployments with DEBUG=True regularly leak credentials, internal hostnames, and database queries. The pattern is 'I'll set it from env later' followed by no follow-up.",
    verify_prompt:
      "Is the file a settings module that ships to production?\n" +
      "1. The file path contains 'settings.py' / 'settings/prod.py' / 'production.py' AND DEBUG = True is set unconditionally — CONFIRMED.\n" +
      "2. DEBUG is loaded from env: `DEBUG = os.environ.get('DEBUG') == 'True'` or similar — FALSE_POSITIVE.\n" +
      "3. The file is settings/dev.py / local.py / test.py and is excluded from production — FALSE_POSITIVE.\n" +
      "4. There's a guard: `if os.environ.get('ENV') != 'production': DEBUG = True` — borderline; FALSE_POSITIVE if the guard is reliable.",
    cwe: "CWE-489",
    fix_template:
      "Switch to `DEBUG = os.environ.get('DJANGO_DEBUG', '').lower() == 'true'` — env-controlled, defaults to False. Production deployments leave DJANGO_DEBUG unset; only dev sets it to 'true'.",
  },
  {
    id: "django-006-allowed-hosts-wildcard",
    title: "ALLOWED_HOSTS contains '*' — Host header injection",
    severity: "high",
    languages: ["python"],
    pack: "web",
    // Match ALLOWED_HOSTS = [..., '*', ...] in a settings-shaped file.
    regex: /^ALLOWED_HOSTS\s*=\s*\[[^\]]*["']\*["'][^\]]*\]/gm,
    explanation:
      "ALLOWED_HOSTS = ['*'] disables Django's Host-header validation. A malicious request with `Host: attacker.example` then leaks: password-reset links pointing at the attacker's domain (so reset emails route THERE), absolute URLs in the response, and CSRF cookies tied to the attacker's host. The wildcard is shipped as a 'just to make it work' fix and almost never gets tightened later.",
    verify_prompt:
      "Is the wildcard actually present in the production settings?\n" +
      "1. ALLOWED_HOSTS is set to ['*'] or contains '*' — CONFIRMED.\n" +
      "2. ALLOWED_HOSTS lists explicit domains — FALSE_POSITIVE.\n" +
      "3. The file is settings/dev.py and excluded from production — FALSE_POSITIVE.",
    cwe: "CWE-20",
    fix_template:
      "Replace with the explicit list of hostnames the app serves: `ALLOWED_HOSTS = ['app.example.com', 'www.example.com']`. For multi-tenant apps, generate the list from a config table at startup or use `django-allowedhosts` with a regex.",
  },
  {
    id: "django-007-eval-of-request",
    title: "eval / exec on request.GET / request.POST data",
    severity: "critical",
    languages: ["python"],
    pack: "web",
    regex: /\b(?:eval|exec|compile)\s*\(\s*[^)]*?\brequest\.(?:GET|POST|FILES|COOKIES|META)\b/g,
    explanation:
      "eval / exec / compile over request data is RCE in your Django process. Even when the surrounding code 'sanitizes' the input by character-stripping, the patterns are bypass-able and the cost of a miss is full server compromise. There is no scenario where this is the right primitive in a web request handler.",
    verify_prompt:
      "Is the eval/exec arg actually attacker-reachable?\n" +
      "1. Argument includes request.GET / request.POST / request.FILES / request.COOKIES / request.META — CONFIRMED.\n" +
      "2. Allowlist BEFORE eval and the allowlist is hardcoded + small — borderline; FALSE_POSITIVE only if the allowlist is exhaustive.\n" +
      "3. Pattern is in a fixture / test — FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template:
      "Replace eval with explicit parsing. For math expressions: `simpleeval` / `numexpr.evaluate` with a fixed variable list. For JSON: `json.loads` with a Pydantic-equivalent validator. For arbitrary code: don't accept code as input.",
  },
];
