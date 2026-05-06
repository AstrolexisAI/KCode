# NIST SP 800-53 Rev. 5 Control Mapping

Status: living document, last reviewed against KCode `v2.10.422`.

This table maps the controls relevant to an offline-first AI coding
assistant against the KCode codebase. Controls marked **Implemented**
have evidence (file:line, command, or doc) cited inline. Controls
marked **Inherited** are the operating system / OS-administrator's
responsibility — KCode does not (and should not) re-implement them.
Controls marked **N/A** are out of scope and the reason is given.

The intended use of this table is to give a procurement or AO
(Authorizing Official) reviewer a starting point. It is not a
self-issued ATO. Independent verification is expected.

## Access Control (AC)

| Control | Title | Status | Evidence / Notes |
|---|---|---|---|
| AC-2 | Account Management | Inherited | KCode runs as the invoking user. No multi-account model. OS handles identity. |
| AC-3 | Access Enforcement | Implemented | Filesystem tools enforce `cwd` containment (`src/tools/edit.ts`, `src/tools/write.ts`). Bash tool uses an allowlist + per-command approval (`src/tools/bash.ts`, `src/core/permissions/`). |
| AC-6 | Least Privilege | Implemented | KCode never runs setuid / does not request elevation. Default policy denies network egress without `--offline=false`. Plugin/MCP execution is allowlisted under `KCODE_SAFE_PLUGINS=1`. |
| AC-17 | Remote Access | Implemented | Air-gap mode (`KCODE_OFFLINE=1`) blocks all non-localhost egress at the `offlineAwareFetch` layer. See `docs/security/air-gap-deployment.md`. |
| AC-20 | External Information Systems | Implemented | When offline mode is off and cloud providers are configured, the user is the one who chose to authorize external systems (provider API keys are explicit settings entries). `kcode doctor --secure` reports them. |

## Audit and Accountability (AU)

| Control | Title | Status | Evidence / Notes |
|---|---|---|---|
| AU-2 | Audit Events | Implemented (partial) | Tool invocations, prompts, model responses, and slash commands are recorded per-session in `~/.kcode/sessions/<id>.jsonl`. Coverage of "configuration change" events is on the roadmap. |
| AU-3 | Content of Audit Records | Implemented | Each record has timestamp (ISO-8601), session ID, event type, tool name, args, and outcome. Full message content is captured by default; `KCODE_REDACT_LOGS=1` masks bodies for privacy-sensitive deployments. |
| AU-6 | Audit Review, Analysis, Reporting | Inherited | Logs are JSONL — pipe to Splunk / ELK / Loki. KCode does not ship its own SIEM. |
| AU-9 | Protection of Audit Information | Partial | Session log files are written under the user's home with default umask. Hash-chaining for tamper-evidence is on the roadmap. |
| AU-10 | Non-repudiation | Partial | Same as AU-9 — once hash-chain lands, each entry will be cryptographically linked to the previous. |
| AU-12 | Audit Generation | Implemented | Every tool invocation generates an event; cannot be disabled by the model. The user can disable with `KCODE_AUDIT_LOG=off` (deliberately discoverable, not silent). |

## Configuration Management (CM)

| Control | Title | Status | Evidence / Notes |
|---|---|---|---|
| CM-2 | Baseline Configuration | Implemented | Defaults are hardcoded in `src/core/config.ts`. Effective configuration is dumped by `kcode doctor --deep`. |
| CM-3 | Configuration Change Control | Inherited | Settings file `~/.kcode/settings.json` is user-managed. We do not enforce change-control workflow. |
| CM-7 | Least Functionality | Implemented | Optional features (telemetry, voice, push, plugins) are off by default. `kcode doctor --secure` reports any active optional sink. |
| CM-8 | Information System Component Inventory | Implemented | `kcode sbom` emits a CycloneDX 1.6 SBOM covering every npm dependency with name, version, purl, and SHA-512 hash. |
| CM-10 | Software Usage Restrictions | Implemented | Apache 2.0 license; no embedded restricted-distribution component. |

## Identification and Authentication (IA)

| Control | Title | Status | Evidence / Notes |
|---|---|---|---|
| IA-2 | User Identification | Inherited | KCode runs as the OS user; identity is the OS account. |
| IA-5 | Authenticator Management | Implemented | API keys / OAuth tokens are stored under `~/.kcode/` with mode `0600`. OAuth tokens are encrypted at rest with AES-256-GCM (`src/core/mcp-oauth.ts`). |
| IA-7 | Cryptographic Module Authentication | Implemented | All crypto uses Node/Bun built-ins (OpenSSL-backed). FIPS 140-3 compliance is inherited from the underlying runtime; if the deployment requires it, run KCode under a FIPS-validated build of Bun/Node. |

## System and Communications Protection (SC)

| Control | Title | Status | Evidence / Notes |
|---|---|---|---|
| SC-7 | Boundary Protection | Implemented | `offlineAwareFetch` is the single egress chokepoint. `KCODE_OFFLINE=1` enforces the boundary. Verified by `src/core/offline/egress-block.test.ts`. |
| SC-8 | Transmission Confidentiality and Integrity | Implemented | All cloud endpoints used are HTTPS. The OAuth client refuses non-HTTPS token URLs except for `localhost` (`requireHttpsEndpoint` in `src/core/mcp-oauth.ts`). |
| SC-12 | Cryptographic Key Establishment and Management | Implemented | Encryption key for stored OAuth tokens derived via PBKDF2-SHA256 (100,000 iterations) over a per-host random salt + machine identity (`src/core/mcp-oauth.ts:deriveEncryptionKey`). |
| SC-13 | Cryptographic Protection | Implemented | AES-256-GCM for OAuth token storage. SHA-512 for SBOM component hashes. SHA-256 for binary integrity. |
| SC-28 | Protection of Information at Rest | Implemented | Sensitive files written with mode `0600`. OAuth tokens additionally encrypted (see SC-12). |

## System and Information Integrity (SI)

| Control | Title | Status | Evidence / Notes |
|---|---|---|---|
| SI-2 | Flaw Remediation | Implemented | `bun audit` runs in `.github/workflows/build.yml`. Patch releases ship through the same signed pipeline. |
| SI-3 | Malicious Code Protection | Inherited | KCode does not implement AV. Downstream operators integrate with their own EDR. |
| SI-4 | Information System Monitoring | Inherited | KCode's audit log is the input; monitoring infrastructure is the operator's. |
| SI-7 | Software, Firmware, and Information Integrity | Implemented | Sigstore keyless-OIDC signing of every release binary (`v2.10.422`+). Verification: `cosign verify-blob` per `docs/security/verify-binary.md`. |
| SI-10 | Information Input Validation | Implemented | MCP tool inputs sanitized (`sanitizeMcpInput` in `src/core/mcp-client.ts`): prototype-pollution keys stripped, depth and size limits enforced. |
| SI-11 | Error Handling | Implemented | Errors do not include API keys, stack traces from third-party calls, or internal paths in user-visible output. Debug detail behind `KCODE_LOG_LEVEL=debug`. |

## Supply Chain Risk Management (SR)

| Control | Title | Status | Evidence / Notes |
|---|---|---|---|
| SR-3 | Supply Chain Controls and Processes | Implemented | Dependency lockfile (`bun.lock`) is committed; dependency audit runs in CI. Plugin marketplace verifies SHA before install. |
| SR-4 | Provenance | Implemented | Every release artifact has a sigstore certificate naming the GitHub Actions workflow that built it. The Rekor transparency log entry is publicly auditable at search.sigstore.dev. |
| SR-9 | Tamper Resistance and Detection | Implemented | Detached signature + certificate per binary. `cosign verify-blob` detects tampering. SHA256SUMS for the entire release set. |
| SR-10 | Inspection of Systems or Components | Implemented | SBOM (`kcode sbom`) provides full component manifest for inspection by Dependency-Track, Trivy, Snyk, or in-house tooling. |
| SR-11 | Component Authenticity | Implemented | Signing identity is the GH Actions workflow URL. Anyone reproducing the workflow on a fork would get a different identity in the Sigstore certificate. |

## Air-Gapped / Disconnected Operation

When `KCODE_OFFLINE=1` is set, the following NIST controls have
strengthened or simplified evidence:

- **AC-17** — no remote access surface to evaluate; the egress
  guard rejects all non-localhost traffic at the application layer.
- **SC-7** — the boundary is enforced by code, not by network policy
  alone, providing defense in depth alongside firewall rules.
- **SI-4** — egress can be attested with `tcpdump`/`ss` per the
  air-gap deployment guide; absence of traffic is the evidence.

## Roadmap (controls in progress)

Items where KCode is partial today and the next gov-readiness
iteration will close the gap:

- **AU-9 / AU-10** — hash-chained audit log for tamper-evidence.
- **CM-3** — settings-change events surfaced as audit records.
- **SR-3** — reproducible builds (currently signed but not bit-for-bit
  reproducible across environments).

These are tracked in the project's gov-readiness milestone and will
be reflected here as they ship.
