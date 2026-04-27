import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createVAPIDJWT,
  encryptPayload,
  generateVAPIDKeys,
  getSubscriptions,
  loadOrCreateVAPIDKeys,
  type PushPayload,
  type PushSubscription,
  removeSubscription,
  saveSubscription,
  type VAPIDKeys,
} from "./push-notifications";

// ─── Test helpers ───────────────────────────────────────────────

const TEST_DIR = join("/tmp", `kcode-push-test-${process.pid}`);

function base64urlDecode(str: string): Buffer {
  let padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const mod = padded.length % 4;
  if (mod === 2) padded += "==";
  else if (mod === 3) padded += "=";
  return Buffer.from(padded, "base64");
}

function base64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeFakeSubscription(id: number = 1): PushSubscription {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://push.example.com/sub/${id}`,
    keys: {
      p256dh: base64urlEncode(ecdh.getPublicKey()),
      auth: base64urlEncode(Buffer.from("fake-auth-secret!")),
    },
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.KCODE_HOME = TEST_DIR;
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.KCODE_HOME;
});

// ─── VAPID Key Generation ───────────────────────────────────────

describe("generateVAPIDKeys", () => {
  test("returns base64url-encoded public and private keys", () => {
    const keys = generateVAPIDKeys();
    expect(keys.publicKey).toBeDefined();
    expect(keys.privateKey).toBeDefined();
    expect(typeof keys.publicKey).toBe("string");
    expect(typeof keys.privateKey).toBe("string");
  });

  test("public key decodes to 65-byte uncompressed EC point", () => {
    const keys = generateVAPIDKeys();
    const pubBytes = base64urlDecode(keys.publicKey);
    expect(pubBytes.length).toBe(65);
    // Uncompressed point starts with 0x04
    expect(pubBytes[0]).toBe(0x04);
  });

  test("private key decodes to 32 bytes", () => {
    const keys = generateVAPIDKeys();
    const privBytes = base64urlDecode(keys.privateKey);
    expect(privBytes.length).toBe(32);
  });

  test("generates unique keys each call", () => {
    const a = generateVAPIDKeys();
    const b = generateVAPIDKeys();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  test("key pair is valid P-256 (can compute shared secret)", () => {
    const keys = generateVAPIDKeys();
    const pubBytes = base64urlDecode(keys.publicKey);
    const privBytes = base64urlDecode(keys.privateKey);

    // Use another ECDH instance to verify the key pair works
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privBytes);
    const derivedPub = ecdh.getPublicKey();
    expect(Buffer.compare(derivedPub, pubBytes)).toBe(0);
  });
});

// ─── VAPID Key Persistence ──────────────────────────────────────

describe("loadOrCreateVAPIDKeys", () => {
  test("generates and saves keys on first call", async () => {
    const keys = await loadOrCreateVAPIDKeys();
    expect(keys.publicKey).toBeDefined();
    expect(keys.privateKey).toBeDefined();

    // File should exist now
    const file = Bun.file(join(TEST_DIR, "vapid-keys.json"));
    expect(await file.exists()).toBe(true);
    const saved = await file.json();
    expect(saved.publicKey).toBe(keys.publicKey);
  });

  test("returns same keys on subsequent calls", async () => {
    const first = await loadOrCreateVAPIDKeys();
    const second = await loadOrCreateVAPIDKeys();
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);
  });

  test("regenerates if file is corrupt", async () => {
    await Bun.write(join(TEST_DIR, "vapid-keys.json"), "not json{{{");
    const keys = await loadOrCreateVAPIDKeys();
    expect(keys.publicKey).toBeDefined();
    expect(base64urlDecode(keys.publicKey).length).toBe(65);
  });
});

// ─── Subscription Management ────────────────────────────────────

describe("subscription save/load/remove", () => {
  test("getSubscriptions returns empty array initially", async () => {
    const subs = await getSubscriptions();
    expect(subs).toEqual([]);
  });

  test("saveSubscription stores a subscription", async () => {
    const sub = makeFakeSubscription(1);
    await saveSubscription(sub);
    const subs = await getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.endpoint).toBe(sub.endpoint);
    expect(subs[0]!.keys.p256dh).toBe(sub.keys.p256dh);
  });

  test("saveSubscription deduplicates by endpoint", async () => {
    const sub = makeFakeSubscription(1);
    await saveSubscription(sub);
    await saveSubscription({ ...sub, keys: { ...sub.keys, auth: "updated" } });
    const subs = await getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.keys.auth).toBe("updated");
  });

  test("saveSubscription allows multiple endpoints", async () => {
    await saveSubscription(makeFakeSubscription(1));
    await saveSubscription(makeFakeSubscription(2));
    await saveSubscription(makeFakeSubscription(3));
    const subs = await getSubscriptions();
    expect(subs).toHaveLength(3);
  });

  test("removeSubscription removes matching endpoint", async () => {
    const sub1 = makeFakeSubscription(1);
    const sub2 = makeFakeSubscription(2);
    await saveSubscription(sub1);
    await saveSubscription(sub2);

    const removed = await removeSubscription(sub1.endpoint);
    expect(removed).toBe(true);

    const subs = await getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.endpoint).toBe(sub2.endpoint);
  });

  test("removeSubscription returns false for unknown endpoint", async () => {
    await saveSubscription(makeFakeSubscription(1));
    const removed = await removeSubscription("https://not-found.example.com/sub/999");
    expect(removed).toBe(false);
    const subs = await getSubscriptions();
    expect(subs).toHaveLength(1);
  });
});

// ─── Push Payload Encryption ────────────────────────────────────

describe("encryptPayload", () => {
  test("returns encrypted body and required headers", () => {
    const sub = makeFakeSubscription(1);
    const payload = Buffer.from(JSON.stringify({ title: "Test", body: "Hello" }));
    const result = encryptPayload(sub.keys.p256dh, sub.keys.auth, payload);

    expect(result.body).toBeInstanceOf(Buffer);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.headers["Content-Type"]).toBe("application/octet-stream");
    expect(result.headers["Content-Encoding"]).toBe("aesgcm");
    expect(result.headers["Crypto-Key"]).toMatch(/^dh=/);
    expect(result.headers["Encryption"]).toMatch(/^salt=/);
  });

  test("produces different ciphertext each call (random salt)", () => {
    const sub = makeFakeSubscription(1);
    const payload = Buffer.from("same input");
    const a = encryptPayload(sub.keys.p256dh, sub.keys.auth, payload);
    const b = encryptPayload(sub.keys.p256dh, sub.keys.auth, payload);
    expect(Buffer.compare(a.body, b.body)).not.toBe(0);
  });

  test("encrypted body is larger than plaintext (overhead)", () => {
    const sub = makeFakeSubscription(1);
    const plaintext = Buffer.from("short");
    const result = encryptPayload(sub.keys.p256dh, sub.keys.auth, plaintext);
    // 2 bytes padding + AES-GCM 16-byte tag overhead
    expect(result.body.length).toBeGreaterThan(plaintext.length);
  });
});

// ─── VAPID JWT ──────────────────────────────────────────────────

describe("createVAPIDJWT", () => {
  test("produces a three-part JWT", () => {
    const keys = generateVAPIDKeys();
    const jwt = createVAPIDJWT("https://push.example.com", "mailto:test@kcode.dev", keys);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
  });

  test("header specifies ES256 algorithm", () => {
    const keys = generateVAPIDKeys();
    const jwt = createVAPIDJWT("https://push.example.com", "mailto:test@kcode.dev", keys);
    const header = JSON.parse(base64urlDecode(jwt.split(".")[0]!).toString());
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
  });

  test("payload contains correct audience and subject", () => {
    const keys = generateVAPIDKeys();
    const jwt = createVAPIDJWT("https://push.example.com", "mailto:test@kcode.dev", keys);
    const payload = JSON.parse(base64urlDecode(jwt.split(".")[1]!).toString());
    expect(payload.aud).toBe("https://push.example.com");
    expect(payload.sub).toBe("mailto:test@kcode.dev");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("signature is 64 bytes (raw ES256)", () => {
    const keys = generateVAPIDKeys();
    const jwt = createVAPIDJWT("https://push.example.com", "mailto:test@kcode.dev", keys);
    const sigBytes = base64urlDecode(jwt.split(".")[2]!);
    expect(sigBytes.length).toBe(64);
  });
});

// ─── Tool Approval Notification Format ──────────────────────────

describe("tool approval notification format", () => {
  test("constructs correct payload for tool approval", () => {
    const toolName = "Bash";
    const toolInput = { command: "rm -rf /tmp/test" };

    const payload: PushPayload = {
      title: `KCode: ${toolName} requires approval`,
      body: JSON.stringify(toolInput).slice(0, 120),
      tag: "kcode-permission",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      actions: [
        { action: "allow", title: "Allow" },
        { action: "deny", title: "Deny" },
      ],
      data: {
        toolName,
        toolInput,
        permissionId: "perm-test-123",
        tag: "kcode-permission",
      },
    };

    expect(payload.title).toContain("Bash");
    expect(payload.title).toContain("requires approval");
    expect(payload.tag).toBe("kcode-permission");
    expect(payload.actions).toHaveLength(2);
    expect(payload.actions![0]!.action).toBe("allow");
    expect(payload.actions![1]!.action).toBe("deny");
    expect(payload.data?.toolName).toBe("Bash");
    expect(payload.data?.permissionId).toBe("perm-test-123");
  });

  test("body truncates long tool input to 120 chars", () => {
    const longInput = { command: "x".repeat(200) };
    const body = JSON.stringify(longInput).slice(0, 120);
    expect(body.length).toBe(120);
  });
});

// ─── Task Complete Notification Format ──────────────────────────

describe("task complete notification format", () => {
  test("constructs correct payload for task completion", () => {
    const summary = "Refactored 5 files and added 12 tests";

    const payload: PushPayload = {
      title: "KCode: Task Complete",
      body: summary,
      tag: "kcode-complete",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: {
        tag: "kcode-complete",
        completedAt: "2026-04-01T00:00:00.000Z",
      },
    };

    expect(payload.title).toBe("KCode: Task Complete");
    expect(payload.body).toBe(summary);
    expect(payload.tag).toBe("kcode-complete");
    expect(payload.data?.tag).toBe("kcode-complete");
    expect(payload.data?.completedAt).toBeDefined();
  });

  test("does not include action buttons", () => {
    const payload: PushPayload = {
      title: "KCode: Task Complete",
      body: "Done",
      tag: "kcode-complete",
    };

    expect(payload.actions).toBeUndefined();
  });
});
