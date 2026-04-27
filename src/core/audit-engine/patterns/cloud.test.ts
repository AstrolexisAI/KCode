// P2.1 (v2.10.389) — cloud pack regression tests.
//
// Each test asserts:
//   - The positive fixture matches at least once.
//   - The negative fixture does NOT match.
// This is the same shape used for ai-ml.test.ts and locks in
// precision invariants. The benchmark separately measures recall
// against the wider corpus.

import { describe, expect, test } from "bun:test";
import { CLOUD_PATTERNS } from "./cloud";

function findPattern(id: string) {
  const p = CLOUD_PATTERNS.find((x) => x.id === id);
  if (!p) throw new Error(`Pattern not found: ${id}`);
  return p;
}

function matchAll(p: { regex: RegExp }, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  // Reset lastIndex so global regexes don't carry state across tests.
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

describe("cloud-001-iam-wildcard-action", () => {
  const p = findPattern("cloud-001-iam-wildcard-action");
  test("flags Action = \"*\" in tf policy", () => {
    const tf = `data "aws_iam_policy_document" "p" {
  statement {
    actions = ["*"]
    resources = ["*"]
  }
}`;
    expect(matchAll(p, tf).length).toBeGreaterThanOrEqual(1);
  });
  test("flags single Action = \"*\" form", () => {
    const tf = `Action = "*"`;
    expect(matchAll(p, tf).length).toBe(1);
  });
  test("does NOT flag scoped action list", () => {
    const tf = `actions = ["s3:GetObject", "s3:PutObject"]`;
    expect(matchAll(p, tf).length).toBe(0);
  });
});

describe("cloud-002-tf-public-s3", () => {
  const p = findPattern("cloud-002-tf-public-s3");
  test("flags acl = public-read", () => {
    const tf = `resource "aws_s3_bucket" "b" { acl = "public-read" }`;
    expect(matchAll(p, tf).length).toBe(1);
  });
  test("flags acl = public-read-write", () => {
    const tf = `acl = "public-read-write"`;
    expect(matchAll(p, tf).length).toBe(1);
  });
  test("does NOT flag acl = private", () => {
    const tf = `acl = "private"`;
    expect(matchAll(p, tf).length).toBe(0);
  });
});

describe("cloud-003-k8s-privileged-container", () => {
  const p = findPattern("cloud-003-k8s-privileged-container");
  test("flags privileged: true", () => {
    const yaml = `apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    securityContext:
      privileged: true`;
    expect(matchAll(p, yaml).length).toBe(1);
  });
  test("does NOT flag privileged: false", () => {
    const yaml = `      privileged: false`;
    expect(matchAll(p, yaml).length).toBe(0);
  });
});

describe("cloud-004-k8s-host-network", () => {
  const p = findPattern("cloud-004-k8s-host-network");
  test("flags hostNetwork: true", () => {
    const yaml = `spec:
  hostNetwork: true
  containers: []`;
    expect(matchAll(p, yaml).length).toBe(1);
  });
  test("does NOT flag hostNetwork: false", () => {
    const yaml = `  hostNetwork: false`;
    expect(matchAll(p, yaml).length).toBe(0);
  });
});

describe("cloud-005-dockerfile-secret-arg", () => {
  const p = findPattern("cloud-005-dockerfile-secret-arg");
  test("flags ARG with secret-shaped value", () => {
    const dockerfile = `FROM alpine
ARG API_TOKEN=abc123def456ghi789jkl012`;
    expect(matchAll(p, dockerfile).length).toBe(1);
  });
  test("flags ARG SECRET=", () => {
    const dockerfile = `ARG DATABASE_PASSWORD=hunter2hunter2hunter2`;
    expect(matchAll(p, dockerfile).length).toBe(1);
  });
  test("does NOT flag ARG with env-var reference", () => {
    const dockerfile = `ARG API_KEY=\${BUILD_API_KEY}`;
    expect(matchAll(p, dockerfile).length).toBe(0);
  });
  test("does NOT flag ARG without =value", () => {
    const dockerfile = `ARG API_KEY`;
    expect(matchAll(p, dockerfile).length).toBe(0);
  });
});

describe("cloud-006-gha-third-party-no-sha", () => {
  const p = findPattern("cloud-006-gha-third-party-no-sha");
  test("flags third-party action pinned to a tag", () => {
    const yaml = `      uses: tj-actions/changed-files@v45`;
    expect(matchAll(p, yaml).length).toBe(1);
  });
  test("flags third-party action pinned to @main", () => {
    const yaml = `      uses: someuser/some-action@main`;
    expect(matchAll(p, yaml).length).toBe(1);
  });
  test("does NOT flag third-party action pinned to a 40-char SHA", () => {
    const yaml = `      uses: tj-actions/changed-files@a284dc1814e69619a5c41ff0e0a0e0e0a0e0e0e0`;
    expect(matchAll(p, yaml).length).toBe(0);
  });
  test("does NOT flag first-party actions/* references", () => {
    const yaml = `      uses: actions/checkout@v4
      uses: actions/setup-node@v5`;
    expect(matchAll(p, yaml).length).toBe(0);
  });
});

// ─── Pack invariants ─────────────────────────────────────────────

describe("CLOUD_PATTERNS pack invariants", () => {
  test("every pattern has pack='cloud'", () => {
    for (const p of CLOUD_PATTERNS) {
      expect(p.pack).toBe("cloud");
    }
  });
  test("every pattern has a CWE", () => {
    for (const p of CLOUD_PATTERNS) {
      expect(p.cwe).toBeTruthy();
    }
  });
  test("every pattern targets at least one IaC language", () => {
    const iacLangs = new Set(["yaml", "terraform", "dockerfile"]);
    for (const p of CLOUD_PATTERNS) {
      const hasIacLang = p.languages.some((l) => iacLangs.has(l as string));
      expect(hasIacLang).toBe(true);
    }
  });
  test("every pattern id is unique", () => {
    const ids = CLOUD_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("every pattern id has the cloud- prefix", () => {
    for (const p of CLOUD_PATTERNS) {
      expect(p.id.startsWith("cloud-")).toBe(true);
    }
  });
});
