// KCode - FastAPI framework pack (P2.3, v2.10.391)
//
// FastAPI-specific bug shapes complementing the existing
// fastapi-001-sql-raw in framework.ts. Same `pack: "web"` tag so
// /scan --pack web includes them. The framework's heavy reliance
// on dependency injection (Depends), Pydantic validation, and
// CORSMiddleware produces a small recurring set of high-impact
// misconfigurations.

import type { BugPattern } from "../types";

export const FASTAPI_PATTERNS: BugPattern[] = [
  {
    id: "fastapi-002-cors-wildcard-with-credentials",
    title: "CORSMiddleware allow_origins='*' combined with allow_credentials=True",
    severity: "critical",
    languages: ["python"],
    pack: "web",
    // Match the add_middleware(CORSMiddleware, ...) call. The wildcard
    // origins + credentials flag combo is forbidden by the CORS spec
    // and Starlette WILL accept it — but every browser drops the
    // ACAO header in this combination, which most apps then "fix"
    // by setting ACAO via a custom header, opening the bug.
    regex: /\bCORSMiddleware\b[\s\S]{0,400}?allow_origins\s*=\s*\[\s*["']\*["']\s*\][\s\S]{0,400}?allow_credentials\s*=\s*True/g,
    explanation:
      "The CORS spec explicitly forbids `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true` — every browser ignores credentials in that combination. Apps that set this configuration usually 'fix' the broken auth by either reflecting the Origin header back (which makes EVERY website able to make authed requests to the API), or by hand-rolling the credentials path, both of which are CSRF-equivalent. Real incidents: Stripe Workers misconfig 2023, Notion API 2024.",
    verify_prompt:
      "Is the CORSMiddleware actually configured this way at runtime?\n" +
      "1. Both allow_origins=['*'] AND allow_credentials=True are present in the same middleware add — CONFIRMED.\n" +
      "2. allow_origins is a list of explicit domains, not just '*' — FALSE_POSITIVE.\n" +
      "3. allow_credentials defaults to False (not set) — FALSE_POSITIVE.\n" +
      "4. The combination is in test/conftest.py and never imported by production app — FALSE_POSITIVE.",
    cwe: "CWE-942",
    fix_template:
      "Either keep allow_origins=['*'] for a public read-only API and remove allow_credentials, or replace '*' with an explicit allowlist of origin domains and keep credentials. The two cannot coexist safely.",
  },
  {
    id: "fastapi-003-jwt-no-verify",
    title: "jwt.decode() with signature verification disabled",
    severity: "critical",
    languages: ["python"],
    pack: "web",
    // jwt.decode(token, ..., options={"verify_signature": False})
    // OR PyJWT 1.x style: jwt.decode(token, verify=False)
    // OR python-jose: jose.jwt.decode(token, options={"verify_signature": False})
    regex: /\bjwt\.decode\s*\(\s*[^)]*?(?:verify\s*=\s*False|"verify_signature"\s*:\s*False|'verify_signature'\s*:\s*False)/g,
    explanation:
      "Decoding a JWT WITHOUT signature verification means the server trusts whatever claims the client sends — `{'role': 'admin', 'sub': 'anyone'}` is accepted as long as the structure parses. This is a complete authentication bypass disguised as a JWT call. The pattern almost always appears as 'just decode for debugging' that ships to production by accident.",
    verify_prompt:
      "Is signature verification actually disabled?\n" +
      "1. Call has options={'verify_signature': False} or verify=False (PyJWT 1.x) — CONFIRMED. The decoder is doing zero auth.\n" +
      "2. Call sets only options={'verify_aud': False} or similar (NOT verify_signature) — borderline; aud-skip is also dangerous but less critical, mark NEEDS_CONTEXT.\n" +
      "3. Call passes a key/algorithms argument and no verify=False — FALSE_POSITIVE.",
    cwe: "CWE-347",
    fix_template:
      "Remove the verify_signature=False / verify=False option. Pass the verification key + the explicit `algorithms=['RS256']` (or whatever your signer uses) so the library can verify. Never decode without verification, even for debugging — write a separate dev-only helper if you need to inspect tokens.",
  },
  {
    id: "fastapi-004-pickle-from-request",
    title: "pickle.loads on request body / form data — RCE on every POST",
    severity: "critical",
    languages: ["python"],
    pack: "web",
    // pickle.loads(await request.body()) / pickle.loads(form['data']) /
    // pickle.loads(payload) where payload was just assigned from request
    // input. We match the loads call near common request-object names.
    regex: /\b(?:pickle|cPickle)\.loads?\s*\(\s*(?:await\s+)?\w*(?:request\.body|request\.form|request\.json|request\.read|payload|body|form_data|raw)\b/g,
    explanation:
      "pickle is Python's executable serialization format — pickle.loads runs whatever the upstream encoded, including `os.system(...)` via __reduce__. Calling it on attacker-controlled input is an RCE primitive: any POST body becomes arbitrary Python execution in your worker. The pattern hits IDS / monitoring tools that 'just deserialize the alert' especially often.",
    verify_prompt:
      "Is the input to pickle.loads attacker-reachable?\n" +
      "1. The argument is request body / form data / query parameter / cookie value — CONFIRMED.\n" +
      "2. The argument is a value loaded from an internal trusted file (config that the app itself wrote earlier in the same process) — borderline FALSE_POSITIVE.\n" +
      "3. The pickle call is in a helper that's only invoked from a CLI tool, not the web surface — FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template:
      "Replace pickle with JSON / msgpack / Pydantic. If you genuinely need to round-trip Python objects, sign the pickle with HMAC and verify before loads — or better, accept JSON and reconstruct objects yourself with explicit schemas.",
  },
  {
    id: "fastapi-005-route-no-auth-on-mutation",
    title: "FastAPI mutation endpoint without a Depends(...) auth dependency",
    severity: "high",
    languages: ["python"],
    pack: "web",
    // @app.post / @router.put / @router.patch / @router.delete decorator
    // immediately followed by a function definition that has NO
    // Depends() argument referencing user/auth/token/session/principal.
    // The lookbehind window covers a typical short function signature.
    regex: /^@(?:app|router)\.(?:post|put|patch|delete)\([^)]*\)\s*\n(?:async\s+)?def\s+\w+\s*\((?![^)]*Depends\([^)]*(?:user|auth|token|session|principal|current))[^)]{0,400}\):/gm,
    explanation:
      "FastAPI mutation endpoints (POST/PUT/PATCH/DELETE) without an auth Depends are public. The framework gives you ergonomic dependency injection (`user: User = Depends(get_current_user)`) precisely so this gate is the same shape on every endpoint. A mutation route without it accepts ANY anonymous client. The pattern almost always slips in via 'I'll add auth later' commits that never get the follow-up.",
    verify_prompt:
      "Is the endpoint actually unauthenticated?\n" +
      "1. The function signature has a Depends call that yields a user/session/token (Depends(get_current_user), Depends(verify_jwt), etc.) — FALSE_POSITIVE.\n" +
      "2. The signature has NO Depends and no obvious auth check at the top of the body — CONFIRMED.\n" +
      "3. Auth is handled by an upstream APIRouter dependency (router = APIRouter(dependencies=[Depends(...)])) — FALSE_POSITIVE; the verifier should mention this.\n" +
      "4. The route is documented as public (login, register, /health) — FALSE_POSITIVE.",
    cwe: "CWE-862",
    fix_template:
      "Add `user: User = Depends(get_current_user)` to the function signature, or attach `dependencies=[Depends(verify_user)]` to the router. For routes that genuinely should be public, leave a comment explaining why so the next audit knows to skip.",
  },
];
