// P2.3 (v2.10.391) — FastAPI framework pack tests.

import { describe, expect, test } from "bun:test";
import { FASTAPI_PATTERNS } from "./fastapi";

function findPattern(id: string) {
  const p = FASTAPI_PATTERNS.find((x) => x.id === id);
  if (!p) throw new Error(`Pattern not found: ${id}`);
  return p;
}

function matchAll(p: { regex: RegExp }, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  p.regex.lastIndex = 0;
  const re = new RegExp(p.regex.source, p.regex.flags);
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    out.push(m);
    if (!re.global) break;
    m = re.exec(text);
  }
  return out;
}

describe("fastapi-002-cors-wildcard-with-credentials", () => {
  const p = findPattern("fastapi-002-cors-wildcard-with-credentials");
  test("flags CORSMiddleware with allow_origins=['*'] + allow_credentials=True", () => {
    const code = `app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
)`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag CORSMiddleware with explicit origin list + credentials", () => {
    const code = `app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.example.com"],
    allow_credentials=True,
)`;
    expect(matchAll(p, code).length).toBe(0);
  });
  test("does NOT flag CORSMiddleware with wildcard but NO credentials", () => {
    const code = `app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
)`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("fastapi-003-jwt-no-verify", () => {
  const p = findPattern("fastapi-003-jwt-no-verify");
  test("flags jwt.decode with verify=False (PyJWT 1.x style)", () => {
    expect(matchAll(p, `claims = jwt.decode(token, verify=False)`).length).toBe(1);
  });
  test("flags jwt.decode with options verify_signature False", () => {
    const code = `claims = jwt.decode(token, options={"verify_signature": False})`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag jwt.decode with key + algorithms", () => {
    const code = `claims = jwt.decode(token, public_key, algorithms=["RS256"])`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("fastapi-004-pickle-from-request", () => {
  const p = findPattern("fastapi-004-pickle-from-request");
  test("flags pickle.loads(await request.body())", () => {
    const code = `data = pickle.loads(await request.body())`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags pickle.loads(payload) where payload is a request var", () => {
    const code = `payload_request = await request.json()
data = pickle.loads(payload_request)`;
    // The regex matches *payload* / *body* / *form_data* / *raw* / *request.body* etc.
    const direct = `data = pickle.loads(payload)`;
    expect(matchAll(p, direct).length).toBe(1);
  });
  test("does NOT flag pickle.loads(internal_cache_blob)", () => {
    const code = `data = pickle.loads(internal_cache_blob)`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("fastapi-005-route-no-auth-on-mutation", () => {
  const p = findPattern("fastapi-005-route-no-auth-on-mutation");
  test("flags @app.post without Depends auth", () => {
    const code = `@app.post("/users")
async def create_user(user: UserCreate):
    return await db.users.create(user)`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("flags @router.delete without Depends auth", () => {
    const code = `@router.delete("/posts/{post_id}")
def delete_post(post_id: int):
    db.delete(post_id)`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("does NOT flag a mutation with Depends(get_current_user)", () => {
    const code = `@app.post("/users")
async def create_user(user: UserCreate, current: User = Depends(get_current_user)):
    return await db.users.create(user)`;
    expect(matchAll(p, code).length).toBe(0);
  });
  test("does NOT flag a mutation with Depends(verify_token)", () => {
    const code = `@app.post("/users")
async def create_user(user: UserCreate, _: None = Depends(verify_token)):
    return await db.users.create(user)`;
    expect(matchAll(p, code).length).toBe(0);
  });
  test("does NOT flag a GET endpoint (only mutation verbs)", () => {
    const code = `@app.get("/users")
def list_users():
    return db.list_users()`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

// ─── Pack invariants ─────────────────────────────────────────────

describe("FASTAPI_PATTERNS pack invariants", () => {
  test("every pattern has pack='web'", () => {
    for (const p of FASTAPI_PATTERNS) {
      expect(p.pack).toBe("web");
    }
  });
  test("every pattern has a CWE", () => {
    for (const p of FASTAPI_PATTERNS) {
      expect(p.cwe).toBeTruthy();
    }
  });
  test("every pattern targets python", () => {
    for (const p of FASTAPI_PATTERNS) {
      expect(p.languages).toContain("python");
    }
  });
  test("every pattern id is unique and starts with fastapi-", () => {
    const ids = FASTAPI_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("fastapi-")).toBe(true);
  });
});
