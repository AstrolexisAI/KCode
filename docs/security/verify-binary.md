# Verifying a KCode release binary

Every KCode release published from `v2.10.422` onward is signed with
[Sigstore Cosign](https://docs.sigstore.dev/cosign/) using
**keyless OIDC** — the signing identity is the GitHub Actions workflow
in this repository, anchored in Rekor's public transparency log.
There is no shared signing key.

This means:
- Anyone can verify the binary they downloaded came from this exact
  workflow on this exact commit, with no key distribution problem.
- The signature record is immutable and publicly auditable in
  [search.sigstore.dev](https://search.sigstore.dev/).

## Install cosign

```bash
# macOS (Homebrew)
brew install cosign

# Linux (binary)
curl -L https://github.com/sigstore/cosign/releases/download/v2.5.0/cosign-linux-amd64 -o cosign
chmod +x cosign && sudo mv cosign /usr/local/bin/

# Verify
cosign version
```

## Verify a binary

For each release, three files are published per platform:

```
kcode-linux-x64
kcode-linux-x64.sig    # detached signature
kcode-linux-x64.pem    # signing certificate (X.509)
```

Run:

```bash
VERSION=2.10.422
TARGET=linux-x64

curl -LO https://github.com/AstrolexisAI/KCode/releases/download/v${VERSION}/kcode-${TARGET}
curl -LO https://github.com/AstrolexisAI/KCode/releases/download/v${VERSION}/kcode-${TARGET}.sig
curl -LO https://github.com/AstrolexisAI/KCode/releases/download/v${VERSION}/kcode-${TARGET}.pem

cosign verify-blob \
  --certificate kcode-${TARGET}.pem \
  --signature   kcode-${TARGET}.sig \
  --certificate-identity-regexp 'https://github.com/AstrolexisAI/KCode/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  kcode-${TARGET}
```

Expected output:

```
Verified OK
```

If the verification fails:
- The binary may have been tampered with.
- The certificate identity does not match — the binary was not built
  by the official AstrolexisAI/KCode workflow.
- Stop and **do not run the binary**. Report the discrepancy at
  [security@astrolexis.space](mailto:security@astrolexis.space).

## Verify the SHA256 sums

Each release also publishes `SHA256SUMS` covering binaries +
signatures + certificates:

```bash
curl -LO https://github.com/AstrolexisAI/KCode/releases/download/v${VERSION}/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

## Air-gapped environments

For deployments without internet access at install time:

1. On a connected workstation, download the binary + `.sig` + `.pem` +
   `SHA256SUMS`.
2. Pull the cosign root trust bundle once:
   `cosign initialize` (caches Sigstore root keys to `~/.sigstore/`).
3. Move all four files plus `~/.sigstore/` to the air-gapped target.
4. Run `cosign verify-blob ... --offline` with the same flags as above.

`--offline` skips the Rekor inclusion proof check; the certificate
identity check still runs against the embedded Fulcio chain.

## Reporting

Suspicious release artifacts, key compromise, or signature anomalies:
[security@astrolexis.space](mailto:security@astrolexis.space).
