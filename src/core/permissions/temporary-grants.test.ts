// Tests for temporary permission grants

import { describe, test, expect, beforeEach } from "bun:test";
import { TemporaryGrants } from "./temporary-grants";

describe("TemporaryGrants", () => {
  let grants: TemporaryGrants;

  beforeEach(() => {
    grants = new TemporaryGrants();
  });

  test("grant stores permission", () => {
    grants.grant("Bash", "allow");
    const listed = grants.list();
    expect(listed.length).toBe(1);
    expect(listed[0].toolName).toBe("Bash");
    expect(listed[0].action).toBe("allow");
  });

  test("check returns grant for matching tool", () => {
    grants.grant("Bash", "allow", { reason: "trusted" });
    const result = grants.check("Bash");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("allow");
    expect(result!.reason).toBe("trusted");
  });

  test("check returns null for unmatched tool", () => {
    grants.grant("Bash", "allow");
    const result = grants.check("Write");
    expect(result).toBeNull();
  });

  test("check removes expired grants", () => {
    // Grant that expired 100ms ago
    grants.grant("Bash", "allow", { duration: 1 });
    // Wait a tiny bit to ensure expiry
    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin
    }
    const result = grants.check("Bash");
    expect(result).toBeNull();
    // Should also be removed from list
    expect(grants.list().length).toBe(0);
  });

  test("revoke removes specific grant", () => {
    grants.grant("Bash", "allow");
    grants.grant("Write", "deny");
    const removed = grants.revoke("Bash");
    expect(removed).toBe(true);
    expect(grants.check("Bash")).toBeNull();
    expect(grants.check("Write")).not.toBeNull();
  });

  test("revoke returns false for nonexistent grant", () => {
    const removed = grants.revoke("NonExistent");
    expect(removed).toBe(false);
  });

  test("revokeAll clears everything", () => {
    grants.grant("Bash", "allow");
    grants.grant("Write", "deny");
    grants.grant("Read", "allow");
    grants.revokeAll();
    expect(grants.list().length).toBe(0);
    expect(grants.check("Bash")).toBeNull();
    expect(grants.check("Write")).toBeNull();
    expect(grants.check("Read")).toBeNull();
  });

  test("list returns active grants", () => {
    grants.grant("Bash", "allow", { reason: "r1" });
    grants.grant("Write", "deny", { reason: "r2" });
    const listed = grants.list();
    expect(listed.length).toBe(2);
    expect(listed.map((g) => g.toolName).sort()).toEqual(["Bash", "Write"]);
  });

  test("field-level grants work", () => {
    grants.grant("Bash", "allow", { fieldMatch: "git*" });
    // Should match when input contains a git command
    const result = grants.check("Bash", { command: "git status" });
    expect(result).not.toBeNull();
    expect(result!.action).toBe("allow");

    // Should NOT match non-git commands at tool level (no tool-level grant)
    const result2 = grants.check("Bash", { command: "rm -rf /" });
    expect(result2).toBeNull();
  });

  test("field-level grants take precedence over tool-level", () => {
    grants.grant("Bash", "allow"); // tool-level: allow
    grants.grant("Bash", "deny", { fieldMatch: "rm*" }); // field-level: deny rm

    // rm command should be denied (field-level match)
    const result = grants.check("Bash", { command: "rm -rf /" });
    expect(result).not.toBeNull();
    expect(result!.action).toBe("deny");

    // git command should be allowed (falls through to tool-level)
    const result2 = grants.check("Bash", { command: "git status" });
    expect(result2).not.toBeNull();
    expect(result2!.action).toBe("allow");
  });

  test("cleanup removes expired entries", () => {
    grants.grant("Bash", "allow", { duration: 1 });
    grants.grant("Write", "allow"); // no expiry (Infinity)
    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin to ensure expiry
    }
    const removed = grants.cleanup();
    expect(removed).toBe(1);
    expect(grants.list().length).toBe(1);
    expect(grants.list()[0].toolName).toBe("Write");
  });

  test("duration-based expiry works", () => {
    grants.grant("Bash", "allow", { duration: 50 });
    // Immediately should be active
    expect(grants.check("Bash")).not.toBeNull();
    // After expiry should be null
    const start = Date.now();
    while (Date.now() - start < 60) {
      // spin
    }
    expect(grants.check("Bash")).toBeNull();
  });

  test("default duration is Infinity (session lifetime)", () => {
    grants.grant("Bash", "allow");
    const listed = grants.list();
    expect(listed[0].expiresAt).toBe(Infinity);
  });

  test("revoke also removes field-level grants for the tool", () => {
    grants.grant("Bash", "allow");
    grants.grant("Bash", "deny", { fieldMatch: "rm*" });
    grants.revoke("Bash");
    expect(grants.list().length).toBe(0);
  });
});
