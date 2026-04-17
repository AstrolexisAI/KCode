# KCode GitHub Action

Drop KCode into your repository's CI to get security findings
uploaded to **GitHub code scanning** on every PR. Results show up
in the Security tab alongside CodeQL, Dependabot, and anything
else your org runs.

## Minimum usage

```yaml
# .github/workflows/kcode.yml
name: KCode Security Audit
on: [push, pull_request]

jobs:
  kcode:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # required to upload SARIF
    steps:
      - uses: actions/checkout@v4
      - uses: AstrolexisAI/KCode@v1
```

That's it. KCode runs `kcode audit .` with SARIF output, uploads
the result to GitHub, and fails the build if any **high-severity
or above** finding is confirmed.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `path` | `.` | Path to audit. Use a subdir for monorepos. |
| `model` | (settings) | Override the verification model. |
| `api-key` | (env) | API key for the verification model. Passed via `KCODE_API_KEY`. |
| `skip-verify` | `false` | Skip LLM verification (regex-only). Faster, higher FP rate. |
| `max-files` | `500` | Maximum files to scan. |
| `fail-on-severity` | `high` | Fail the action if ≥1 finding at/above this severity. `none`, `low`, `medium`, `high`, `critical`. |

## Outputs

| Output | Description |
|--------|-------------|
| `sarif-path` | Path to the generated `.sarif` file inside the workspace. |
| `confirmed-findings` | Integer — number of CONFIRMED findings from the audit. |

## Example: hybrid local + cloud verification

For large repos, use local models for initial verification and
Anthropic/OpenAI for the hard cases:

```yaml
- uses: AstrolexisAI/KCode@v1
  with:
    model: "mnemo:mark6-31b"
    api-key: ${{ secrets.KCODE_LOCAL_API_KEY }}
    fail-on-severity: high
```

## Example: fail-fast on critical, warn on high

```yaml
- uses: AstrolexisAI/KCode@v1
  with:
    fail-on-severity: critical

- name: Summarize high-severity findings
  if: always()
  run: |
    jq -r '.findings[] | select(.severity == "high") | "⚠ \(.file):\(.line) \(.pattern_id)"' AUDIT_REPORT.json || true
```

## Enterprise notes

- **SARIF 2.1.0** emitted, consumable by GitHub Advanced Security,
  Azure DevOps, SonarQube, Snyk.
- **Partial fingerprints** included per finding, so GitHub
  deduplicates across commits and tracks fix/regression automatically.
- **CWE mapping** present as `properties.cwe` on each rule, so the
  security dashboard groups findings by weakness class.
- **Rule help URIs** point to the canonical CWE definition page.

## What about self-hosted runners?

The action uses `oven-sh/setup-bun@v2`, so any runner with outbound
internet + the standard Ubuntu toolchain works. For air-gapped
environments, vendor the action + set `api-key` / model overrides
to point at an internal inference endpoint.
