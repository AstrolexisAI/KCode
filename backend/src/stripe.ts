// KCode Backend — Stripe API helpers
// Uses fetch directly (no Stripe SDK dependency)

import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API = "https://api.stripe.com/v1";

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return key;
}

// ─── API request helper ───────────────────────────────────────

async function stripeRequest(
  method: string,
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `${STRIPE_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getSecretKey()}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const options: RequestInit = { method, headers };
  if (params && (method === "POST" || method === "PUT")) {
    options.body = new URLSearchParams(params).toString();
  }

  const resp = await fetch(url, options);
  const body = (await resp.json()) as Record<string, unknown>;

  if (!resp.ok) {
    const errMsg = (body.error as Record<string, unknown>)?.message ?? `Stripe error: ${resp.status}`;
    throw new Error(String(errMsg));
  }

  return body;
}

// ─── Checkout session ─────────────────────────────────────────

export interface CheckoutOptions {
  email: string;
  plan: "pro" | "team";
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(opts: CheckoutOptions): Promise<{ url: string; sessionId: string }> {
  const priceId = opts.plan === "team"
    ? process.env.STRIPE_PRICE_ID_TEAM
    : process.env.STRIPE_PRICE_ID_PRO;

  if (!priceId) throw new Error(`STRIPE_PRICE_ID_${opts.plan.toUpperCase()} not set`);

  const params: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    customer_email: opts.email,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    "subscription_data[metadata][plan]": opts.plan,
    allow_promotion_codes: "true",
  };

  const session = await stripeRequest("POST", "/checkout/sessions", params);
  return {
    url: session.url as string,
    sessionId: session.id as string,
  };
}

// ─── Billing portal ───────────────────────────────────────────

export async function createPortalSession(customerId: string, returnUrl?: string): Promise<{ url: string }> {
  const params: Record<string, string> = { customer: customerId };
  if (returnUrl) params.return_url = returnUrl;

  const session = await stripeRequest("POST", "/billing_portal/sessions", params);
  return { url: session.url as string };
}

// ─── Customer lookup ──────────────────────────────────────────

export async function getStripeCustomer(customerId: string): Promise<Record<string, unknown>> {
  return stripeRequest("GET", `/customers/${encodeURIComponent(customerId)}`);
}

export async function getSubscriptions(customerId: string): Promise<Array<Record<string, unknown>>> {
  const result = await stripeRequest("GET", `/customers/${encodeURIComponent(customerId)}/subscriptions`);
  return (result.data ?? []) as Array<Record<string, unknown>>;
}

// ─── Webhook signature verification ──────────────────────────

export function verifyWebhookSignature(payload: string, signature: string): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");

  try {
    const parts = signature.split(",");
    const timestampPart = parts.find((p) => p.startsWith("t="));
    const signaturePart = parts.find((p) => p.startsWith("v1="));
    if (!timestampPart || !signaturePart) return false;

    const timestamp = timestampPart.slice(2);
    const expectedSig = signaturePart.slice(3);

    // Reject events older than 5 minutes (replay protection)
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (age > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const computedSig = createHmac("sha256", secret).update(signedPayload).digest("hex");

    const a = Buffer.from(expectedSig, "hex");
    const b = Buffer.from(computedSig, "hex");
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
