# KCode Roadmap

This document tracks the commercial evolution of KCode. Licensing, Pro
features, and infrastructure commitments are captured here so contributors,
investors, and customers can see the trajectory.

**Current state** (April 2026, v2.10.274)
- License: Apache 2.0 (core)
- Pro features: gated by `isPro()` runtime check, code currently in public repo
- Infrastructure: local dev machine (no production server yet)
- Revenue: $0 confirmed Pro subscribers

---

## Phase 1 — Validate demand (now → Q2 2026)

**Goal**: prove that at least 10 users are willing to pay for Pro features before investing in server-side infrastructure.

**Steps**:

- [x] Switch license AGPL-3.0 → Apache 2.0 (removes VC and enterprise legal friction)
- [x] Keep Pro features (multimodel, orchestrator, benchmarks) in public repo with `isPro()` gate
- [x] Document Pro tier pricing and scope in `LICENSE-COMMERCIAL.md`
- [ ] Post on HN/Reddit/r/programming announcing Apache 2.0 + Pro tier
- [ ] Acquire 3 paying Individual Pro subscribers ($19/mo) through direct outreach
- [ ] Complete 1 paid audit engagement using KCode (validates service model)
- [ ] Collect feedback from the first paying customers: which Pro features they actually use

**Success criteria**: 10+ paying subscribers OR 2+ paid audit engagements.

**Explicitly NOT doing in this phase**:
- Server-side conductor (premature — no revenue to justify infra cost)
- Pro features private repo split (maintenance burden without clear protection benefit)
- Team/Enterprise tiers (no demand signal yet)

---

## Phase 2 — Protect the Pro moat (after Phase 1 validates)

**Trigger**: 10+ Pro subscribers confirmed.

**Goal**: move the Multi-Model Orchestrator conductor to a server-side service, preserving the "code stays local" promise while gating Pro features through license tokens.

**Architecture** (preserves `Source never leaves your machine`):

```
User prompt (no code)    →  api.astrolexis.space/orchestrate
                              ↓
                          Conductor (claude-haiku)
                              ↓
                          Validates license token
                              ↓
                          Returns: { sub_tasks: [...] }

Client executes plan LOCALLY with user's own API keys.
The server never sees the user's code, edits, or tool outputs —
only the input prompt and the decomposition decision.
```

**Steps**:

- [ ] Deploy conductor on Cloudflare Workers (low-cost, global edge)
- [ ] D1 database for license tokens + usage telemetry
- [ ] Stripe integration for Pro/Team subscriptions
- [ ] Rate limiting: 100 decompositions/day free, unlimited for Pro
- [ ] Client talks to conductor over HTTPS with Bearer token
- [ ] Heartbeat protocol: client pings every 30 min; no heartbeat = features disabled
- [ ] Graceful degradation: if server is down, fall back to single-model routing (don't block the user)
- [ ] Migrate existing Pro subscribers to token-based auth

**Infrastructure cost estimate**: $20-50/month at 100 subscribers (Cloudflare Workers + D1 + Stripe).

**Success criteria**: Pro features work end-to-end with server-gated conductor.

---

## Phase 3 — Hosted KCode Cloud (after Phase 2)

**Trigger**: 50+ Pro subscribers, at least 1 team with 5+ users.

**Goal**: offer a hosted version that lets teams share context, benchmarks, and audit history without managing local installations.

**Features**:

- [ ] Team accounts (SSO: Google Workspace, Microsoft Entra, SAML)
- [ ] Shared session history (transcript search across team)
- [ ] Team dashboard (aggregated cost and usage)
- [ ] Shared benchmark results (team members see same model scores)
- [ ] Shared plugin/skill repository
- [ ] Team-wide audit log retention (SOC2 requirement)
- [ ] Priority support SLA (4h response)

**Pricing**: $49/user/month for Team. Custom enterprise pricing above 50 seats.

**Infrastructure**: managed Postgres, Redis for session state, S3-compatible storage for transcripts, proper observability stack.

**Success criteria**: 3+ teams paying monthly.

---

## Phase 4 — Enterprise and managed audits (long-term)

**Trigger**: first enterprise inbound inquiry.

**Offerings**:

- Managed audit service — Astrolexis engineers run KCode on the customer's codebase and deliver a triage report ($5k-50k per engagement)
- Air-gapped on-prem deployment (zero telemetry, customer owns the tokens)
- Industry-specific pattern packs (fintech, healthcare, defense)
- Compliance evidence packs (SOC2, ISO 27001, HIPAA)
- White-label / rebranding rights
- Custom integrations (JIRA, Slack, PagerDuty, SOAR platforms)

This phase is **service-first, not software-first**. The software is a tool that enables higher-margin engagements.

---

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-22 | Switch AGPL-3.0 → Apache 2.0 | AGPL blocks VC and enterprise adoption; Apache keeps source-available story for audit buyers while removing legal friction |
| 2026-04-22 | Defer Pro-features private-repo split | Maintenance burden without revenue validation; `isPro()` gate is adequate until bypass becomes a measurable revenue issue |
| 2026-04-22 | Defer server-side conductor until Phase 2 | Infrastructure investment without paying customers is premature; conductor stays local under Apache until subscriber count justifies the build |

---

## What happens if a fork bypasses `isPro()`?

**Under Apache 2.0, this is legal.** Individual tinkerers will do it. Small
competitors won't (they'd rather build their own in 2 months than maintain
a fork). Enterprises won't (their legal teams require paid licenses for
commercial tools).

The expected revenue loss from bypass is approximately zero: people who
bypass are not the people who would have paid. Phase 2's server-side gate
is the real protection — it becomes available when the subscriber base
justifies the infrastructure investment.

---

*Last updated: 2026-04-22*  
*Maintainer: contact@astrolexis.space*
