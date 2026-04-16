// Subscription client tests. Mocks the network so we never talk to
// the real astrolexis.space during CI.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSubscription,
  getSubscription,
  invalidateSubscriptionCache,
  type Subscription,
} from "./subscription";

let testHome: string;
let origHome: string | undefined;
let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  origHome = process.env.KCODE_HOME;
  origFetch = globalThis.fetch;
  testHome = join(tmpdir(), `kcode-sub-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testHome, { recursive: true });
  process.env.KCODE_HOME = testHome;
  invalidateSubscriptionCache();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.KCODE_HOME;
  else process.env.KCODE_HOME = origHome;
  globalThis.fetch = origFetch;
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  invalidateSubscriptionCache();
});

describe("getSubscription — network paths", () => {
  test("returns free/none when no OAuth token is configured", async () => {
    // No keychain token → fetchFromServer throws → fallback to free
    globalThis.fetch = async () => new Response("", { status: 500 });
    const sub = await getSubscription({ forceRefresh: true });
    expect(sub.tier).toBe("free");
    expect(sub.status).toBe("none");
  });

  test("uses disk cache when network fails", async () => {
    // Seed a disk cache
    const cachedSub: Subscription = {
      tier: "pro",
      features: ["pro", "swarm"],
      seats: 5,
      status: "active",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      customer: { email: "test@example.com" },
      fetchedAt: Date.now() - 2 * 60 * 60 * 1000, // 2h old — past TTL
    };
    writeFileSync(
      join(testHome, "subscription-cache.json"),
      JSON.stringify(cachedSub),
      "utf-8",
    );

    // Network fails
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const sub = await getSubscription({ forceRefresh: true });
    // Stale cache returned instead of failing
    expect(sub.tier).toBe("pro");
    expect(sub.customer?.email).toBe("test@example.com");
  });

  test("serves fresh disk cache without hitting network", async () => {
    const freshSub: Subscription = {
      tier: "pro",
      features: ["pro"],
      seats: 1,
      status: "active",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      fetchedAt: Date.now() - 1000, // 1s old — well within TTL
    };
    writeFileSync(
      join(testHome, "subscription-cache.json"),
      JSON.stringify(freshSub),
      "utf-8",
    );

    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response("", { status: 500 });
    };

    const sub = await getSubscription(); // no forceRefresh
    expect(sub.tier).toBe("pro");
    expect(fetchCalls).toBe(0); // disk cache served, no network
  });
});

describe("formatSubscription", () => {
  test("free tier message", () => {
    const text = formatSubscription({
      tier: "free",
      features: [],
      seats: 0,
      status: "none",
      expiresAt: 0,
      fetchedAt: Date.now(),
    });
    expect(text).toContain("Free tier");
    expect(text).toContain("/login");
  });

  test("active pro subscription with expiry", () => {
    const text = formatSubscription({
      tier: "pro",
      features: ["pro", "swarm"],
      seats: 5,
      status: "active",
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
      customer: { email: "user@acme.com", orgName: "Acme" },
      fetchedAt: Date.now(),
    });
    expect(text).toContain("pro");
    expect(text).toContain("active");
    expect(text).toContain("Seats: 5");
    expect(text).toContain("user@acme.com");
    expect(text).toContain("Acme");
  });

  test("lifetime subscription shows 'never'", () => {
    const text = formatSubscription({
      tier: "enterprise",
      features: ["enterprise"],
      seats: 100,
      status: "active",
      expiresAt: 0,
      fetchedAt: Date.now(),
    });
    expect(text).toContain("never");
  });
});
