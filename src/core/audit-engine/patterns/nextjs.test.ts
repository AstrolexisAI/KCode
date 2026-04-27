// P2.3 (v2.10.391) — Next.js framework pack tests.

import { describe, expect, test } from "bun:test";
import { NEXTJS_PATTERNS } from "./nextjs";

function findPattern(id: string) {
  const p = NEXTJS_PATTERNS.find((x) => x.id === id);
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

describe("next-001-getserversideprops-no-auth", () => {
  const p = findPattern("next-001-getserversideprops-no-auth");
  test("flags getServerSideProps using ctx.req", () => {
    const code = `export async function getServerSideProps(ctx) {
  const data = await db.query("SELECT * FROM users WHERE id = ?", [ctx.req.cookies.userId]);
  return { props: { data } };
}`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("flags getServerSideProps using ctx.query", () => {
    const code = `export const getServerSideProps = async (ctx) => {
  const slug = ctx.query.slug;
  return { props: { slug } };
};`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("does NOT flag a getServerSideProps that doesn't use req/query/params", () => {
    const code = `export async function getServerSideProps() {
  return { props: { time: Date.now() } };
}`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("next-002-server-action-no-auth", () => {
  const p = findPattern("next-002-server-action-no-auth");
  test("flags 'use server' file with exported async function", () => {
    const code = `"use server";

export async function deletePost(id: string) {
  await db.posts.delete({ where: { id } });
}`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("does NOT flag a regular module without 'use server'", () => {
    const code = `export async function helper() {
  return 42;
}`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("next-003-next-public-secret", () => {
  const p = findPattern("next-003-next-public-secret");
  test("flags NEXT_PUBLIC_API_TOKEN", () => {
    const code = `const token = process.env.NEXT_PUBLIC_API_TOKEN;`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags NEXT_PUBLIC_DATABASE_PASSWORD", () => {
    const code = `process.env.NEXT_PUBLIC_DATABASE_PASSWORD`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags NEXT_PUBLIC_CLIENT_SECRET", () => {
    const code = `NEXT_PUBLIC_CLIENT_SECRET=foo`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag NEXT_PUBLIC_APP_URL (non-secret name)", () => {
    const code = `process.env.NEXT_PUBLIC_APP_URL`;
    expect(matchAll(p, code).length).toBe(0);
  });
  test("does NOT flag NEXT_PUBLIC_GOOGLE_MAPS_ID", () => {
    const code = `process.env.NEXT_PUBLIC_GOOGLE_MAPS_ID`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("next-004-route-handler-no-auth", () => {
  const p = findPattern("next-004-route-handler-no-auth");
  test("flags POST handler reading request.json()", () => {
    const code = `export async function POST(request: Request) {
  const body = await request.json();
  await db.notes.create({ data: body });
  return Response.json({ ok: true });
}`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("flags GET handler reading cookies()", () => {
    const code = `export async function GET(request: Request) {
  const c = cookies();
  return Response.json({ user: c.get('uid')?.value });
}`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("does NOT flag a handler that returns static data", () => {
    const code = `export async function GET() {
  return Response.json({ status: "ok" });
}`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("next-005-redirect-from-query", () => {
  const p = findPattern("next-005-redirect-from-query");
  test("flags redirect(searchParams.get(...))", () => {
    const code = `redirect(searchParams.get('next'))`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags router.push(query.from)", () => {
    const code = `router.push(router.query.from);`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("flags NextResponse.redirect(searchParams.get(...))", () => {
    const code = `return NextResponse.redirect(req.nextUrl.searchParams.get('redirect'))`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag a static redirect", () => {
    const code = `redirect('/dashboard')`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

// ─── Pack invariants ─────────────────────────────────────────────

describe("NEXTJS_PATTERNS pack invariants", () => {
  test("every pattern has pack='web'", () => {
    for (const p of NEXTJS_PATTERNS) {
      expect(p.pack).toBe("web");
    }
  });
  test("every pattern has a CWE", () => {
    for (const p of NEXTJS_PATTERNS) {
      expect(p.cwe).toBeTruthy();
    }
  });
  test("every pattern targets javascript or typescript", () => {
    for (const p of NEXTJS_PATTERNS) {
      const langs = p.languages as string[];
      expect(langs.includes("javascript") || langs.includes("typescript")).toBe(true);
    }
  });
  test("every pattern id is unique and starts with next-", () => {
    const ids = NEXTJS_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("next-")).toBe(true);
  });
});
