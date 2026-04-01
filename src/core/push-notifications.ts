// KCode - Web Push Notifications
// Server-side push notification support for the PWA dashboard

import { createECDH, createHmac, createSign, randomBytes } from "node:crypto";
import { join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface VAPIDKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
  actions?: Array<{ action: string; title: string }>;
}

// ─── Base64url helpers ──────────────────────────────────────────

function base64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  // Restore padding
  let padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const mod = padded.length % 4;
  if (mod === 2) padded += "==";
  else if (mod === 3) padded += "=";
  return Buffer.from(padded, "base64");
}

// ─── VAPID Key Management ───────────────────────────────────────

/**
 * Generate an ECDH P-256 key pair for VAPID, returned as base64url strings.
 */
export function generateVAPIDKeys(): VAPIDKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();

  // Public key: uncompressed 65-byte point
  const publicKey = base64urlEncode(ecdh.getPublicKey());
  // Private key: 32-byte scalar
  const privateKey = base64urlEncode(ecdh.getPrivateKey());

  return { publicKey, privateKey };
}

/**
 * Load VAPID keys from ~/.kcode/vapid-keys.json, or generate and save new ones.
 */
export async function loadOrCreateVAPIDKeys(): Promise<VAPIDKeys> {
  const keysPath = kcodePath("vapid-keys.json");

  try {
    const file = Bun.file(keysPath);
    if (await file.exists()) {
      const content = await file.json();
      if (content.publicKey && content.privateKey) {
        log.info("push", `Loaded VAPID keys from ${keysPath}`);
        return content as VAPIDKeys;
      }
    }
  } catch {
    // File missing or corrupt — generate fresh keys
  }

  const keys = generateVAPIDKeys();
  await Bun.write(keysPath, JSON.stringify(keys, null, 2));
  log.info("push", `Generated new VAPID keys at ${keysPath}`);
  return keys;
}

// ─── Subscription Management ────────────────────────────────────

function subscriptionsPath(): string {
  return kcodePath("push-subscriptions.json");
}

async function loadSubscriptionsFile(): Promise<PushSubscription[]> {
  try {
    const file = Bun.file(subscriptionsPath());
    if (await file.exists()) {
      const data = await file.json();
      if (Array.isArray(data)) return data;
    }
  } catch {
    // Corrupt or missing — start fresh
  }
  return [];
}

async function writeSubscriptionsFile(subs: PushSubscription[]): Promise<void> {
  await Bun.write(subscriptionsPath(), JSON.stringify(subs, null, 2));
}

/**
 * Save a push subscription. Deduplicates by endpoint.
 */
export async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const subs = await loadSubscriptionsFile();
  const idx = subs.findIndex((s) => s.endpoint === subscription.endpoint);
  if (idx >= 0) {
    subs[idx] = subscription;
  } else {
    subs.push(subscription);
  }
  await writeSubscriptionsFile(subs);
  log.info("push", `Saved subscription for ${subscription.endpoint}`);
}

/**
 * Remove a subscription by its endpoint URL.
 */
export async function removeSubscription(endpoint: string): Promise<boolean> {
  const subs = await loadSubscriptionsFile();
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  if (filtered.length === subs.length) return false;
  await writeSubscriptionsFile(filtered);
  log.info("push", `Removed subscription for ${endpoint}`);
  return true;
}

/**
 * List all saved push subscriptions.
 */
export async function getSubscriptions(): Promise<PushSubscription[]> {
  return loadSubscriptionsFile();
}

// ─── Push Encryption (RFC 8291 / aes128gcm) ────────────────────

/**
 * Build the info parameter for HKDF as specified in RFC 8291.
 */
function buildInfo(
  type: "aesgcm" | "nonce",
  clientPublicKey: Buffer,
  serverPublicKey: Buffer,
): Buffer {
  const label = Buffer.from(`Content-Encoding: ${type}\0`);
  const clientLen = Buffer.alloc(2);
  clientLen.writeUInt16BE(clientPublicKey.length, 0);
  const serverLen = Buffer.alloc(2);
  serverLen.writeUInt16BE(serverPublicKey.length, 0);

  return Buffer.concat([
    label,
    Buffer.from("P-256\0"),
    clientLen,
    clientPublicKey,
    serverLen,
    serverPublicKey,
  ]);
}

/**
 * HKDF-SHA-256 extract + expand (RFC 5869), single-block only (output <= 32 bytes).
 */
function hkdf(
  salt: Buffer,
  ikm: Buffer,
  info: Buffer,
  length: number,
): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const infoHash = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  return infoHash.subarray(0, length);
}

/**
 * Encrypt a push payload per RFC 8291 (aes128gcm content encoding).
 * Returns the encrypted body and required headers.
 */
export function encryptPayload(
  clientPublicKeyBase64: string,
  clientAuthBase64: string,
  payload: Buffer,
): { body: Buffer; headers: Record<string, string> } {
  const clientPublicKey = base64urlDecode(clientPublicKeyBase64);
  const clientAuth = base64urlDecode(clientAuthBase64);

  // Generate ephemeral ECDH key pair
  const serverECDH = createECDH("prime256v1");
  serverECDH.generateKeys();
  const serverPublicKey = serverECDH.getPublicKey();

  // Compute shared secret
  const sharedSecret = serverECDH.computeSecret(clientPublicKey);

  // Derive auth info
  const authInfo = Buffer.concat([
    Buffer.from("Content-Encoding: auth\0"),
  ]);

  // IKM from auth secret
  const ikm = hkdf(clientAuth, sharedSecret, authInfo, 32);

  // Generate 16-byte salt
  const salt = randomBytes(16);

  // Derive content encryption key and nonce
  const contentKey = hkdf(
    salt,
    ikm,
    buildInfo("aesgcm", clientPublicKey, serverPublicKey),
    16,
  );
  const nonce = hkdf(
    salt,
    ikm,
    buildInfo("nonce", clientPublicKey, serverPublicKey),
    12,
  );

  // Pad payload with 2-byte padding length prefix (0 padding)
  const padding = Buffer.alloc(2, 0);
  const padded = Buffer.concat([padding, payload]);

  // Encrypt with AES-128-GCM
  const crypto = require("node:crypto");
  const cipher = crypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  const body = Buffer.concat([encrypted, tag]);

  return {
    body,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aesgcm",
      "Crypto-Key": `dh=${base64urlEncode(serverPublicKey)}`,
      Encryption: `salt=${base64urlEncode(salt)}`,
    },
  };
}

// ─── VAPID JWT ──────────────────────────────────────────────────

/**
 * Create a signed VAPID JWT for push service authentication.
 */
export function createVAPIDJWT(
  audience: string,
  subject: string,
  vapidKeys: VAPIDKeys,
  expSeconds: number = 12 * 60 * 60,
): string {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + expSeconds,
    sub: subject,
  };

  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const unsigned = `${headerB64}.${payloadB64}`;

  // Import the private key as JWK for ES256 signing
  const crypto = require("node:crypto");
  const privateKeyDer = base64urlDecode(vapidKeys.privateKey);
  const publicKeyDer = base64urlDecode(vapidKeys.publicKey);

  // Build a JWK from the raw key bytes
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(publicKeyDer.subarray(1, 33)),
    y: base64urlEncode(publicKeyDer.subarray(33, 65)),
    d: base64urlEncode(privateKeyDer),
  };

  const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const sign = createSign("SHA256");
  sign.update(unsigned);
  const derSig = sign.sign(key);

  // Convert DER signature to raw r||s (64 bytes) for JWT ES256
  const signature = derToRaw(derSig);

  return `${unsigned}.${base64urlEncode(signature)}`;
}

/**
 * Convert a DER-encoded ECDSA signature to raw 64-byte r||s format.
 */
function derToRaw(derSig: Buffer): Buffer {
  // DER: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
  let offset = 2; // skip 0x30 + total length
  // r
  const rLen = derSig[offset + 1];
  const r = derSig.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  // s
  const sLen = derSig[offset + 1];
  const s = derSig.subarray(offset + 2, offset + 2 + sLen);

  // Pad/trim to 32 bytes each
  const rPad = Buffer.alloc(32);
  r.copy(rPad, 32 - r.length > 0 ? 32 - r.length : 0, r.length > 32 ? r.length - 32 : 0);
  const sPad = Buffer.alloc(32);
  s.copy(sPad, 32 - s.length > 0 ? 32 - s.length : 0, s.length > 32 ? s.length - 32 : 0);

  return Buffer.concat([rPad, sPad]);
}

// ─── Send Push Notification ─────────────────────────────────────

/**
 * Send a push notification to a single subscription.
 * Constructs a VAPID-signed request with encrypted payload and POSTs to the push endpoint.
 */
export async function sendPushNotification(
  subscription: PushSubscription,
  payload: PushPayload,
  vapidKeys: VAPIDKeys,
  subject: string = "mailto:push@kcode.dev",
): Promise<{ success: boolean; status?: number; error?: string }> {
  try {
    const endpoint = new URL(subscription.endpoint);
    const audience = `${endpoint.protocol}//${endpoint.host}`;

    // Create VAPID authorization
    const jwt = createVAPIDJWT(audience, subject, vapidKeys);

    // Encrypt the payload
    const payloadBuffer = Buffer.from(JSON.stringify(payload));
    const encrypted = encryptPayload(
      subscription.keys.p256dh,
      subscription.keys.auth,
      payloadBuffer,
    );

    // POST to the push service
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        ...encrypted.headers,
        Authorization: `vapid t=${jwt}, k=${vapidKeys.publicKey}`,
        TTL: "86400",
        "Content-Length": String(encrypted.body.length),
      },
      body: encrypted.body,
    });

    if (response.status === 201 || response.status === 200) {
      log.info("push", `Push sent to ${subscription.endpoint}`);
      return { success: true, status: response.status };
    }

    // 404 or 410 means the subscription is expired — remove it
    if (response.status === 404 || response.status === 410) {
      await removeSubscription(subscription.endpoint);
      log.warn("push", `Subscription expired, removed: ${subscription.endpoint}`);
      return { success: false, status: response.status, error: "subscription_expired" };
    }

    const errorText = await response.text().catch(() => "");
    log.warn("push", `Push failed (${response.status}): ${errorText}`);
    return { success: false, status: response.status, error: errorText };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("push", `Push send error: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Broadcast a push notification to all saved subscriptions.
 */
export async function broadcastPush(
  payload: PushPayload,
  vapidKeys: VAPIDKeys,
): Promise<{ sent: number; failed: number }> {
  const subs = await getSubscriptions();
  let sent = 0;
  let failed = 0;

  for (const sub of subs) {
    const result = await sendPushNotification(sub, payload, vapidKeys);
    if (result.success) sent++;
    else failed++;
  }

  return { sent, failed };
}

// ─── High-Level Notification Helpers ────────────────────────────

/**
 * Send a tool-approval push notification with Allow/Deny actions.
 * Matches the service worker's "kcode-permission" tag handling.
 */
export async function notifyToolApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
  permissionId?: string,
): Promise<void> {
  const vapidKeys = await loadOrCreateVAPIDKeys();
  const inputSummary = JSON.stringify(toolInput).slice(0, 120);

  const payload: PushPayload = {
    title: `KCode: ${toolName} requires approval`,
    body: inputSummary,
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
      permissionId: permissionId ?? `perm-${Date.now()}`,
      tag: "kcode-permission",
    },
  };

  const result = await broadcastPush(payload, vapidKeys);
  log.info(
    "push",
    `Tool approval notification for ${toolName}: ${result.sent} sent, ${result.failed} failed`,
  );
}

/**
 * Send a task-completion push notification.
 */
export async function notifyTaskComplete(summary: string): Promise<void> {
  const vapidKeys = await loadOrCreateVAPIDKeys();

  const payload: PushPayload = {
    title: "KCode: Task Complete",
    body: summary,
    tag: "kcode-complete",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: {
      tag: "kcode-complete",
      completedAt: new Date().toISOString(),
    },
  };

  const result = await broadcastPush(payload, vapidKeys);
  log.info(
    "push",
    `Task complete notification: ${result.sent} sent, ${result.failed} failed`,
  );
}
