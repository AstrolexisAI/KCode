import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSbom } from "./sbom";

function makeFixture(): { root: string; pkg: string; lock: string } {
  const root = mkdtempSync(join(tmpdir(), "kcode-sbom-test-"));
  const pkg = join(root, "package.json");
  const lock = join(root, "bun.lock");
  writeFileSync(
    pkg,
    JSON.stringify({
      name: "demo-app",
      version: "1.0.0",
      description: "fixture",
      license: "MIT",
      dependencies: { left: "^1.0.0" },
      devDependencies: { dev: "^1.0.0" },
    }),
  );
  writeFileSync(
    lock,
    `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "demo-app",
      "dependencies": { "left": "^1.0.0" },
      "devDependencies": { "dev": "^1.0.0" },
    },
  },
  "packages": {
    "left": ["left@1.2.3", "", {}, "sha512-aGVsbG8="],
    "dev": ["dev@4.5.6", "", {}, "sha512-aGVsbG8="],
    "transitive": ["transitive@2.0.0", "", {}, "sha512-aGVsbG8="],
  },
}
`,
  );
  return { root, pkg, lock };
}

describe("buildSbom", () => {
  test("emits CycloneDX 1.6 with metadata + components", () => {
    const fx = makeFixture();
    const bom = buildSbom(fx.pkg, fx.lock, { includeDev: false });
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.6");
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]+$/);
    expect(bom.metadata.component.name).toBe("demo-app");
    expect(bom.metadata.component.version).toBe("1.0.0");
    expect(bom.metadata.component.licenses?.[0]?.license?.id).toBe("MIT");
  });

  test("excludes top-level devDependencies by default", () => {
    const fx = makeFixture();
    const bom = buildSbom(fx.pkg, fx.lock, { includeDev: false });
    const names = bom.components.map((c) => c.name);
    expect(names).toContain("left");
    expect(names).toContain("transitive");
    expect(names).not.toContain("dev"); // top-level devDep filtered
  });

  test("includes devDependencies with --include-dev", () => {
    const fx = makeFixture();
    const bom = buildSbom(fx.pkg, fx.lock, { includeDev: true });
    const names = bom.components.map((c) => c.name);
    expect(names).toContain("dev");
  });

  test("emits purl in pkg:npm/<name>@<version> format", () => {
    const fx = makeFixture();
    const bom = buildSbom(fx.pkg, fx.lock, { includeDev: false });
    const left = bom.components.find((c) => c.name === "left");
    expect(left?.purl).toBe("pkg:npm/left@1.2.3");
  });

  test("decodes sha512 base64 to hex hash", () => {
    const fx = makeFixture();
    const bom = buildSbom(fx.pkg, fx.lock, { includeDev: false });
    const left = bom.components.find((c) => c.name === "left");
    expect(left?.hashes?.[0]?.alg).toBe("SHA-512");
    // "aGVsbG8=" base64-decoded is "hello", hex = "68656c6c6f"
    expect(left?.hashes?.[0]?.content).toBe("68656c6c6f");
  });

  test("components are sorted by purl for diff stability", () => {
    const fx = makeFixture();
    const bom = buildSbom(fx.pkg, fx.lock, { includeDev: true });
    const purls = bom.components.map((c) => c.purl);
    const sorted = [...purls].sort();
    expect(purls).toEqual(sorted);
  });

  test("tolerates trailing commas in bun.lock (JSONC-like format)", () => {
    // The fixture lockfile has trailing commas; if the sanitizer breaks
    // we'd get a JSON.parse error here.
    const fx = makeFixture();
    expect(() => buildSbom(fx.pkg, fx.lock, { includeDev: false })).not.toThrow();
  });
});
