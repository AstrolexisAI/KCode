// Tests for the strcmp-family inversion detector.

import { afterEach, describe, expect, test } from "bun:test";
import { detectStrcmpInversion } from "./semantic-guards";

describe("detectStrcmpInversion", () => {
  afterEach(() => {
    delete process.env.KCODE_SEMANTIC_GUARDS;
  });

  test("blocks adding ! before wcscmp (the NASA IDF false positive)", () => {
    const old_string =
      `if (!serialNumber.empty() && wcscmp(serialNumber.c_str(), deviceInfo.serial_number)) {`;
    const new_string =
      `if (!serialNumber.empty() && !wcscmp(serialNumber.c_str(), deviceInfo.serial_number)) {`;
    const result = detectStrcmpInversion(old_string, new_string);
    expect(result).not.toBeNull();
    expect(result).toContain("SEMANTIC INVERSION");
    expect(result).toContain("strcmp/wcscmp/memcmp");
  });

  test("blocks adding ! before strcmp", () => {
    const old = `if (strcmp(resolvePath(path).c_str(), deviceInfo.path)) {`;
    const nw = `if (!strcmp(resolvePath(path).c_str(), deviceInfo.path)) {`;
    expect(detectStrcmpInversion(old, nw)).not.toBeNull();
  });

  test("blocks adding ! before memcmp", () => {
    const old = `return memcmp(a, b, n);`;
    const nw = `return !memcmp(a, b, n);`;
    expect(detectStrcmpInversion(old, nw)).not.toBeNull();
  });

  test("blocks adding ! before strncmp", () => {
    const old = `if (strncmp(s1, s2, 5)) { reject(); }`;
    const nw = `if (!strncmp(s1, s2, 5)) { reject(); }`;
    expect(detectStrcmpInversion(old, nw)).not.toBeNull();
  });

  test("blocks adding ! before strcasecmp", () => {
    const old = `if (strcasecmp(a, b)) continue;`;
    const nw = `if (!strcasecmp(a, b)) continue;`;
    expect(detectStrcmpInversion(old, nw)).not.toBeNull();
  });

  test("allows converting cmp(...) == 0 to !cmp(...) (same semantics)", () => {
    const old = `if (strcmp(a, b) == 0) { return; }`;
    const nw = `if (!strcmp(a, b)) { return; }`;
    expect(detectStrcmpInversion(old, nw)).toBeNull();
  });

  test("allows removing ! from !cmp(...) (new has FEWER)", () => {
    const old = `if (!strcmp(a, b)) { return; }`;
    const nw = `if (strcmp(a, b) == 0) { return; }`;
    expect(detectStrcmpInversion(old, nw)).toBeNull();
  });

  test("allows unrelated edits that don't touch strcmp", () => {
    const old = `int x = 1;`;
    const nw = `int x = 2;`;
    expect(detectStrcmpInversion(old, nw)).toBeNull();
  });

  test("allows edits that preserve strcmp calls unchanged", () => {
    const old = `if (strcmp(a, b)) { int x = 1; }`;
    const nw = `if (strcmp(a, b)) { int x = 2; }`;
    expect(detectStrcmpInversion(old, nw)).toBeNull();
  });

  test("allows adding a new strcmp call without !", () => {
    const old = `int x = 1;`;
    const nw = `int x = 1; if (strcmp(a, b)) return;`;
    expect(detectStrcmpInversion(old, nw)).toBeNull();
  });

  test("blocks when multiple !cmp calls are added", () => {
    const old = `if (strcmp(a, b) || wcscmp(c, d)) { }`;
    const nw = `if (!strcmp(a, b) || !wcscmp(c, d)) { }`;
    const result = detectStrcmpInversion(old, nw);
    expect(result).not.toBeNull();
    expect(result).toContain("2 strcmp/wcscmp/memcmp call(s)");
  });

  test("does NOT block when old has cmp==0 and new has !cmp (equivalent forms)", () => {
    const old = `if (strcmp(a, b) == 0 && wcscmp(c, d) == 0) { }`;
    const nw = `if (!strcmp(a, b) && !wcscmp(c, d)) { }`;
    expect(detectStrcmpInversion(old, nw)).toBeNull();
  });

  test("DOES block mixed case — one inversion with cmp==0 available", () => {
    // Only one cmp==0 in old but two new !cmp — net added 1 semantic inversion
    const old = `if (strcmp(a, b) == 0 && wcscmp(c, d)) { }`;
    const nw = `if (!strcmp(a, b) && !wcscmp(c, d)) { }`;
    const result = detectStrcmpInversion(old, nw);
    expect(result).not.toBeNull();
  });

  test("KCODE_SEMANTIC_GUARDS=off disables the guard", () => {
    process.env.KCODE_SEMANTIC_GUARDS = "off";
    const old = `if (wcscmp(a, b)) reject();`;
    const nw = `if (!wcscmp(a, b)) reject();`;
    expect(detectStrcmpInversion(old, nw)).toBeNull();
  });
});
