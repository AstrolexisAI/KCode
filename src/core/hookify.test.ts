// Hookify — YAML frontmatter parser tests.
//
// Focus: prototype pollution defense. Rule files come from plugins,
// the marketplace, and user-authored files — any of which can be
// attacker-controlled. A frontmatter key like `__proto__: {…}` would
// previously write to Object.prototype via `meta[key] = …` on a
// plain `{}` object. These tests pin down that reserved keys are
// silently dropped and that normal parsing still works.

import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./hookify";

describe("hookify parseFrontmatter — prototype pollution", () => {
  // Core invariant: after parsing any attacker-crafted frontmatter,
  // a brand-new object literal `{}` must NOT have any attacker-
  // injected properties. That's the real blast radius of a
  // prototype pollution and the only assertion that matters. We
  // deliberately avoid `toHaveProperty("__proto__")` because that
  // walks the prototype chain and `__proto__` is always present.

  function ownKeys(o: object): string[] {
    return Object.getOwnPropertyNames(o);
  }

  test("__proto__: scalar value does not pollute Object.prototype", () => {
    const md = `---
name: malicious
__proto__: polluted_via_scalar
---
body`;
    const parsed = parseFrontmatter(md)!;
    expect(parsed).not.toBeNull();
    // No new property appeared on a fresh {}.
    expect(({} as Record<string, unknown>).polluted_via_scalar).toBeUndefined();
    // The reserved key is NOT an own property of meta.
    expect(ownKeys(parsed.meta)).not.toContain("__proto__");
    // Non-reserved sibling key still parses.
    expect(parsed.meta.name).toBe("malicious");
  });

  test("constructor key in frontmatter is dropped as an own key", () => {
    const md = `---
name: malicious
constructor: hijacked
---
body`;
    const parsed = parseFrontmatter(md)!;
    expect(ownKeys(parsed.meta)).not.toContain("constructor");
    // The prototype-chain `constructor` is still the real Object.
    expect(parsed.meta.constructor).toBe(Object.prototype.constructor);
    expect(parsed.meta.name).toBe("malicious");
  });

  test("prototype key is dropped", () => {
    const md = `---
name: rule
prototype: evil
---
body`;
    const parsed = parseFrontmatter(md)!;
    expect(ownKeys(parsed.meta)).not.toContain("prototype");
    expect(parsed.meta.name).toBe("rule");
  });

  test("__proto__ as an array key does not pollute and sibling keys still parse", () => {
    const md = `---
__proto__:
  - field: evil
    operator: equals
    pattern: x
name: still_fine
---
body`;
    const parsed = parseFrontmatter(md)!;
    expect(ownKeys(parsed.meta)).not.toContain("__proto__");
    // Confirm no pollution leaked to Object.prototype.
    expect(({} as Record<string, unknown>).field).toBeUndefined();
    expect(parsed.meta.name).toBe("still_fine");
  });
});

describe("hookify parseFrontmatter — normal parsing still works", () => {
  test("parses basic scalar frontmatter", () => {
    const md = `---
name: my-rule
enabled: true
event: bash
action: warn
---
message body here`;
    const parsed = parseFrontmatter(md)!;
    expect(parsed.meta.name).toBe("my-rule");
    expect(parsed.meta.enabled).toBe(true);
    expect(parsed.meta.event).toBe("bash");
    expect(parsed.meta.action).toBe("warn");
    expect(parsed.body).toBe("message body here");
  });

  test("parses condition arrays", () => {
    const md = `---
name: test
conditions:
  - field: command
    operator: contains
    pattern: rm
---
body`;
    const parsed = parseFrontmatter(md)!;
    expect(Array.isArray(parsed.meta.conditions)).toBe(true);
    const conds = parsed.meta.conditions as Array<Record<string, string>>;
    expect(conds[0]!.field).toBe("command");
    expect(conds[0]!.operator).toBe("contains");
    expect(conds[0]!.pattern).toBe("rm");
  });

  test("returns null when no frontmatter block", () => {
    expect(parseFrontmatter("just a body")).toBeNull();
  });
});
