# Contributor License Agreement — KCode

KCode is dual-licensed (see `LICENSE` for AGPL-3.0 and
`LICENSE-COMMERCIAL.md` for the commercial terms). To keep
the dual-license structure enforceable, every contribution to
this repository must be accompanied by a **Developer Certificate
of Origin (DCO) sign-off**.

## The DCO

The DCO is a lightweight, one-line-per-commit certification
that you have the right to submit your contribution under the
project's license terms. It is the same mechanism used by the
Linux kernel, Docker, GitLab, and many other open-source
projects.

You sign off a commit by adding a `Signed-off-by:` line at
the bottom of the commit message:

```
feat(audit): new pattern for X

Signed-off-by: Your Name <your.email@example.com>
```

Git does this automatically when you pass `--signoff` (or
`-s`):

```bash
git commit -s -m "feat(audit): new pattern for X"
```

By signing off, you certify the following (the full DCO text
appears below):

## Developer Certificate of Origin 1.1

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me
> and I have the right to submit it under the open source
> license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to
> the best of my knowledge, is covered under an appropriate
> open source license and I have the right under that license
> to submit that work with modifications, whether created in
> whole or in part by me, under the same open source license
> (unless I am permitted to submit under a different license),
> as indicated in the file; or
>
> (c) The contribution was provided directly to me by some
> other person who certified (a), (b) or (c) and I have not
> modified it.
>
> (d) I understand and agree that this project and the
> contribution are public and that a record of the
> contribution (including all personal information I submit
> with it, including my sign-off) is maintained indefinitely
> and may be redistributed consistent with this project or
> the open source license(s) involved.

— https://developercertificate.org

## What the sign-off grants

When you sign off a commit, you are confirming that:

1. You wrote the code yourself, OR have permission to submit
   code written by others (under a compatible license).
2. The contribution may be distributed under **both** the
   AGPL-3.0 (this repository's public license) and the
   commercial license terms (see `LICENSE-COMMERCIAL.md`).

That second point matters. Without dual-license rights
attached to contributions, Astrolexis cannot relicense the
codebase for commercial customers who need non-AGPL terms.
The DCO is how contributors grant those rights in a clean,
widely-understood form.

## Why this matters for the project

KCode is open source, but the pattern catalog, SARIF
exporter, and audit pipeline also power commercial offerings
(see `LICENSE-COMMERCIAL.md`). If an AGPL-only contribution
landed in the codebase without any path to the commercial
license, Astrolexis would face a choice:

- Remove the contribution to preserve commercial viability.
- Accept AGPL-only scope for that part, fragmenting the
  codebase into "commercial OK" and "AGPL only" regions.
- Pay the contributor for an individual relicense grant,
  which doesn't scale.

Requiring DCO sign-off at contribution time avoids all three.

## Enforcement

- PR authors whose commits are **not** signed off will be
  asked to amend their commits with `git commit --amend -s`
  (or `git rebase -i HEAD~N` with `--signoff`) before the PR
  can be merged.
- Automated CI may reject unsigned commits in the future.
  Currently it's a reviewer check.
- Existing commits (pre-DCO adoption) are grandfathered;
  the project treats them as contributed under AGPL-3.0
  alone. Future relicensing work can address those on a
  case-by-case basis.

## Questions

Open a GitHub issue with the `licensing` label, or email
`contact@astrolexis.space`.

## This document is the framework

As with `LICENSE-COMMERCIAL.md`, this document is the
**framework** under which contributions are accepted. The
actual legal text that matters is the DCO itself (quoted
above in full, linked to its canonical source) and your
`Signed-off-by:` line in every commit.

© 2026 Astrolexis.
