// P2.3 (v2.10.391) — Express + Django framework pack tests.

import { describe, expect, test } from "bun:test";
import { DJANGO_PATTERNS } from "./django";
import { EXPRESS_PATTERNS } from "./express";

function findIn<T extends { id: string; regex: RegExp }>(set: T[], id: string): T {
  const p = set.find((x) => x.id === id);
  if (!p) throw new Error(`Pattern not found: ${id}`);
  return p;
}

function matchAll(p: { regex: RegExp }, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  p.regex.lastIndex = 0;
  const re = new RegExp(p.regex.source, p.regex.flags);
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    out.push(m);
    if (!re.global) break;
    m = re.exec(text);
  }
  return out;
}

// ─── Express ─────────────────────────────────────────────────────

describe("express-004-eval-of-req", () => {
  const p = findIn(EXPRESS_PATTERNS, "express-004-eval-of-req");
  test("flags eval(req.body.code)", () => {
    expect(matchAll(p, "eval(req.body.code)").length).toBe(1);
  });
  test("flags new Function(req.query.expr)", () => {
    expect(matchAll(p, "new Function(req.query.expr)").length).toBe(1);
  });
  test("does NOT flag eval('1 + 1')", () => {
    expect(matchAll(p, "eval('1 + 1')").length).toBe(0);
  });
});

describe("express-005-default-session-secret", () => {
  const p = findIn(EXPRESS_PATTERNS, "express-005-default-session-secret");
  test("flags session({ secret: 'keyboard cat' })", () => {
    const code = `app.use(session({ secret: 'keyboard cat', resave: false }));`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags session({ secret: 'changeme' })", () => {
    const code = `session({ secret: 'changeme' })`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags short literal secret", () => {
    const code = `session({ secret: 'abc' })`;
    expect(matchAll(p, code).length).toBe(1);
  });
});

describe("express-006-trust-proxy-true", () => {
  const p = findIn(EXPRESS_PATTERNS, "express-006-trust-proxy-true");
  test("flags app.set('trust proxy', true)", () => {
    expect(matchAll(p, `app.set("trust proxy", true)`).length).toBe(1);
    expect(matchAll(p, `app.set('trust proxy', true)`).length).toBe(1);
  });
  test("does NOT flag app.set('trust proxy', 1)", () => {
    expect(matchAll(p, `app.set('trust proxy', 1)`).length).toBe(0);
  });
});

describe("express-007-cookie-no-secure-httponly", () => {
  const p = findIn(EXPRESS_PATTERNS, "express-007-cookie-no-secure-httponly");
  test("flags res.cookie('session', value)", () => {
    const code = `res.cookie("session", token);`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags res.cookie('jwt', value, { maxAge: 1000 })", () => {
    const code = `res.cookie('jwt', token, { maxAge: 86400 });`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag res.cookie('theme', value, ...)", () => {
    const code = `res.cookie("theme", "dark");`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

// ─── Django ──────────────────────────────────────────────────────

describe("django-004-csrf-exempt", () => {
  const p = findIn(DJANGO_PATTERNS, "django-004-csrf-exempt");
  test("flags @csrf_exempt", () => {
    const code = `@csrf_exempt
def webhook(request):
    return HttpResponse("ok")`;
    expect(matchAll(p, code).length).toBe(1);
  });
});

describe("django-005-debug-true-in-settings", () => {
  const p = findIn(DJANGO_PATTERNS, "django-005-debug-true-in-settings");
  test("flags DEBUG = True at module top", () => {
    const code = `DEBUG = True`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag DEBUG = os.environ.get('DEBUG') == 'True'", () => {
    const code = `DEBUG = os.environ.get('DEBUG') == 'True'`;
    expect(matchAll(p, code).length).toBe(0);
  });
  test("does NOT flag DEBUG_TOOLBAR = True", () => {
    const code = `DEBUG_TOOLBAR = True`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("django-006-allowed-hosts-wildcard", () => {
  const p = findIn(DJANGO_PATTERNS, "django-006-allowed-hosts-wildcard");
  test("flags ALLOWED_HOSTS = ['*']", () => {
    expect(matchAll(p, `ALLOWED_HOSTS = ['*']`).length).toBe(1);
  });
  test("flags ALLOWED_HOSTS = ['app.example.com', '*']", () => {
    expect(matchAll(p, `ALLOWED_HOSTS = ['app.example.com', '*']`).length).toBe(1);
  });
  test("does NOT flag ALLOWED_HOSTS = ['app.example.com']", () => {
    expect(matchAll(p, `ALLOWED_HOSTS = ['app.example.com']`).length).toBe(0);
  });
});

describe("django-007-eval-of-request", () => {
  const p = findIn(DJANGO_PATTERNS, "django-007-eval-of-request");
  test("flags eval(request.GET['expr'])", () => {
    const code = `result = eval(request.GET['expr'])`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags exec(request.POST.get('code'))", () => {
    const code = `exec(request.POST.get('code'))`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag eval(safe_constant)", () => {
    const code = `eval('1 + 1')`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

// ─── Pack invariants ─────────────────────────────────────────────

describe("EXPRESS_PATTERNS invariants", () => {
  test("every pattern has pack='web' + a CWE + JS/TS lang", () => {
    for (const p of EXPRESS_PATTERNS) {
      expect(p.pack).toBe("web");
      expect(p.cwe).toBeTruthy();
      const langs = p.languages as string[];
      expect(langs.includes("javascript") || langs.includes("typescript")).toBe(true);
    }
  });
  test("ids are unique and prefixed", () => {
    const ids = EXPRESS_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("express-")).toBe(true);
  });
});

describe("DJANGO_PATTERNS invariants", () => {
  test("every pattern has pack='web' + a CWE + python lang", () => {
    for (const p of DJANGO_PATTERNS) {
      expect(p.pack).toBe("web");
      expect(p.cwe).toBeTruthy();
      expect(p.languages).toContain("python");
    }
  });
  test("ids are unique and prefixed", () => {
    const ids = DJANGO_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("django-")).toBe(true);
  });
});
