# Air-Gap Deployment Guide

Status: living document, last reviewed against KCode `v2.10.422`.

This guide walks through deploying KCode on a target system with
**no internet access**. The audience is an operator who is going to
hand-carry an installation to a controlled / classified / disconnected
environment and needs to demonstrate that no traffic ever leaves the
target.

The procedure has three phases:
1. **Stage** — pull everything you need on a connected workstation.
2. **Transfer** — move the bundle to the air-gap target via approved
   media.
3. **Install + verify** — confirm cryptographic integrity, run
   KCode in offline mode, attest no-egress.

## Prerequisites

On the **connected workstation** (used to assemble the bundle):
- `cosign` v2.5.0 or newer.
- A web browser to reach `github.com/AstrolexisAI/KCode/releases`.
- Enough disk to hold the binary + signature + a local model (a 4-bit
  quantised 7B GGUF is ~4.5 GB; a 32B 4-bit MLX is ~18 GB).

On the **air-gap target**:
- Linux x86_64, Linux ARM64, macOS x86_64, or macOS ARM64.
- `cosign` available via approved channels (or skipped — see
  *Verifying without cosign* below).
- A local inference server: `llama.cpp`, `mlx_lm.server`, or `ollama`,
  pre-installed via your normal supply chain.
- A user account that owns `~/.kcode/` (no root required).

Throughout this guide, replace `${VERSION}` with the KCode release
you are deploying (e.g. `2.10.422`) and `${TARGET}` with one of:
`linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`.

## Phase 1 — Stage on the connected workstation

```bash
WORK=~/kcode-airgap-bundle
mkdir -p "$WORK" && cd "$WORK"

VERSION=2.10.422
TARGET=linux-x64
BASE="https://github.com/AstrolexisAI/KCode/releases/download/v${VERSION}"

# Binary + signature + signing certificate
curl -LO "${BASE}/kcode-${TARGET}"
curl -LO "${BASE}/kcode-${TARGET}.sig"
curl -LO "${BASE}/kcode-${TARGET}.pem"

# Release-wide checksum file
curl -LO "${BASE}/SHA256SUMS"

# Cosign Sigstore root trust bundle (so verify works offline later)
cosign initialize
cp -r ~/.sigstore "$WORK/sigstore-root"
```

Add a local model that the target will use. Two common options:

```bash
# Option A — llama.cpp + a GGUF
curl -LO https://huggingface.co/<repo>/resolve/main/<model>.gguf

# Option B — MLX (Apple Silicon target)
hf download <hf-repo> --local-dir ./mlx-model
```

Optional but recommended for the audit package:

```bash
# Generate the SBOM from the source repo (clone once on the
# connected workstation, not on the target).
git clone --branch v${VERSION} https://github.com/AstrolexisAI/KCode.git kcode-src
cd kcode-src && bun install --frozen-lockfile
bun run src/index.ts sbom --output ../kcode-sbom-${VERSION}.json
cd ..
```

Final bundle layout:

```
kcode-airgap-bundle/
├── kcode-linux-x64
├── kcode-linux-x64.sig
├── kcode-linux-x64.pem
├── SHA256SUMS
├── sigstore-root/             # ~/.sigstore/ snapshot
├── kcode-sbom-2.10.422.json
└── <your-local-model>.gguf
```

## Phase 2 — Transfer to the target

Use whatever media your environment authorises (USB, optical, CFTS
diode, sneakernet). Compute a sum on both sides as a transport check:

```bash
# Connected workstation
sha256sum -- * > MANIFEST.sha256

# Air-gap target (after copy)
sha256sum --check MANIFEST.sha256
```

This is **not** a security verification — it only confirms the
files arrived intact. Cryptographic verification happens in Phase 3.

## Phase 3 — Install and verify on the target

### Step 1 — Verify the cosign signature

```bash
cd ~/kcode-airgap-bundle

# Use the staged Sigstore root
export SIGSTORE_ROOT_FILE="$PWD/sigstore-root/root.json"

cosign verify-blob \
  --certificate kcode-${TARGET}.pem \
  --signature   kcode-${TARGET}.sig \
  --certificate-identity-regexp 'https://github.com/AstrolexisAI/KCode/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --offline \
  kcode-${TARGET}
```

Expected output: `Verified OK`.

If verification fails, **stop**. The binary was modified after it
left GitHub, or it was built by an unauthorised workflow.

### Step 2 — Verify the SHA256 sums

```bash
sha256sum --check --ignore-missing SHA256SUMS
```

### Step 3 — Verifying without cosign

If the target cannot run `cosign` (older distro, restricted
toolchain), the SHA256 verification above is still valuable: an
attacker would need to also publish a matching `SHA256SUMS` to bypass
it, which they cannot do without write access to the GitHub release.

In that case, document in your acceptance record that:
- The SHA256SUMS file was retrieved over HTTPS at stage time.
- The binary on the target hashes to the value in that file.
- The signature artefact (`.sig`) is preserved alongside the binary
  for later verification on a system that does have cosign.

### Step 4 — Install the binary

```bash
sudo install -m 0755 kcode-${TARGET} /usr/local/bin/kcode
kcode --version    # confirms the binary runs
```

### Step 5 — Force offline mode

Add to the user's environment (e.g. `~/.bashrc` or systemd unit):

```bash
export KCODE_OFFLINE=1
```

Or write it into settings:

```bash
mkdir -p ~/.kcode
cat > ~/.kcode/settings.json <<'JSON'
{
  "offline": { "enabled": true, "autoDetect": false },
  "autoUpdate": false,
  "telemetry": { "enabled": false, "sinks": [] }
}
JSON
chmod 600 ~/.kcode/settings.json
```

### Step 6 — Run the secure-posture check

```bash
kcode doctor --secure
```

Expected: `Offline / air-gap mode` is **pass**, `No cloud API keys
configured` is **pass** (provided you did not also stage cloud keys),
`Auto-update disabled` is **pass**, `Telemetry disabled` is **pass**,
`Settings file permissions` is **pass**.

Any **fail** here must be remediated before the system is considered
ready.

### Step 7 — Attest no-egress

In a separate terminal on the target, while KCode runs a non-trivial
session:

```bash
# What sockets are open?
sudo ss -tnp 'sport != :22 and sport != :80 and sport != :443' | grep kcode

# Capture for 60 seconds and confirm no traffic to non-localhost
sudo tcpdump -i any -nn -c 100 \
  'host not 127.0.0.1 and host not ::1 and not (net 192.168.0.0/16) and not (net 10.0.0.0/8) and not (net 172.16.0.0/12)' \
  -w /tmp/kcode-egress-attest.pcap
```

If the second command exits because no packets matched the filter,
that is the evidence: KCode produced no egress beyond
localhost / LAN. Archive the pcap (or its absence) with the
acceptance record.

For deployments that require continuous attestation, run the same
filter under `tcpdump` as a systemd unit and alert on any captured
packet.

## Updating an air-gapped deployment

There is no auto-update path — by design. To roll a new version:
1. Repeat Phase 1 with the new `${VERSION}`.
2. Re-verify on the target.
3. Replace `/usr/local/bin/kcode` with the new binary.
4. Re-run `kcode doctor --secure`.

The previous binary remains in `~/.kcode/previous-kcode` so a
rollback is `mv ~/.kcode/previous-kcode /usr/local/bin/kcode`.

## What this does NOT cover

- Hardening the underlying OS (SELinux profiles, syscall filters,
  network namespaces). Use your usual baseline.
- Sandboxing the agent's tool execution. KCode confirms commands
  before running; constraining what those commands can reach is
  the operator's job (containers, jails, ACLs).
- Procuring or hardening the local LLM model itself. Model
  provenance / safety evaluation is a separate workstream.

## Reporting

Issues with this procedure or with verification artefacts:
[security@astrolexis.space](mailto:security@astrolexis.space).
