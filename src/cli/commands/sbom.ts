// KCode — `kcode sbom` command
//
// Emits a CycloneDX 1.6 Software Bill of Materials in JSON format.
// Reads package.json + bun.lock to enumerate every resolved
// dependency (production by default; --include-dev adds devDependencies).
//
// Required for procurement audits (NIST 800-53 SA-15, gov supply
// chain reviews). Compatible with CycloneDX validators (cdxgen,
// dependency-track, OWASP).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";

interface BunLockPackage {
  // ["name@version", "registry", {meta}, "sha512-..."]
  0: string;
  1?: string;
  2?: Record<string, unknown>;
  3?: string;
}

interface BunLock {
  lockfileVersion: number;
  workspaces?: Record<
    string,
    {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }
  >;
  packages?: Record<string, BunLockPackage>;
}

interface CycloneDXComponent {
  type: "library";
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  hashes?: { alg: string; content: string }[];
  licenses?: { license: { id?: string; name?: string } }[];
  scope?: "required" | "optional";
}

interface CycloneDXBom {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: { vendor: string; name: string; version: string }[];
    component: {
      type: "application";
      "bom-ref": string;
      name: string;
      version: string;
      description?: string;
      licenses?: { license: { id?: string } }[];
    };
  };
  components: CycloneDXComponent[];
}

function parsePackageEntry(entry: BunLockPackage): {
  name: string;
  version: string;
  hash?: string;
} | null {
  const spec = entry[0];
  if (typeof spec !== "string") return null;
  // Format: "@scope/name@version" or "name@version"
  const lastAt = spec.lastIndexOf("@");
  if (lastAt <= 0) return null;
  const name = spec.slice(0, lastAt);
  const version = spec.slice(lastAt + 1);
  const hash = typeof entry[3] === "string" ? entry[3] : undefined;
  return { name, version, hash };
}

function toPurl(name: string, version: string): string {
  // Package URL spec: https://github.com/package-url/purl-spec
  // For npm: pkg:npm/<name>@<version>; scoped names need %40 / preserved
  // CycloneDX validators accept the literal scoped form.
  return `pkg:npm/${name}@${version}`;
}

function buildComponents(lock: BunLock, options: { includeDev: boolean }): CycloneDXComponent[] {
  if (!lock.packages) return [];

  // Determine which packages are devDependency-only when filtering.
  // Bun's lockfile flattens, so we approximate scope from the workspace
  // dependency lists rather than walking the graph.
  const root = lock.workspaces?.[""];
  const devOnly = new Set<string>();
  if (!options.includeDev && root) {
    const prod = new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.peerDependencies ?? {}),
      ...Object.keys(root.optionalDependencies ?? {}),
    ]);
    for (const dev of Object.keys(root.devDependencies ?? {})) {
      if (!prod.has(dev)) devOnly.add(dev);
    }
  }

  const components: CycloneDXComponent[] = [];
  for (const [pkgKey, entry] of Object.entries(lock.packages)) {
    const parsed = parsePackageEntry(entry);
    if (!parsed) continue;

    // Skip dev-only top-level packages when --include-dev is off. We
    // can't fully prune transitive devDeps without a full graph walk,
    // but skipping the dev top-levels is the impactful case (biome,
    // vite, etc.). This is documented as approximate-by-design.
    if (devOnly.has(pkgKey)) continue;

    const purl = toPurl(parsed.name, parsed.version);
    const component: CycloneDXComponent = {
      type: "library",
      "bom-ref": purl,
      name: parsed.name,
      version: parsed.version,
      purl,
      scope: "required",
    };
    if (parsed.hash) {
      // bun.lock stores "sha512-<base64>" — CycloneDX wants the hex
      // form. Convert base64 → hex for the SHA-512 algo.
      const m = /^sha512-(.+)$/.exec(parsed.hash);
      if (m?.[1]) {
        try {
          const hex = Buffer.from(m[1], "base64").toString("hex");
          component.hashes = [{ alg: "SHA-512", content: hex }];
        } catch {
          /* skip malformed hash */
        }
      }
    }
    components.push(component);
  }

  // Stable ordering for diff-friendly output
  components.sort((a, b) => a.purl.localeCompare(b.purl));
  return components;
}

export function buildSbom(
  packageJsonPath: string,
  bunLockPath: string,
  options: { includeDev: boolean },
): CycloneDXBom {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    name: string;
    version: string;
    description?: string;
    license?: string;
  };
  // bun.lock is "JSONC-like" — it permits trailing commas before } and ].
  // Standard JSON.parse rejects those. Strip them defensively before parsing.
  // Strings can't contain `,\s*[}\]]` followed by another `,\s*[}\]]` near
  // the end of a value, so a regex pass is safe in practice.
  const lockRaw = readFileSync(bunLockPath, "utf-8");
  const lockSanitized = lockRaw.replace(/,(\s*[}\]])/g, "$1");
  const lock = JSON.parse(lockSanitized) as BunLock;

  const rootRef = `pkg:npm/${pkg.name}@${pkg.version}`;
  const bom: CycloneDXBom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "Astrolexis", name: "kcode-sbom", version: pkg.version }],
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        licenses: pkg.license ? [{ license: { id: pkg.license } }] : undefined,
      },
    },
    components: buildComponents(lock, options),
  };
  return bom;
}

export function registerSbomCommand(program: Command): void {
  program
    .command("sbom")
    .description("Emit a CycloneDX 1.6 Software Bill of Materials (JSON)")
    .option("-o, --output <path>", "Write to file instead of stdout")
    .option("--include-dev", "Include devDependencies (default: production only)")
    .option("--cwd <path>", "Project root (default: KCode install dir)")
    .action(async (opts: { output?: string; includeDev?: boolean; cwd?: string }) => {
      // Resolve project root. Default to the kcode install dir, which
      // is where package.json + bun.lock ship in dev. For shipped
      // binaries the lockfile may not be present — we surface that
      // clearly rather than emit a half-empty SBOM.
      const root = resolve(opts.cwd ?? process.cwd());
      const pkgPath = `${root}/package.json`;
      const lockPath = `${root}/bun.lock`;

      let bom: CycloneDXBom;
      try {
        bom = buildSbom(pkgPath, lockPath, { includeDev: !!opts.includeDev });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `kcode sbom: failed to read package.json or bun.lock at ${root}\n` +
            `  ${msg}\n` +
            `\n` +
            `Pass --cwd <path> pointing at the KCode source checkout.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const json = JSON.stringify(bom, null, 2);
      if (opts.output) {
        await Bun.write(opts.output, json);
        process.stderr.write(`Wrote ${bom.components.length} components to ${opts.output}\n`);
      } else {
        process.stdout.write(json);
        process.stdout.write("\n");
      }
    });
}
