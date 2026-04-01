// KCode - Stripe Payments Integration
// Handles Pro subscription lifecycle: create checkout, verify, manage billing

import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "./logger";
import { kcodeHome, kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface PaymentConfig {
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  priceId?: string;
  portalReturnUrl?: string;
}

export interface CheckoutSession {
  url: string;
  sessionId: string;
}

export interface SubscriptionStatus {
  active: boolean;
  customerId?: string;
  subscriptionId?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  plan?: string;
}

export interface WebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

// ─── Constants ──────────────────────────────────────────────────

const STRIPE_API_BASE = "https://api.stripe.com/v1";
// Resolved lazily via kcodePath() so KCODE_HOME overrides work in tests
function enterpriseConfigFile(): string {
  return kcodePath("enterprise.json");
}

// ─── Config Loading ─────────────────────────────────────────────

/**
 * Load payment configuration from environment variables or enterprise config.
 * Priority: env vars > ~/.kcode/enterprise.json
 */
export async function loadPaymentConfig(): Promise<PaymentConfig> {
  const config: PaymentConfig = {};

  // Try env vars first (highest priority)
  if (process.env.STRIPE_SECRET_KEY) {
    config.stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  }
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    config.stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  }
  if (process.env.STRIPE_PRICE_ID) {
    config.priceId = process.env.STRIPE_PRICE_ID;
  }
  if (process.env.STRIPE_PORTAL_RETURN_URL) {
    config.portalReturnUrl = process.env.STRIPE_PORTAL_RETURN_URL;
  }

  // Fall back to enterprise config file for missing values
  try {
    const file = Bun.file(enterpriseConfigFile());
    if (await file.exists()) {
      const raw = await file.json();
      const stripe = raw?.stripe ?? raw;
      if (!config.stripeSecretKey && stripe?.secretKey) {
        config.stripeSecretKey = stripe.secretKey;
      }
      if (!config.stripeWebhookSecret && stripe?.webhookSecret) {
        config.stripeWebhookSecret = stripe.webhookSecret;
      }
      if (!config.priceId && stripe?.priceId) {
        config.priceId = stripe.priceId;
      }
      if (!config.portalReturnUrl && stripe?.portalReturnUrl) {
        config.portalReturnUrl = stripe.portalReturnUrl;
      }
    }
  } catch (err) {
    log.debug("general", `Failed to load enterprise config: ${err}`);
  }

  return config;
}

// ─── Stripe API Helpers ─────────────────────────────────────────

/**
 * Make an authenticated request to the Stripe API.
 * Uses fetch with form-encoded body (Stripe convention).
 */
async function stripeRequest(
  method: string,
  path: string,
  secretKey: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `${STRIPE_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const options: RequestInit = { method, headers };
  if (params && (method === "POST" || method === "PUT")) {
    options.body = new URLSearchParams(params).toString();
  }

  const resp = await fetch(url, options);
  const body = (await resp.json()) as Record<string, unknown>;

  if (!resp.ok) {
    const errMsg =
      (body.error as Record<string, unknown>)?.message ?? `Stripe API error: ${resp.status}`;
    throw new Error(String(errMsg));
  }

  return body;
}

// ─── Checkout ───────────────────────────────────────────────────

/**
 * Create a Stripe Checkout session for Pro subscription.
 * Returns a URL to redirect the user to Stripe's hosted payment page.
 */
export async function createCheckoutSession(
  email: string,
  successUrl: string,
  cancelUrl: string,
): Promise<CheckoutSession> {
  const config = await loadPaymentConfig();

  if (!config.stripeSecretKey) {
    throw new Error("Stripe secret key not configured. Set STRIPE_SECRET_KEY env var.");
  }
  if (!config.priceId) {
    throw new Error("Stripe price ID not configured. Set STRIPE_PRICE_ID env var.");
  }

  const params: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": config.priceId,
    "line_items[0][quantity]": "1",
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  log.info("general", `Creating checkout session for ${email}`);
  const session = await stripeRequest("POST", "/checkout/sessions", config.stripeSecretKey, params);

  return {
    url: session.url as string,
    sessionId: session.id as string,
  };
}

// ─── Subscription Status ────────────────────────────────────────

/**
 * Get the current subscription status for a Stripe customer.
 * Returns the most recent active or trialing subscription.
 */
export async function getSubscriptionStatus(customerId: string): Promise<SubscriptionStatus> {
  const config = await loadPaymentConfig();

  if (!config.stripeSecretKey) {
    throw new Error("Stripe secret key not configured. Set STRIPE_SECRET_KEY env var.");
  }

  const result = await stripeRequest(
    "GET",
    `/customers/${encodeURIComponent(customerId)}/subscriptions`,
    config.stripeSecretKey,
  );

  const subscriptions = (result.data ?? []) as Array<Record<string, unknown>>;

  // Find an active or trialing subscription
  const activeSub = subscriptions.find(
    (sub) => sub.status === "active" || sub.status === "trialing",
  );

  if (!activeSub) {
    return { active: false, customerId };
  }

  // Extract plan name from the first item
  const items = (activeSub.items as Record<string, unknown>)?.data as
    | Array<Record<string, unknown>>
    | undefined;
  const planName = items?.[0]
    ? ((items[0].price as Record<string, unknown>)?.nickname as string) ?? "Pro"
    : "Pro";

  return {
    active: true,
    customerId,
    subscriptionId: activeSub.id as string,
    currentPeriodEnd: activeSub.current_period_end as number,
    cancelAtPeriodEnd: activeSub.cancel_at_period_end as boolean,
    plan: planName,
  };
}

// ─── Billing Portal ─────────────────────────────────────────────

/**
 * Create a Stripe Billing Portal session so the customer can manage
 * their subscription (cancel, update payment method, etc.).
 */
export async function createPortalSession(
  customerId: string,
): Promise<{ url: string }> {
  const config = await loadPaymentConfig();

  if (!config.stripeSecretKey) {
    throw new Error("Stripe secret key not configured. Set STRIPE_SECRET_KEY env var.");
  }

  const params: Record<string, string> = {
    customer: customerId,
  };
  if (config.portalReturnUrl) {
    params.return_url = config.portalReturnUrl;
  }

  const session = await stripeRequest(
    "POST",
    "/billing_portal/sessions",
    config.stripeSecretKey,
    params,
  );

  return { url: session.url as string };
}

// ─── Webhook Verification ───────────────────────────────────────

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * Stripe signs webhooks with the format: t=<timestamp>,v1=<signature>
 *
 * Tolerance: rejects events older than 5 minutes to prevent replay attacks.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  try {
    const parts = signature.split(",");
    const timestampPart = parts.find((p) => p.startsWith("t="));
    const signaturePart = parts.find((p) => p.startsWith("v1="));

    if (!timestampPart || !signaturePart) {
      log.warn("general", "Webhook signature missing t= or v1= component");
      return false;
    }

    const timestamp = timestampPart.slice(2);
    const expectedSig = signaturePart.slice(3);

    // Replay protection: reject events older than 5 minutes
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (age > 300) {
      log.warn("general", `Webhook timestamp too old: ${age}s`);
      return false;
    }

    // Compute expected signature: HMAC-SHA256(secret, "timestamp.payload")
    const signedPayload = `${timestamp}.${payload}`;
    const computedSig = createHmac("sha256", secret).update(signedPayload).digest("hex");

    // Timing-safe comparison to prevent timing attacks
    const a = Buffer.from(expectedSig, "hex");
    const b = Buffer.from(computedSig, "hex");

    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch (err) {
    log.error("general", `Webhook signature verification failed: ${err}`);
    return false;
  }
}

// ─── Webhook Event Handling ─────────────────────────────────────

/**
 * Process a Stripe webhook event.
 * Handles subscription lifecycle events to activate/deactivate Pro.
 */
export async function handleWebhookEvent(event: WebhookEvent): Promise<void> {
  log.info("general", `Processing webhook event: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Record<string, unknown> | undefined;
      const email = (session?.customer_email ?? session?.customer_details?.email) as
        | string
        | undefined;
      const customerId = session?.customer as string | undefined;

      if (email && customerId) {
        await activateProFromPayment(email, customerId);
        log.info("general", `Pro activated for ${email} (customer: ${customerId})`);
      } else {
        log.warn("general", "checkout.session.completed missing email or customer ID");
      }
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Record<string, unknown> | undefined;
      const status = subscription?.status as string | undefined;
      const customerId = subscription?.customer as string | undefined;

      if (status === "active" || status === "trialing") {
        log.info("general", `Subscription active for customer ${customerId}`);
      } else if (status === "canceled" || status === "unpaid" || status === "past_due") {
        log.warn("general", `Subscription ${status} for customer ${customerId}`);
        // Note: we don't auto-deactivate here — the validation server handles that.
        // This event is logged for observability.
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Record<string, unknown> | undefined;
      const customerId = subscription?.customer as string | undefined;
      log.warn("general", `Subscription deleted for customer ${customerId}`);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Record<string, unknown> | undefined;
      const customerId = invoice?.customer as string | undefined;
      log.warn("general", `Payment failed for customer ${customerId}`);
      break;
    }

    default:
      log.debug("general", `Unhandled webhook event type: ${event.type}`);
  }
}

// ─── Pro Activation ─────────────────────────────────────────────

/**
 * Activate Pro tier after a successful Stripe payment.
 * Generates a pro key and saves it to user settings.
 *
 * The key format is: kcode_pro_<customerId_hash><random><checksum>
 * This ties the key to the Stripe customer for server-side validation.
 */
export async function activateProFromPayment(
  email: string,
  customerId: string,
): Promise<string> {
  const { randomBytes, createHash } = await import("node:crypto");

  // Generate a deterministic prefix from customer ID (for server-side lookup)
  const customerHash = createHash("sha256").update(customerId).digest("hex").slice(0, 12);

  // Add random entropy
  const entropy = randomBytes(16).toString("hex");

  // Assemble key body (without checksum)
  const body = `${customerHash}${entropy}`;

  // Compute checksum: first 2 hex chars of SHA-256(body)
  const checksum = createHash("sha256").update(body).digest("hex").slice(0, 2);

  const proKey = `kcode_pro_${body}${checksum}`;

  // Save to user settings
  const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("./config.js");
  const settings = await loadUserSettingsRaw();
  settings.proKey = proKey;
  await saveUserSettingsRaw(settings);

  // Also save the customer mapping for future billing portal access
  try {
    const mappingFile = Bun.file(kcodePath("stripe-customer.json"));
    await Bun.write(
      mappingFile,
      JSON.stringify({ email, customerId, activatedAt: new Date().toISOString() }, null, 2) + "\n",
    );
  } catch (err) {
    log.debug("general", `Failed to save Stripe customer mapping: ${err}`);
  }

  log.info("general", `Pro key generated and saved for ${email}`);

  // Clear the pro validation cache so isPro() picks up the new key
  const { clearProCache } = await import("./pro");
  clearProCache();

  return proKey;
}
