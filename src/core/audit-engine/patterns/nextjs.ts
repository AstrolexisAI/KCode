// KCode - Next.js framework pack (P2.3, v2.10.391)
//
// Next.js-specific attack surface that doesn't fit generic web
// patterns. The framework's blend of server-side props, Route
// Handlers (App Router), Server Actions, middleware, and
// public-prefixed env vars produces a handful of recurring
// vulnerability shapes that ship with very low false-positive
// rates because the matched API names are unique to Next.
//
// All patterns belong to the "web" pack so users can run
// `kcode audit . --pack web` to scope an audit to web/framework
// concerns. Future framework files (FastAPI, Express, Django,
// Rails, Spring, Laravel) will share the same pack tag.

import type { BugPattern } from "../types";

export const NEXTJS_PATTERNS: BugPattern[] = [
  // ─── Server-side rendering / props ────────────────────────────
  {
    id: "next-001-getserversideprops-no-auth",
    title: "getServerSideProps reads request data without an auth check",
    severity: "high",
    languages: ["javascript", "typescript"],
    pack: "web",
    // Match an exported getServerSideProps that uses ctx.req / ctx.query /
    // ctx.params / ctx.params anywhere in its body. The verifier prompt
    // judges whether an auth check actually exists.
    regex: /\bexport\s+(?:async\s+)?(?:function|const)\s+getServerSideProps\b[\s\S]*?(?:ctx\.req|context\.req|ctx\.query|context\.query|ctx\.params|context\.params)/g,
    explanation:
      "getServerSideProps runs on every request with full server-side privileges. If it returns user-controlled props without authenticating the request first, the page leaks whatever the page reads — user records, internal links, drafts. The pattern hit Vercel's own examples in 2023 and remains the most common Next.js auth-bypass shape.",
    verify_prompt:
      "Does the function authenticate the caller before returning props?\n" +
      "1. There is an `await getServerSession(...)`, `verifyJwt(req)`, `await auth()`, `requireUser(req)`, or equivalent gate near the top, AND the function early-returns/redirects when missing — FALSE_POSITIVE.\n" +
      "2. The function uses ctx.req but doesn't call any auth helper — CONFIRMED.\n" +
      "3. The function only uses ctx.query for non-sensitive routing data (slug, locale) and the page never returns user-specific data — borderline; mark NEEDS_CONTEXT for human review.\n" +
      "4. The page is documented as public (signin, marketing, /api/health) — FALSE_POSITIVE.",
    cwe: "CWE-862",
    fix_template:
      "Add an early auth gate: `const session = await getServerSession(ctx.req, ctx.res, authOptions); if (!session) return { redirect: { destination: '/signin', permanent: false } };` — then use the session.user.id to scope the rest of the data fetches.",
  },

  // ─── Server Actions (Next 13+) ────────────────────────────────
  {
    id: "next-002-server-action-no-auth",
    title: "Server Action exported without an auth check",
    severity: "critical",
    languages: ["javascript", "typescript"],
    pack: "web",
    // Match a top-of-file "use server" directive and look for a later
    // `export async function NAME(...)`. The directive turns every
    // exported function into a callable RPC endpoint — so any
    // unauthenticated action is a public mutation point.
    regex: /^\s*["']use server["'];?[\s\S]*?\bexport\s+async\s+function\s+\w+/gm,
    explanation:
      "Top-level `use server` makes every exported async function a callable Server Action — Next wires the function name into a public RPC endpoint that ANY visitor can POST to with any args. Without an explicit auth check the function runs with full server privileges. This is the 2024-2025 attack surface that hit Vercel's cookbook examples and became the new equivalent of the 2010s mass-assignment bug.",
    verify_prompt:
      "Does the action authenticate the caller before doing the mutation?\n" +
      "1. The action calls `await auth()` / `await getServerSession()` / a custom `requireUser()` and returns/throws when missing — FALSE_POSITIVE.\n" +
      "2. The action is wrapped in a higher-order helper like `withAuth(async (...) => ...)` — FALSE_POSITIVE.\n" +
      "3. The action mutates data (db.* / fetch with method != GET) without any auth helper called inside — CONFIRMED. The endpoint is a public mutation primitive.\n" +
      "4. The action only reads public, hard-coded data (e.g. site config) — FALSE_POSITIVE.",
    cwe: "CWE-306",
    fix_template:
      "Add an auth check on the FIRST line of every Server Action: `const session = await auth(); if (!session?.user) throw new Error('unauthorized');` — and prefer wrapping with a higher-order `withAuth` helper so new actions can't ship without the gate.",
  },

  // ─── NEXT_PUBLIC_ env-var leaks ──────────────────────────────
  {
    id: "next-003-next-public-secret",
    title: "NEXT_PUBLIC_<NAME> env var with secret-shaped name (bundled to client)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    pack: "web",
    // NEXT_PUBLIC_*TOKEN / KEY / SECRET / PASSWORD / API_KEY in a
    // process.env access OR in next.config.js env mapping. The whole
    // point of NEXT_PUBLIC_ is "this is bundled into the client" —
    // putting a secret behind that prefix ships the secret to every
    // visitor's browser DevTools.
    regex: /\bNEXT_PUBLIC_\w*(?:TOKEN|SECRET|API_?KEY|PASSWORD|PRIVATE_KEY|CLIENT_SECRET|SESSION_KEY)\w*\b/gi,
    explanation:
      "NEXT_PUBLIC_ is Next's INTENTIONAL client-side env-var prefix — every variable with that prefix is inlined into the JS bundle at build time. Naming a variable NEXT_PUBLIC_API_TOKEN means the token ships in the user's browser, visible in DevTools / source view / network tab. This is a recurring incident shape because the prefix looks like a namespace separator but is actually a publish-to-client switch.",
    verify_prompt:
      "Is the variable actually a secret, or a non-sensitive identifier with a misleading name?\n" +
      "1. The variable holds a public identifier (Stripe publishable key `pk_*`, Firebase web config, Mixpanel project token, Google Analytics ID) — these ARE meant to be client-side; FALSE_POSITIVE.\n" +
      "2. The variable holds a private API key, a server-side credential, or a session-signing secret — CONFIRMED. Rename to remove the NEXT_PUBLIC_ prefix and add a server-side proxy if the value is needed in the browser.\n" +
      "3. Cannot determine from the snippet — NEEDS_CONTEXT.",
    cwe: "CWE-200",
    fix_template:
      "Rename the variable to drop the NEXT_PUBLIC_ prefix (e.g. `NEXT_PUBLIC_API_TOKEN` → `API_TOKEN`) so it stays server-side. If the browser genuinely needs to call the API, add a Next.js Route Handler (`app/api/proxy/route.ts`) that uses the server-side key and forwards only the result.",
  },

  // ─── Route Handlers / App Router ─────────────────────────────
  {
    id: "next-004-route-handler-no-auth",
    title: "App Router route handler reads request data without an auth check",
    severity: "high",
    languages: ["javascript", "typescript"],
    pack: "web",
    // Match `export async function (GET|POST|PUT|PATCH|DELETE)(...)` as
    // the entry of a route.ts file. The body referencing request
    // headers / cookies / json without an auth check elsewhere is
    // the smell.
    regex: /\bexport\s+async\s+function\s+(?:GET|POST|PUT|PATCH|DELETE)\s*\([^)]*\)\s*\{[\s\S]{0,400}?(?:request\.(?:json|text|formData|cookies|headers)|cookies\(\)|headers\(\))/g,
    explanation:
      "App Router route handlers (route.ts) are public HTTP endpoints. Reading request body / cookies / headers without authentication on a non-public route exposes the underlying logic to any internet caller — the 2024 t3-app and several authjs-template repos shipped with this exact shape.",
    verify_prompt:
      "Does the handler authenticate the caller before doing the work?\n" +
      "1. There's an `await auth()`, `await getServerSession(...)`, `verifyJwt(request.headers)`, or similar near the top, with an early 401/403 — FALSE_POSITIVE.\n" +
      "2. The handler reads body/cookies/headers without any auth helper called inside — CONFIRMED.\n" +
      "3. The route is documented as public (signin, register, /api/health, /api/og, OAuth callback) — FALSE_POSITIVE.\n" +
      "4. Authentication happens in a parent middleware that gates this exact path — FALSE_POSITIVE; the verifier should mention this.",
    cwe: "CWE-862",
    fix_template:
      "Add `const session = await auth(); if (!session?.user) return new Response('unauthorized', { status: 401 });` as the first line. For routes that genuinely should be public, add a comment explaining why so future audits know to skip them.",
  },

  // ─── Open redirect via query param ───────────────────────────
  {
    id: "next-005-redirect-from-query",
    title: "redirect() / router.push() with raw query / searchParams value",
    severity: "high",
    languages: ["javascript", "typescript"],
    pack: "web",
    // redirect(searchParams.get('next')) / router.push(query.from) /
    // NextResponse.redirect(req.nextUrl.searchParams.get('redirect'))
    regex: /\b(?:redirect|router\.push|router\.replace|NextResponse\.redirect)\s*\(\s*(?:[\w.]+\.searchParams\.get\([^)]+\)|[\w.]+\.query\.\w+|searchParams\.get\([^)]+\))\s*[,)]/g,
    explanation:
      "Redirecting to a URL pulled from the query string is the classic open-redirect: an attacker crafts a link to your site with `?next=https://evil.example/` and the user's browser follows the trusted-looking domain into the attacker's page. Phishers love this because the initial click looks legitimate. Next's router.push / NextResponse.redirect honor any URL, including absolute ones, unless the caller filters.",
    verify_prompt:
      "Is the redirect target validated against an allowlist or restricted to relative paths?\n" +
      "1. The target is checked with `if (!url.startsWith('/'))` / `URL(target).origin === self.origin` / explicit allowlist — FALSE_POSITIVE.\n" +
      "2. The query value is passed straight to redirect() / push() — CONFIRMED.\n" +
      "3. The target is interpolated into a relative path before redirect (`/users/${slug}`) — FALSE_POSITIVE.",
    cwe: "CWE-601",
    fix_template:
      "Validate the target before redirecting: `if (!target?.startsWith('/') || target.startsWith('//')) target = '/';` — relative paths only, no protocol-relative URLs. For external redirects, maintain an explicit allowlist of trusted domains.",
  },
];
