# KCode — Commercial License

**KCode is available under a dual license:**

1. **AGPL-3.0-only** — the license in `LICENSE`. Free to use,
   modify, and redistribute under the terms of the GNU Affero
   General Public License version 3.

2. **Commercial License** (this document) — for organizations
   that cannot comply with AGPL obligations (for example,
   embedding KCode into a proprietary SaaS offering without
   publishing the modified source, or distributing KCode as
   part of a closed-source product).

## When you need the commercial license

You need a commercial license if you want to do any of the
following **without** complying with AGPL-3.0:

- Run KCode as a service accessed over a network (the AGPL's
  §13 "network use is distribution" clause triggers) where
  your modifications stay proprietary.
- Embed KCode's audit engine into a proprietary product
  distributed to end users.
- Incorporate KCode source into a codebase whose license
  terms are incompatible with AGPL-3.0 (most commercial
  licenses are).
- Receive an indemnification guarantee, support SLA, or
  contractual response times that the AGPL-3.0 disclaims.

You do **NOT** need a commercial license if:

- You use KCode as a CLI tool internally in your company, even
  at scale, as long as you don't extend it in a way AGPL's
  network clauses would affect. Running `kcode audit` on your
  own CI pipeline is perfectly fine under AGPL.
- You contribute patches back under AGPL.
- You fork the project, modify it, and release your fork also
  under AGPL.
- You use the `AstrolexisAI/KCode` GitHub Action in your own
  workflows — GitHub Actions consume the AGPL tool without
  distributing derivative works.

## What the commercial license includes

(These are the **intended** terms — the actual contract is
negotiated per customer. This section is for transparency about
the scope, not a legally binding offer.)

- **Unrestricted embedding**: use KCode's audit engine, SARIF
  exporter, pattern catalog, and SDK inside proprietary
  products, SaaS, or internal tools without AGPL obligations.
- **Indemnification** against IP claims related to KCode's
  use within your product.
- **Priority support** with response-time SLA appropriate to
  your tier (standard / premium / enterprise).
- **Custom pattern development**: security researchers at
  Astrolexis will curate additional patterns for languages or
  frameworks specific to your codebase, added to the catalog
  under your exclusive use for a defined period, or merged to
  the public catalog if you prefer.
- **Roadmap input**: commercial customers can propose and
  prioritize features via a dedicated channel.
- **Air-gapped deployment** support — running KCode and its
  dedicated LLM entirely on-prem without network dependencies.

## What the commercial license does NOT include

- Waiver of the "**no warranty**" clause from the AGPL. KCode
  is provided AS IS under both licenses; commercial support
  is a separate SLA, not a warranty on correctness of findings.
- Automatic license grant for derivative works distributed to
  YOUR customers unless specifically negotiated (the commercial
  license is typically per-organization; sublicensing requires
  a separate tier).

## How to obtain the commercial license

Contact Astrolexis with a brief description of your use case:

- **Email**: `contact@astrolexis.space`
- **Subject line**: `KCode Commercial License — <your company>`

Include:

1. What you want to do that AGPL prevents.
2. Rough scale (number of repos / developers / scans per month).
3. Deployment environment (cloud / on-prem / air-gapped).
4. Existing tooling this would replace or complement.

We'll respond with a proposal including pricing tier and terms
within 5 business days. A draft contract follows once you accept
the proposal.

## Note for contributors

If you want to contribute to KCode, please read `CLA.md` — every
contribution must be signed off under the Developer Certificate
of Origin so the dual-license structure remains enforceable.
Contributions made without sign-off can only be incorporated
under AGPL-3.0, which limits their utility in the commercial
license path.

## Disclaimer

This document is the **framework** under which the commercial
license operates. It is not itself a legal contract. A specific
commercial license agreement is drafted and executed between
Astrolexis and the licensee once terms are negotiated.

The terms above represent Astrolexis's standard offering as of
the repository's current date. They may evolve; the binding
document is whatever is signed between the parties.

© 2026 Astrolexis. All rights reserved.
