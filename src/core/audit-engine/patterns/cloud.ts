// KCode - Cloud / IaC at-rest pack (P2.1, v2.10.389)
//
// Patterns scan Terraform configs (.tf), Kubernetes manifests
// (.yaml/.yml), Dockerfiles, and GitHub Actions workflows for
// the most common high-impact misconfigurations. This is the
// FILES-AT-REST sibling of v2.10.383's runtime Bash guards
// (dangerous-patterns.ts) — yesterday we blocked the agent from
// running `terraform destroy` at runtime; today we scan the
// `.tf` itself for the bug shape that ends up causing the
// destroy-worthy state in the first place.
//
// Scope discipline: each pattern is intentionally narrow. The
// goal is high-precision wins (Snyk/CodeQL ship hundreds of
// noisy IaC patterns; KCode's bet is "fewer, defensible, with
// a verifier").
//
// Every pattern carries `pack: "cloud"` so users can scope with
// `kcode audit . --pack cloud`.

import type { BugPattern } from "../types";

export const CLOUD_PATTERNS: BugPattern[] = [
  // ─── Terraform ────────────────────────────────────────────────
  {
    id: "cloud-001-iam-wildcard-action",
    title: "IAM policy with Action = \"*\" (full account-takeover surface)",
    severity: "high",
    languages: ["terraform"],
    pack: "cloud",
    // Match the literal `Action = "*"` or `actions = ["*"]` shape
    // inside aws_iam_*_policy blocks. Allow heredoc body too.
    regex: /\b[Aa]ction(?:s)?\s*=?\s*\[?\s*"\*"\s*\]?/g,
    explanation:
      "An IAM policy that grants Action = \"*\" lets the principal call ANY API in the account — IAM, EC2, S3, RDS, billing. Compromise of the role's credentials becomes total account takeover. Even when scoped to a single resource, the action wildcard is the single most exploited mis-grant in cloud incident reports.",
    verify_prompt:
      "Is this an IAM policy or a comment / fixture / IAM-trust block?\n" +
      "1. The string is inside a comment, a markdown doc, or a *_test.tf fixture — FALSE_POSITIVE.\n" +
      "2. The string is the only Action in a real policy block (data \"aws_iam_policy_document\", aws_iam_role_policy, etc.) — CONFIRMED. Even with Resource scoping the action wildcard is the vulnerability: it lets the principal manage IAM (escalate), run EC2 (lateral), and read S3 (exfiltrate).\n" +
      "3. The wildcard is one of multiple actions and the rest scope it (e.g. NotAction excludes IAM) — borderline; mark as CONFIRMED so the reviewer takes a look.",
    cwe: "CWE-269",
    fix_template:
      "Replace Action = \"*\" with the explicit list of API calls the role actually needs (s3:GetObject, dynamodb:Query, etc.). When in doubt, start with read-only actions and grant write only after a deliberate review.",
  },
  {
    id: "cloud-002-tf-public-s3",
    title: "S3 bucket with public-read or public-read-write ACL",
    severity: "high",
    languages: ["terraform"],
    pack: "cloud",
    // resource "aws_s3_bucket" "x" { acl = "public-read" }
    // or aws_s3_bucket_acl resource. Match the ACL value.
    regex: /\bacl\s*=\s*"public-read(?:-write)?"/g,
    explanation:
      "A public-read S3 bucket exposes every object to the internet. public-read-write ALSO accepts uploads from anyone — attackers use these to host phishing payloads, dump exfiltrated data, or run up your bandwidth bill. AWS now recommends bucket policies + Block Public Access; ACLs are legacy.",
    verify_prompt:
      "Is the bucket actually serving public-readable content, or is the ACL inside a comment / fixture?\n" +
      "1. Comment, markdown, or *_test.tf — FALSE_POSITIVE.\n" +
      "2. Real resource block — CONFIRMED. Even legitimate static-asset buckets should use CloudFront + OAI rather than public ACLs.\n" +
      "3. The bucket name has 'public' / 'cdn' / 'static' in it AND a comment explicitly justifies public access — borderline; mark as NEEDS_CONTEXT so the reviewer documents the decision.",
    cwe: "CWE-732",
    fix_template:
      "Set acl = \"private\" (default) and serve via CloudFront with an Origin Access Identity. If the bucket genuinely needs public access (e.g. static website hosting), use a bucket policy with a documented justification.",
  },

  // ─── Kubernetes ──────────────────────────────────────────────
  {
    id: "cloud-003-k8s-privileged-container",
    title: "Kubernetes container with privileged: true (full host root)",
    severity: "critical",
    languages: ["yaml"],
    pack: "cloud",
    // Match `privileged: true` inside a securityContext block.
    // We can't easily verify the parent block via regex, but in
    // practice `privileged: true` only appears in K8s/Compose
    // security contexts.
    regex: /^\s*privileged:\s*true\b/gm,
    explanation:
      "A privileged container has root access to the HOST kernel — same as running on the bare node. A compromised app inside the container can mount host filesystems, read /etc/shadow, attach to other containers' processes, or modify kernel modules. This is the #1 K8s escape route attackers look for.",
    verify_prompt:
      "Is this a Kubernetes (or Docker Compose) security context, or a different YAML field?\n" +
      "1. A documentation comment, a Kustomize patch with a clear rollback marker, or a fixture — FALSE_POSITIVE.\n" +
      "2. Inside `securityContext:` for a real Pod / Deployment / DaemonSet — CONFIRMED. The privileged flag breaks containerization entirely.\n" +
      "3. The pod is a known privileged-by-design tool (Calico, kube-proxy, CSI driver) AND the manifest is in a kube-system / cluster-tooling namespace — NEEDS_CONTEXT; flag for human review.",
    cwe: "CWE-250",
    fix_template:
      "Drop privileged: true. If the pod genuinely needs specific kernel capabilities, request them explicitly via securityContext.capabilities.add (e.g. NET_ADMIN, SYS_PTRACE) — that's the principle of least privilege.",
  },
  {
    id: "cloud-004-k8s-host-network",
    title: "Kubernetes pod with hostNetwork: true (bypasses CNI isolation)",
    severity: "high",
    languages: ["yaml"],
    pack: "cloud",
    regex: /^\s*hostNetwork:\s*true\b/gm,
    explanation:
      "hostNetwork: true makes the pod share the node's network namespace. NetworkPolicy doesn't apply, the pod can listen on any port the node exposes, and a compromised app can sniff or man-in-the-middle traffic from any other pod or service on the node. Almost always wrong outside specific node-agent workloads (CNI, kube-proxy, monitoring sidecars).",
    verify_prompt:
      "Is this a real Pod/Deployment spec, or a fixture / doc?\n" +
      "1. Comment, markdown, or fixture — FALSE_POSITIVE.\n" +
      "2. Real spec — CONFIRMED unless the pod is a node-agent (CNI plugin, kube-proxy, monitoring DaemonSet) running in kube-system.\n" +
      "3. Node-agent in kube-system / monitoring-tools namespace — NEEDS_CONTEXT.",
    cwe: "CWE-693",
    fix_template:
      "Remove hostNetwork: true. If the pod needs to expose a port, use a Service (ClusterIP / NodePort / LoadBalancer). If it needs to read host-level metrics, prefer Prometheus's node-exporter pattern over giving the pod direct host network.",
  },

  // ─── Dockerfile ──────────────────────────────────────────────
  {
    id: "cloud-005-dockerfile-secret-arg",
    title: "Dockerfile ARG holding what looks like a secret",
    severity: "critical",
    languages: ["dockerfile"],
    pack: "cloud",
    // ARG <name>=<value> where <name> contains TOKEN/KEY/SECRET/PASSWORD
    // and <value> is a non-trivial literal. ARG values are baked into
    // the image AND visible in `docker history`.
    regex: /^\s*ARG\s+\w*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)\w*\s*=\s*[^$\s]\S{4,}/gim,
    explanation:
      "ARGs in a Dockerfile end up in the image's `docker history`. Anyone who pulls the image — including registry leaks — can recover the value with `docker history --no-trunc`. Even if the build process clears the variable, the layer that referenced it preserves the value forever.",
    verify_prompt:
      "Does the ARG value look like a real secret, or a placeholder?\n" +
      "1. Value is a placeholder (CHANGE_ME, ${SECRET}, your-key-here) — FALSE_POSITIVE.\n" +
      "2. Value is a string that looks token-like (alphanumeric, base64, hex, length > 20) — CONFIRMED. Rotate immediately and switch to BuildKit secret mounts.\n" +
      "3. Value is an env-var reference like ${API_KEY} — FALSE_POSITIVE; the actual secret is supplied at build time.",
    cwe: "CWE-798",
    fix_template:
      "Use BuildKit secrets: `RUN --mount=type=secret,id=mytoken cat /run/secrets/mytoken`. The secret never enters a layer. If you need a build-time token, pass it via ARG WITHOUT a default value and supply it at build time with `docker build --build-arg`.",
  },

  // ─── GitHub Actions ──────────────────────────────────────────
  {
    id: "cloud-006-gha-third-party-no-sha",
    title: "GitHub Actions third-party action pinned to a tag instead of a SHA",
    severity: "high",
    languages: ["yaml"],
    pack: "cloud",
    // uses: <owner>/<repo>@<ref> where <ref> is NOT a 40-char hex SHA.
    // Allow first-party actions/* without flagging — those are pinned
    // by GitHub itself and the supply-chain risk is lower.
    regex: /^\s*uses:\s*(?!actions\/)([\w-]+\/[\w-]+)@(?!([0-9a-f]{40})\b)([\w.-]+)/gim,
    explanation:
      "A third-party Action pinned to a mutable tag (@v1, @main, @release) executes whatever the upstream maintainer pushes there at run time. A repo takeover or a malicious release rewrites the tag → your CI runs attacker code with all your secrets in scope. The tj-actions/changed-files supply-chain attack (March 2025) was exactly this shape: 23k+ workflows compromised because they used @v45 instead of a SHA.",
    verify_prompt:
      "Is the ref a mutable tag, or a fixed SHA?\n" +
      "1. Ref is a 40-char hex SHA — FALSE_POSITIVE (already pinned).\n" +
      "2. Ref is a tag (v1, v1.2.3, main, release-2024) — CONFIRMED. Even reputable third-party actions can be compromised; the SHA pin is the defense.\n" +
      "3. The repo is in actions/ (GitHub-owned) — already filtered by the regex; if you see this, mark FALSE_POSITIVE.",
    cwe: "CWE-829",
    fix_template:
      "Replace @v1 with the full commit SHA: `uses: someuser/some-action@<40-char-sha>`. Keep a comment with the human-readable version next to it for upgrades. Use `pin-github-action` or `dependabot` with `pin-by-sha: true` to automate this.",
  },
];
