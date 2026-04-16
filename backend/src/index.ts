// KCode Backend — API server for Pro subscriptions, trials, and webhooks
// Stack: Bun + Hono + SQLite (zero external deps beyond Hono)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import {
  createSession,
  deleteSession,
  findCustomerByKey,
  findCustomerByEmail,
  findCustomerByStripeId,
  findSessionUser,
  findTrialByEmail,
  findTrialByKey,
  findUserByEmail,
  insertTrial,
  insertUser,
  isWebhookProcessed,
  markTrialConverted,
  recordWebhookEvent,
  updateCustomerStatus,
  upsertCustomer,
} from "./db";
import { sendProKeyEmail, sendTrialKeyEmail } from "./email";
import { generateProKey, generateTrialKey, validateKeyChecksum } from "./keys";
import {
  authenticateBearer,
  handleAuthorize,
  handleAuthorizeConsent,
  handleToken,
} from "./oauth";
import {
  renderConsent,
  renderDashboard,
  renderHome,
  renderLogin,
  renderSignup,
} from "./pages";
import {
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature,
} from "./stripe";

const app = new Hono();

// ─── Middleware ───────────────────────────────────────────────

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "https://kulvex.ai";

app.use("*", logger());
app.use("/api/*", cors({
  origin: [CORS_ORIGIN, "http://localhost:4321", "http://localhost:3000"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
}));

// ─── Health check ─────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", service: "kcode-backend", timestamp: new Date().toISOString() }));

// ─── POST /api/pro/validate ──────────────────────────────────
// Called by the KCode CLI to validate a pro key.
// Returns { valid: true/false }

app.post("/api/pro/validate", async (c) => {
  try {
    const body = await c.req.json<{ key?: string }>();
    const key = body.key;

    if (!key || typeof key !== "string") {
      return c.json({ valid: false, error: "Missing key" }, 400);
    }

    // Check format
    if (!validateKeyChecksum(key)) {
      return c.json({ valid: false, error: "Invalid key format" }, 400);
    }

    // Trial keys: validate expiry locally
    if (key.startsWith("kcode_trial_")) {
      const trial = findTrialByKey(key);
      if (!trial) {
        return c.json({ valid: false, error: "Trial key not found" });
      }
      const expired = new Date(trial.expires_at) < new Date();
      return c.json({ valid: !expired && !trial.converted });
    }

    // Pro keys: check database
    const customer = findCustomerByKey(key);
    if (!customer) {
      return c.json({ valid: false, error: "Key not found" });
    }

    const valid = customer.status === "active" || customer.status === "trialing";
    return c.json({ valid, plan: customer.plan, status: customer.status });
  } catch (err) {
    console.error("[validate]", err);
    return c.json({ valid: false, error: "Internal error" }, 500);
  }
});

// ─── POST /api/pro/checkout-session ──────────────────────────
// Creates a Stripe Checkout session and returns the redirect URL.
// Called from the landing page form.

app.post("/api/pro/checkout-session", async (c) => {
  try {
    const body = await c.req.json<{ email?: string; plan?: string }>();
    const email = body.email?.trim().toLowerCase();
    const plan = (body.plan === "team" ? "team" : "pro") as "pro" | "team";

    if (!email || !email.includes("@")) {
      return c.json({ error: "Valid email required" }, 400);
    }

    const baseUrl = CORS_ORIGIN;
    const session = await createCheckoutSession({
      email,
      plan,
      successUrl: `${baseUrl}/pro/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/pro`,
    });

    return c.json({ url: session.url, sessionId: session.sessionId });
  } catch (err) {
    console.error("[checkout]", err);
    return c.json({ error: err instanceof Error ? err.message : "Checkout failed" }, 500);
  }
});

// ─── POST /api/pro/portal ────────────────────────────────────
// Creates a Stripe Billing Portal session for subscription management.
// Called by `kcode pro manage`.

app.post("/api/pro/portal", async (c) => {
  try {
    const body = await c.req.json<{ key?: string }>();
    const key = body.key;

    if (!key || typeof key !== "string") {
      return c.json({ error: "Missing key" }, 400);
    }

    const customer = findCustomerByKey(key);
    if (!customer) {
      return c.json({ error: "No subscription found for this key" }, 404);
    }

    const portal = await createPortalSession(
      customer.stripe_id,
      `${CORS_ORIGIN}/pro`,
    );

    return c.json({ url: portal.url });
  } catch (err) {
    console.error("[portal]", err);
    return c.json({ error: err instanceof Error ? err.message : "Portal failed" }, 500);
  }
});

// ─── POST /api/pro/trial ─────────────────────────────────────
// Generates a trial key and sends it via email.
// One trial per email address.

app.post("/api/pro/trial", async (c) => {
  try {
    const body = await c.req.json<{ email?: string }>();
    const email = body.email?.trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return c.json({ error: "Valid email required" }, 400);
    }

    // Check if already has a trial
    const existing = findTrialByEmail(email);
    if (existing) {
      const expired = new Date(existing.expires_at) < new Date();
      if (!expired && !existing.converted) {
        return c.json({
          error: "You already have an active trial",
          expires_at: existing.expires_at,
        }, 409);
      }
      if (existing.converted) {
        return c.json({ error: "Trial already used. Upgrade to Pro at kulvex.ai/pro" }, 409);
      }
      // Expired and not converted — allow a new trial? No, one per email.
      return c.json({ error: "Trial expired. Upgrade to Pro at kulvex.ai/pro" }, 409);
    }

    // Check if already a paying customer
    const customer = findCustomerByEmail(email);
    if (customer && customer.status === "active") {
      return c.json({ error: "You already have an active Pro subscription" }, 409);
    }

    const days = Number(process.env.TRIAL_DAYS) || 14;
    const trialKey = generateTrialKey(days);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    insertTrial(email, trialKey, expiresAt);
    await sendTrialKeyEmail(email, trialKey, days);

    return c.json({
      success: true,
      trial_key: trialKey,
      expires_at: expiresAt,
      days,
    });
  } catch (err) {
    console.error("[trial]", err);
    return c.json({ error: err instanceof Error ? err.message : "Trial creation failed" }, 500);
  }
});

// ─── POST /api/pro/webhook ───────────────────────────────────
// Stripe webhook receiver. Handles subscription lifecycle events.
// IMPORTANT: Uses raw body for signature verification.

app.post("/api/pro/webhook", async (c) => {
  try {
    const rawBody = await c.req.text();
    const signature = c.req.header("stripe-signature");

    if (!signature) {
      return c.json({ error: "Missing signature" }, 400);
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const event = JSON.parse(rawBody) as {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };

    // Idempotency: skip already-processed events
    if (isWebhookProcessed(event.id)) {
      return c.json({ received: true, skipped: true });
    }

    console.log(`[webhook] ${event.type} (${event.id})`);

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const email = (session.customer_email ?? (session.customer_details as Record<string, unknown>)?.email) as string | undefined;
        const stripeCustomerId = session.customer as string | undefined;
        const subscriptionId = session.subscription as string | undefined;
        const plan = ((session.metadata as Record<string, unknown>)?.plan as string) ?? "pro";

        if (email && stripeCustomerId) {
          const proKey = generateProKey(stripeCustomerId);

          upsertCustomer({
            stripeId: stripeCustomerId,
            email,
            proKey,
            plan,
            status: "active",
          });

          // Mark trial as converted if user had one
          markTrialConverted(email);

          // Send email with the key
          await sendProKeyEmail(email, proKey, plan);

          console.log(`[webhook] Pro activated: ${email} (${plan})`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const stripeCustomerId = sub.customer as string;
        const status = sub.status as string;

        if (status === "active" || status === "trialing") {
          updateCustomerStatus(stripeCustomerId, "active");
        } else if (status === "past_due") {
          updateCustomerStatus(stripeCustomerId, "past_due");
        } else if (status === "canceled" || status === "unpaid") {
          updateCustomerStatus(stripeCustomerId, status);
        }

        console.log(`[webhook] Subscription ${status}: ${stripeCustomerId}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const stripeCustomerId = sub.customer as string;
        updateCustomerStatus(stripeCustomerId, "canceled");
        console.log(`[webhook] Subscription deleted: ${stripeCustomerId}`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const stripeCustomerId = invoice.customer as string;
        console.log(`[webhook] Payment failed: ${stripeCustomerId}`);
        // Don't immediately deactivate — Stripe retries. Mark as past_due.
        updateCustomerStatus(stripeCustomerId, "past_due");
        break;
      }

      default:
        console.log(`[webhook] Unhandled: ${event.type}`);
    }

    recordWebhookEvent(event.id, event.type, rawBody);
    return c.json({ received: true });
  } catch (err) {
    console.error("[webhook]", err);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

// ─── GET /api/pro/success ────────────────────────────────────
// After Stripe checkout, look up the customer's key.
// The landing page redirects here with ?session_id=...

app.get("/api/pro/success", async (c) => {
  const sessionId = c.req.query("session_id");

  if (!sessionId) {
    return c.html(successPage(null, "Missing session ID. Check your email for the Pro key."));
  }

  // The webhook may not have fired yet — wait briefly
  let customer: ReturnType<typeof findCustomerByKey> = null;

  // Fetch the checkout session from Stripe to get the customer ID
  try {
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const session = (await resp.json()) as Record<string, unknown>;
    const stripeCustomerId = session.customer as string;

    if (stripeCustomerId) {
      // Try up to 5 times (webhook may be in flight)
      for (let i = 0; i < 5; i++) {
        customer = findCustomerByStripeId(stripeCustomerId);
        if (customer) break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      // If webhook hasn't fired yet, create the customer now
      if (!customer) {
        const email = (session.customer_email ?? (session.customer_details as Record<string, unknown>)?.email) as string;
        const plan = ((session.metadata as Record<string, unknown>)?.plan as string) ?? "pro";
        const proKey = generateProKey(stripeCustomerId);

        upsertCustomer({
          stripeId: stripeCustomerId,
          email,
          proKey,
          plan,
          status: "active",
        });

        markTrialConverted(email);
        await sendProKeyEmail(email, proKey, plan);

        customer = findCustomerByStripeId(stripeCustomerId);
      }
    }
  } catch (err) {
    console.error("[success]", err);
  }

  if (customer) {
    return c.html(successPage(customer.pro_key, null));
  }

  return c.html(successPage(null, "Your key is being generated. Check your email shortly."));
});

// ─── GET /api/admin/customers ────────────────────────────────
// Simple admin endpoint (protect with auth in production)

app.get("/api/admin/customers", async (c) => {
  const adminKey = c.req.header("x-admin-key");
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey || adminKey !== expectedKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { getDb: db } = await import("./db");
  const customers = db().query("SELECT id, email, plan, status, activated_at, created_at FROM customers ORDER BY created_at DESC LIMIT 100").all();
  const trials = db().query("SELECT id, email, expires_at, converted, created_at FROM trials ORDER BY created_at DESC LIMIT 100").all();

  return c.json({ customers, trials });
});

// ─── Success page HTML ───────────────────────────────────────

function successPage(proKey: string | null, message: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KCode Pro - Activated</title>
  <style>
    :root {
      --bg: #0d1117; --bg-surface: #161b22; --bg-card: #1c2128;
      --border: #30363d; --text: #e6edf3; --text-muted: #8b949e;
      --accent: #58a6ff; --green: #3fb950; --orange: #d29922;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", "Fira Code", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans); background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 3rem; max-width: 560px; width: 100%; text-align: center; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    .subtitle { color: var(--text-muted); margin-bottom: 2rem; }
    .key-box { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin: 1.5rem 0; text-align: left; position: relative; }
    .key-box code { font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); word-break: break-all; user-select: all; }
    .key-box .label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; display: block; }
    .cmd-box { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin: 1rem 0; text-align: left; }
    .cmd-box code { font-family: var(--font-mono); font-size: 0.9rem; color: var(--green); }
    .copy-btn { position: absolute; top: 0.75rem; right: 0.75rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text-muted); padding: 0.35rem 0.75rem; cursor: pointer; font-size: 0.8rem; }
    .copy-btn:hover { border-color: var(--accent); color: var(--accent); }
    .steps { text-align: left; margin: 1.5rem 0; }
    .steps li { color: var(--text-muted); margin: 0.5rem 0; padding-left: 0.5rem; }
    .steps li strong { color: var(--text); }
    .info { color: var(--text-muted); font-size: 0.85rem; margin-top: 1.5rem; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .msg { color: var(--orange); margin: 1rem 0; }
  </style>
</head>
<body>
  <div class="card">
    ${proKey ? `
      <div class="icon">&#9889;</div>
      <h1>KCode Pro Activated</h1>
      <p class="subtitle">Your Pro features are ready. Here's your key:</p>
      <div class="key-box">
        <span class="label">Pro Key</span>
        <code id="proKey">${proKey}</code>
        <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('proKey').textContent).then(()=>this.textContent='Copied!')">Copy</button>
      </div>
      <div class="cmd-box">
        <code>kcode pro activate ${proKey}</code>
      </div>
      <ol class="steps">
        <li><strong>Copy</strong> the key above</li>
        <li><strong>Run</strong> the command in your terminal</li>
        <li><strong>Done</strong> — all Pro features are unlocked</li>
      </ol>
      <p class="info">
        This key is also in your email. Manage your subscription: <code>kcode pro manage</code><br/>
        <a href="https://kulvex.ai/pro">Back to Pro page</a>
      </p>
    ` : `
      <div class="icon">&#9203;</div>
      <h1>Almost there...</h1>
      <p class="msg">${message ?? "Processing your payment..."}</p>
      <p class="info">
        Your Pro key will be sent to your email shortly.<br/>
        <a href="https://kulvex.ai/pro">Back to Pro page</a>
      </p>
    `}
  </div>
</body>
</html>`;
}

// ─── Web pages + auth ────────────────────────────────────────
//
// The astrolexis.space website: landing, login, signup, dashboard.
// Session cookies (kcode_sess) are HttpOnly+SameSite=Lax, scoped to
// the root. Bearer tokens for the API live in a separate table.

const SESSION_COOKIE = "kcode_sess";
const SESSION_TTL_DAYS = 30;

function setSessionCookie(
  c: import("hono").Context,
  sessionId: string,
): void {
  const maxAge = SESSION_TTL_DAYS * 86400;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(c: import("hono").Context): void {
  c.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function readSessionCookie(c: import("hono").Context): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m ? m[1] ?? null : null;
}

function currentUser(c: import("hono").Context) {
  const sessionId = readSessionCookie(c);
  if (!sessionId) return null;
  return findSessionUser(sessionId);
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

app.get("/", (c) => {
  const user = currentUser(c);
  return c.html(renderHome({ loggedIn: !!user }));
});

// ── Signup ─────────────────────────────────────────────────

app.get("/signup", (c) => {
  const next = c.req.query("next");
  return c.html(renderSignup({ next }));
});

app.post("/signup", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "");

  if (!isValidEmail(email)) {
    return c.html(renderSignup({ error: "Invalid email address.", next }), 400);
  }
  if (password.length < 10) {
    return c.html(renderSignup({ error: "Password must be at least 10 characters.", next }), 400);
  }
  if (findUserByEmail(email)) {
    return c.html(
      renderSignup({ error: "An account with that email already exists.", next }),
      400,
    );
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 19456, // 19 MiB (OWASP 2023)
    timeCost: 2,
  });
  const user = insertUser(email, passwordHash);
  const sessionId = createSession(user.id);
  setSessionCookie(c, sessionId);
  return c.redirect(next || "/dashboard");
});

// ── Login ──────────────────────────────────────────────────

app.get("/login", (c) => {
  const next = c.req.query("next");
  return c.html(renderLogin({ next }));
});

app.post("/login", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "");

  const user = findUserByEmail(email);
  if (!user) {
    return c.html(renderLogin({ error: "Invalid email or password.", next }), 401);
  }
  const ok = await Bun.password.verify(password, user.password_hash);
  if (!ok) {
    return c.html(renderLogin({ error: "Invalid email or password.", next }), 401);
  }
  const sessionId = createSession(user.id);
  setSessionCookie(c, sessionId);
  return c.redirect(next || "/dashboard");
});

// ── Logout ─────────────────────────────────────────────────

app.post("/logout", (c) => {
  const sessionId = readSessionCookie(c);
  if (sessionId) deleteSession(sessionId);
  clearSessionCookie(c);
  return c.redirect("/");
});

// ── Dashboard ──────────────────────────────────────────────

app.get("/dashboard", (c) => {
  const user = currentUser(c);
  if (!user) return c.redirect("/login?next=/dashboard");
  const customer = findCustomerByEmail(user.email);
  return c.html(
    renderDashboard({
      email: user.email,
      tier: customer?.plan ?? "free",
      status: customer?.status ?? "none",
      seats: 1, // TODO: team plans
      features: customer ? ["pro", "audit", "rag", "swarm"] : [],
      expiresAt: customer?.expires_at ?? null,
      checkoutUrl: null,
      portalUrl: null,
    }),
  );
});

// ── OAuth 2.0 PKCE endpoints for kcode CLI ────────────────

app.get("/oauth/authorize", async (c) => handleAuthorize(c));
app.post("/oauth/authorize/consent", async (c) => handleAuthorizeConsent(c));
app.post("/oauth/token", async (c) => handleToken(c));

// ── /api/subscription (Bearer-auth, called by kcode CLI) ──
//
// This is the single endpoint kcode's src/core/subscription.ts hits
// after login. Returns the user's current tier + features + status.
// 401 → token expired/revoked; 403 → authenticated but no active sub.

app.get("/api/subscription", async (c) => {
  const authed = await authenticateBearer(c);
  if (!authed) return c.json({ error: "invalid_token" }, 401);

  const { findUserById } = await import("./db");
  const user = findUserById(authed.userId);
  if (!user) return c.json({ error: "user_not_found" }, 404);

  const customer = findCustomerByEmail(user.email);
  if (!customer) {
    // No active subscription — free tier.
    return c.json({
      tier: "free",
      features: [],
      seats: 0,
      status: "none",
      expiresAt: 0,
      customer: { email: user.email },
    });
  }

  // Active (or recently-canceled) Stripe-backed customer.
  // Features granted per tier are hardcoded here; a future rev could
  // store them per-customer in the DB for enterprise custom bundles.
  const tier = customer.plan as "pro" | "team" | "enterprise";
  const featuresByTier: Record<string, string[]> = {
    pro: ["pro", "audit", "rag", "swarm"],
    team: ["pro", "audit", "rag", "swarm", "team-sync"],
    enterprise: ["pro", "audit", "rag", "swarm", "team-sync", "enterprise"],
  };
  const expiresAt = customer.expires_at
    ? Math.floor(new Date(customer.expires_at).getTime() / 1000)
    : 0;

  return c.json({
    tier,
    features: featuresByTier[tier] ?? ["pro"],
    seats: 1,
    status: customer.status,
    expiresAt,
    customer: { email: user.email },
  });
});

// ─── Start server ─────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 10080;
const HOST = process.env.HOST ?? "0.0.0.0";

console.log(`KCode Backend starting on ${HOST}:${PORT}`);

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
};
