// KCode - Supply-Chain Pack (P2.2, v2.10.389)
//
// Patterns target the package-manager + CI surface where attackers
// gain code execution by compromising a dependency, an upstream
// action, or an install-time script. Ships as a focused starter
// set across the languages KCode already supports — adding
// JSON / lockfile parsing is a follow-up.
//
// Every pattern carries `pack: "supply-chain"` so users can scope
// with `kcode audit . --pack supply-chain`.

import type { BugPattern } from "../types";

export const SUPPLY_CHAIN_PATTERNS: BugPattern[] = [
  // ─── Shell install scripts ────────────────────────────────────
  {
    id: "supply-001-curl-pipe-shell",
    title: "curl <url> | sh — fetch-and-run install pattern",
    severity: "high",
    languages: ["shell"],
    pack: "supply-chain",
    // Match curl/wget piped into a shell. Capture the URL for the
    // verifier prompt so it can judge whether it's a known good
    // installer or arbitrary attacker-controlled.
    regex: /\b(?:curl|wget)\s+(?:-\w+\s+)*[^\s|;&<>]+\s*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh)\b/g,
    explanation:
      "curl|sh installers run whatever the upstream URL serves at the moment of install — there's no signature check, no version pin, no offline review. A repo takeover, a DNS hijack, or a man-in-the-middle on an insecure mirror gives an attacker arbitrary code execution on every machine that runs the install. This is the same shape that hit the corepack and bun-install supply-chain incidents.",
    verify_prompt:
      "Is this an install-time fetch-and-run, or a different curl|sh use?\n" +
      "1. The URL is a vendor's official installer (rustup.rs, get.docker.com, deno.land/install.sh) AND the script is documented for that purpose — borderline; mark CONFIRMED so the user is aware, but severity is medium not high.\n" +
      "2. The URL is a third-party / self-hosted endpoint (gist, raw.githubusercontent, custom domain) — CONFIRMED, high severity. Pin to a specific version + checksum or download the script and review it.\n" +
      "3. This is inside a fixture / unit test / documentation example clearly marked as such — FALSE_POSITIVE.",
    cwe: "CWE-494",
    fix_template:
      "Replace `curl URL | sh` with: download the script to a file, verify checksum / signature against a pinned hash, then run it. Or use the package manager's signed-release flow (apt, brew, etc.) when the project distributes through one.",
  },

  // ─── GitHub Actions ───────────────────────────────────────────
  {
    id: "supply-002-gha-pull-request-target-checkout-head",
    title: "GitHub Actions pull_request_target + checkout of PR head — RCE-on-PR",
    severity: "critical",
    languages: ["yaml"],
    pack: "supply-chain",
    // Match `on: pull_request_target` combined with `actions/checkout`
    // using an `ref: ${{ github.event.pull_request.head.sha }}` or
    // `head.ref`. The combination is the attack pattern published in
    // GitHub Security Lab's 2021 advisory and re-exploited in 2024.
    // We match the `ref:` line — the workflow file context tells the
    // verifier whether it's actually a pull_request_target trigger.
    regex: /^\s*ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(?:sha|ref)\s*\}\}/gim,
    explanation:
      "pull_request_target runs the BASE branch's workflow with WRITE token + secrets, but if the workflow then checks out the PR HEAD and runs ANY of its code (npm install, make test, even just the runner reading a malicious workflow include), the attacker gets the secrets. This was the GitHub-published attack pattern that compromised hundreds of repos in 2021 and is still discovered weekly. The `ref:` line is the smoking gun.",
    verify_prompt:
      "Is the workflow's trigger pull_request_target?\n" +
      "1. The workflow's `on:` block contains `pull_request_target` AND the checkout uses head.sha/head.ref — CONFIRMED, critical. Move secrets to a separately-triggered workflow.\n" +
      "2. The workflow uses regular `pull_request` (not _target) — FALSE_POSITIVE; pull_request runs without write access, the attack doesn't apply.\n" +
      "3. Cannot determine the trigger from the snippet — NEEDS_CONTEXT.",
    cwe: "CWE-829",
    fix_template:
      "Either: (a) switch to `pull_request` (no secrets, no write token), or (b) DO NOT check out the PR head — keep pull_request_target on the base branch and pass forked PR data via labels/artifacts to a separate workflow that has no secrets. GitHub's official guidance: https://securitylab.github.com/research/github-actions-preventing-pwn-requests/",
  },

  // ─── pip / Python ─────────────────────────────────────────────
  {
    id: "supply-003-pip-extra-index-url",
    title: "pip install with --extra-index-url — dependency confusion shape",
    severity: "high",
    languages: ["python", "shell"],
    pack: "supply-chain",
    // Match --extra-index-url <url> in pip commands. Index URLs that
    // are NOT pypi.org allow attackers to register a higher-version
    // package on their own index and have pip prefer it.
    regex: /\bpip\s+(?:install|--user|-U|--upgrade)\s+(?:[^|;&\n]*\s+)?--extra-index-url[\s=]+(\S+)/g,
    explanation:
      "--extra-index-url adds a SECONDARY package source. pip resolves the highest version across ALL configured indices — so if an attacker registers `your-private-pkg @ 9999.0.0` on a public index they control, pip pulls THEIR package over your private one. The Microsoft / Apple / Yelp 2021 dependency-confusion incidents were exactly this.",
    verify_prompt:
      "Is the extra index a private mirror you control, or attacker-reachable?\n" +
      "1. The URL is your team's private mirror (artifactory.<company>.com, nexus, etc.) AND the workflow runs in a context that resolves it on a private network — borderline; mark CONFIRMED so the reviewer documents why this is OK.\n" +
      "2. The URL is on the public internet OR could be reached by attacker DNS poisoning — CONFIRMED.\n" +
      "3. The URL string is interpolated from an env var (\"$INDEX_URL\") — NEEDS_CONTEXT (depends on where the env var is sourced).",
    cwe: "CWE-1357",
    fix_template:
      "Replace --extra-index-url with --index-url (single source). Set the index to your private mirror only; mirror PyPI packages you need rather than letting pip resolve across multiple indices. Use hash-pinned requirements (`pip install --require-hashes`) for production installs.",
  },

  // ─── npm / Node ───────────────────────────────────────────────
  {
    id: "supply-004-npm-token-hardcoded",
    title: "npm publish token / authToken hardcoded in source",
    severity: "critical",
    languages: ["javascript", "typescript", "shell"],
    pack: "supply-chain",
    // npm tokens are 36-char npm_<base62>. _authToken value in .npmrc
    // or assigned to an env variable in JS/TS.
    regex: /\bnpm_[A-Za-z0-9]{30,}\b/g,
    explanation:
      "An npm token in source means the attacker who reads the file can publish malicious versions of every package the token has access to. Once a malicious version lands on the registry, every consumer that runs `npm install` without a lockfile pin pulls it. The 2018 event-stream + 2024 ua-parser-js incidents were token compromises that turned into supply-chain attacks reaching millions of installs.",
    verify_prompt:
      "Does the matched string look like a real npm token, or a placeholder?\n" +
      "1. Token contains 'YOUR_TOKEN', 'XXXX', 'placeholder', 'sample' — FALSE_POSITIVE.\n" +
      "2. Token matches the npm_[A-Za-z0-9]{30+} shape AND has no obvious placeholder marker — CONFIRMED. Rotate immediately and audit the registry for unexpected publishes.\n" +
      "3. The literal is a fixture / test mock that's clearly not a real key — FALSE_POSITIVE if comment / nearby code marks it as such.",
    cwe: "CWE-798",
    fix_template:
      "Move the token to an environment variable (NPM_TOKEN) and a CI secret. Configure npm with `npm config set //registry.npmjs.org/:_authToken \\${NPM_TOKEN}` at runtime. Rotate the leaked token immediately — assume any token that lived in a commit is compromised, even briefly.",
  },

  // ─── JavaScript / TypeScript ─────────────────────────────────
  {
    id: "supply-005-eval-of-fetch",
    title: "eval / new Function over a fetched payload — RCE on every load",
    severity: "critical",
    languages: ["javascript", "typescript"],
    pack: "supply-chain",
    // Match common shapes: eval(await fetch(...).text()), new
    // Function(await fetch(...)), Function('return ' + await
    // fetch(...).text())(). The combination of "eval-class call" +
    // "fetched body" is the smoking gun.
    regex: /\b(?:eval|Function|new\s+Function)\s*\(\s*[^)]*?\bfetch\s*\(/g,
    explanation:
      "Pulling JavaScript over the network and eval'ing it is the most direct supply-chain RCE shape. There's no signature, no version, no review — the upstream owns code execution in your runtime forever. CDN compromise, DNS hijack, or a malicious update to the upstream → attacker code runs in every user's browser / every Node process. The polyfill.io 2024 incident was this exact pattern at scale.",
    verify_prompt:
      "Is the eval'd content fetched from a network endpoint?\n" +
      "1. The fetch URL is a CDN you don't control, a third-party endpoint, or interpolated from user input — CONFIRMED.\n" +
      "2. The fetch URL is a same-origin endpoint serving signed code (rare, requires explicit verification step nearby) — borderline; CONFIRMED unless the verification is visible in scope.\n" +
      "3. The pattern is in a comment / fixture / clearly-marked test — FALSE_POSITIVE.",
    cwe: "CWE-94",
    fix_template:
      "Don't eval network content. Either: (a) statically import the module at build time (with integrity hash via subresource integrity), (b) parse the response as DATA (JSON), not code, or (c) sandbox the execution in a Web Worker / iframe with no privileges if dynamic code truly is required.",
  },
];
