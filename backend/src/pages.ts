// HTML pages for astrolexis.space — minimal, server-rendered. No
// front-end framework, no build step. These are the pages the OAuth
// PKCE flow bounces through: /login, /signup, /dashboard, /consent.

interface LayoutOpts {
  title: string;
  content: string;
  showHeader?: boolean;
}

function layout(opts: LayoutOpts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)} · Astrolexis</title>
<style>
:root { --bg:#0a0f1c; --fg:#e2e8f0; --muted:#94a3b8; --accent:#00f5ff; --border:#334155; --card:#111827; --ok:#10b981; --err:#ef4444; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: system-ui,-apple-system,sans-serif; margin: 0; min-height: 100vh; display: flex; flex-direction: column; }
.header { padding: 1rem 2rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.header a { color: var(--fg); text-decoration: none; font-weight: 600; letter-spacing: -0.02em; }
.header .logo::before { content: "⚡ "; color: var(--accent); }
main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; max-width: 440px; width: 100%; }
.card h1 { margin-top: 0; font-size: 1.5rem; letter-spacing: -0.02em; }
.card .sub { color: var(--muted); margin-top: -0.5rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem; color: #cbd5e1; }
input[type=text], input[type=email], input[type=password] { width: 100%; padding: 0.7rem 0.9rem; background: #0f172a; color: var(--fg); border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; margin-bottom: 1rem; }
input:focus { outline: none; border-color: var(--accent); }
button { background: var(--accent); color: #000; border: none; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.95rem; width: 100%; }
button:hover { filter: brightness(1.1); }
button.secondary { background: transparent; color: var(--muted); border: 1px solid var(--border); margin-top: 0.5rem; }
.alert { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
.alert.err { background: #450a0a; border: 1px solid var(--err); color: #fca5a5; }
.alert.ok { background: #052e16; border: 1px solid var(--ok); color: #86efac; }
.muted { color: var(--muted); font-size: 0.85rem; }
.muted a { color: var(--accent); }
.scope-list { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
.scope-list li { margin: 0.25rem 0; }
.kv { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
.kv:last-child { border-bottom: none; }
.kv span:first-child { color: var(--muted); }
</style>
</head>
<body>
${opts.showHeader === false ? "" : `<header class="header"><a href="/" class="logo">Astrolexis</a><div><a href="/dashboard">Dashboard</a></div></header>`}
<main>${opts.content}</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hiddenInputs(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
}

// ─── Login ──────────────────────────────────────────────────────

export function renderLogin(opts: { error?: string; next?: string }): string {
  const alert = opts.error
    ? `<div class="alert err">${escapeHtml(opts.error)}</div>`
    : "";
  const next = opts.next ? escapeHtml(opts.next) : "";
  return layout({
    title: "Log in",
    content: `<div class="card">
      <h1>Log in</h1>
      <p class="sub">Sign in to your Astrolexis account.</p>
      ${alert}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${next}">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required autocomplete="email">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
        <button type="submit">Log in</button>
      </form>
      <p class="muted" style="margin-top:1.5rem">No account yet? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Sign up</a></p>
    </div>`,
  });
}

// ─── Signup ─────────────────────────────────────────────────────

export function renderSignup(opts: { error?: string; next?: string }): string {
  const alert = opts.error
    ? `<div class="alert err">${escapeHtml(opts.error)}</div>`
    : "";
  const next = opts.next ? escapeHtml(opts.next) : "";
  return layout({
    title: "Sign up",
    content: `<div class="card">
      <h1>Create an account</h1>
      <p class="sub">Start with a free tier. Upgrade anytime.</p>
      ${alert}
      <form method="post" action="/signup">
        <input type="hidden" name="next" value="${next}">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required autocomplete="email">
        <label for="password">Password (min 10 chars)</label>
        <input type="password" id="password" name="password" required minlength="10" autocomplete="new-password">
        <button type="submit">Create account</button>
      </form>
      <p class="muted" style="margin-top:1.5rem">Already have one? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Log in</a></p>
    </div>`,
  });
}

// ─── Consent ────────────────────────────────────────────────────

export function renderConsent(opts: {
  clientLabel: string;
  userEmail: string;
  scope: string;
  action: string;
  hiddenFields: Record<string, string>;
}): string {
  const scopeDescriptions: Record<string, string> = {
    "subscription:read": "Read your subscription tier, features, and seats",
  };
  const scopes = opts.scope.split(/\s+/).filter(Boolean);
  const scopeItems = scopes
    .map((s) => `<li>${escapeHtml(scopeDescriptions[s] ?? s)}</li>`)
    .join("");
  return layout({
    title: `Authorize ${opts.clientLabel}`,
    content: `<div class="card">
      <h1>Authorize ${escapeHtml(opts.clientLabel)}</h1>
      <p class="sub">Signed in as <strong>${escapeHtml(opts.userEmail)}</strong></p>
      <p>${escapeHtml(opts.clientLabel)} is requesting the following permissions:</p>
      <ul class="scope-list">${scopeItems}</ul>
      <form method="post" action="${escapeHtml(opts.action)}">
        ${hiddenInputs(opts.hiddenFields)}
        <button type="submit">Authorize</button>
        <button type="button" class="secondary" onclick="window.location='/dashboard'">Cancel</button>
      </form>
    </div>`,
    showHeader: false,
  });
}

// ─── Dashboard ──────────────────────────────────────────────────

export function renderDashboard(opts: {
  email: string;
  tier: string;
  status: string;
  seats: number;
  features: string[];
  expiresAt: string | null;
  checkoutUrl: string | null;
  portalUrl: string | null;
}): string {
  const featuresHtml = opts.features.length
    ? opts.features.map((f) => `<code>${escapeHtml(f)}</code>`).join(" ")
    : "<span class=\"muted\">none</span>";
  const upgradeHtml = opts.tier === "free"
    ? `<form method="post" action="/checkout" style="margin-top:1.5rem">
         <button type="submit">Upgrade to Pro — $19/mo</button>
       </form>`
    : opts.portalUrl
      ? `<a href="${escapeHtml(opts.portalUrl)}" style="display:inline-block;margin-top:1rem;color:var(--accent)">Manage subscription →</a>`
      : "";
  return layout({
    title: "Dashboard",
    content: `<div class="card" style="max-width:560px">
      <h1>Account</h1>
      <p class="sub">${escapeHtml(opts.email)}</p>
      <div class="kv"><span>Tier</span><span><strong>${escapeHtml(opts.tier)}</strong></span></div>
      <div class="kv"><span>Status</span><span>${escapeHtml(opts.status)}</span></div>
      <div class="kv"><span>Seats</span><span>${opts.seats}</span></div>
      <div class="kv"><span>Features</span><span>${featuresHtml}</span></div>
      ${opts.expiresAt ? `<div class="kv"><span>Expires</span><span>${escapeHtml(opts.expiresAt)}</span></div>` : ""}
      ${upgradeHtml}
      <form method="post" action="/logout" style="margin-top:1rem">
        <button type="submit" class="secondary">Log out</button>
      </form>
    </div>`,
  });
}

// ─── Home ───────────────────────────────────────────────────────

export function renderHome(opts: { loggedIn: boolean }): string {
  const cta = opts.loggedIn
    ? `<a href="/dashboard"><button>Dashboard</button></a>`
    : `<a href="/signup"><button>Get started</button></a>
       <a href="/login" style="display:block;margin-top:0.5rem;color:var(--muted)">I already have an account</a>`;
  return layout({
    title: "Astrolexis",
    content: `<div class="card" style="max-width:540px;text-align:center">
      <h1 style="font-size:2rem">Astrolexis</h1>
      <p class="sub">AI coding assistant. Local-first. Cloud-optional.</p>
      <p>KCode runs on your machine and connects to local LLMs or cloud APIs — your choice. Pro subscribers get advanced audit engine, swarm agents, RAG, and cloud sync.</p>
      <div style="margin-top:2rem">${cta}</div>
    </div>`,
  });
}
