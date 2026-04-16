// KCode — License Generator Web UI
//
// Launches a local Bun.serve on 127.0.0.1 with an HTML form for
// creating RS256-signed license JWTs. Invoked via
// `kcode license serve [--port N]`.
//
// Security model: localhost-only by default. Path `/` serves the
// form HTML inline (no build step). POST /api/generate takes form
// data, calls license-signer, returns the JWT. POST /api/init-keypair
// generates a keypair if none exists.

import { log } from "../core/logger";
import {
  generateKeypair,
  signLicenseWithSummary,
  type LicenseInput,
} from "../core/license-signer";

// ─── HTML (embedded — no build step) ───────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>KCode License Generator</title>
<style>
:root { --bg:#0a0f1c; --fg:#e2e8f0; --accent:#00f5ff; --border:#334155; --ok:#10b981; --warn:#f59e0b; --err:#ef4444; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: system-ui,-apple-system,sans-serif; margin: 0; padding: 2rem; max-width: 720px; margin-inline: auto; }
h1 { font-size: 1.5rem; margin-bottom: 0.25rem; letter-spacing: -0.02em; }
.sub { color: #94a3b8; font-size: 0.9rem; margin-bottom: 2rem; }
.card { background: #111827; border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; }
label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem; color: #cbd5e1; }
input[type=text], input[type=email], input[type=number], input[type=date], textarea, select {
  width: 100%; padding: 0.6rem 0.8rem; background: #0f172a; color: var(--fg); border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; font-family: inherit;
}
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
.row.one { grid-template-columns: 1fr; }
.features { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
.features label { display: inline-flex; align-items: center; gap: 0.4rem; background: #1e293b; padding: 0.4rem 0.75rem; border-radius: 20px; cursor: pointer; font-size: 0.85rem; font-weight: 500; border: 1px solid transparent; }
.features input[type=checkbox] { accent-color: var(--accent); cursor: pointer; }
.features label.checked { border-color: var(--accent); background: #0c4a6e; }
button { background: var(--accent); color: #000; border: none; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
button:hover { filter: brightness(1.1); }
button.secondary { background: #334155; color: var(--fg); }
.output { background: #020617; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; font-family: monospace; font-size: 0.8rem; overflow-wrap: break-word; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
.actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.hint { color: #64748b; font-size: 0.8rem; margin-top: 0.3rem; }
.alert { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
.alert.err { background: #450a0a; border: 1px solid var(--err); color: #fca5a5; }
.alert.ok { background: #052e16; border: 1px solid var(--ok); color: #86efac; }
.claims { font-size: 0.8rem; color: #94a3b8; margin-top: 0.5rem; }
.claims span { display: inline-block; margin-right: 0.75rem; }
.claims b { color: var(--fg); }
</style>
</head>
<body>
<h1>⚡ KCode License Generator</h1>
<div class="sub">Creates RS256-signed JWT licenses. Private key stays on this machine.</div>

<div id="alert"></div>

<form id="form" class="card">
  <div class="row">
    <div>
      <label for="sub">Email (subject)</label>
      <input type="email" id="sub" required placeholder="user@example.com">
    </div>
    <div>
      <label for="orgName">Organization (optional)</label>
      <input type="text" id="orgName" placeholder="Acme Inc.">
    </div>
  </div>

  <div class="row">
    <div>
      <label for="tier">Tier</label>
      <select id="tier">
        <option value="pro">Pro</option>
        <option value="team">Team</option>
        <option value="enterprise">Enterprise</option>
      </select>
    </div>
    <div>
      <label for="seats">Seats</label>
      <input type="number" id="seats" value="1" min="1" max="10000">
    </div>
  </div>

  <div class="row one">
    <div>
      <label>Features granted</label>
      <div class="features" id="features">
        <label><input type="checkbox" value="pro" checked> Pro</label>
        <label><input type="checkbox" value="enterprise"> Enterprise</label>
        <label><input type="checkbox" value="swarm"> Swarm</label>
        <label><input type="checkbox" value="audit"> Audit Engine</label>
        <label><input type="checkbox" value="rag"> RAG</label>
        <label><input type="checkbox" value="cloud-sync"> Cloud Sync</label>
        <label><input type="checkbox" value="analytics"> Analytics</label>
      </div>
    </div>
  </div>

  <div class="row">
    <div>
      <label for="expiresAt">Expires on</label>
      <input type="date" id="expiresAt" required>
      <div class="hint">Must be a future date.</div>
    </div>
    <div>
      <label for="hardware">Hardware fingerprint (optional)</label>
      <input type="text" id="hardware" placeholder="leave blank = portable">
      <div class="hint">Binds license to a specific machine.</div>
    </div>
  </div>

  <div class="row one">
    <label><input type="checkbox" id="offline"> Allow offline activation (air-gapped / on-prem)</label>
  </div>

  <button type="submit">Generate License</button>
  <button type="button" class="secondary" id="keypairBtn">Init keypair (first-time setup)</button>
</form>

<div class="card" id="result" style="display:none">
  <label>JWT (paste into <code>~/.kcode/license.jwt</code> on target machine)</label>
  <div class="output" id="jwt"></div>
  <div class="actions">
    <button id="copyBtn" type="button">Copy JWT</button>
    <button id="downloadBtn" type="button" class="secondary">Download .jwt</button>
  </div>
  <div class="claims" id="claimsPreview"></div>
</div>

<script>
const form = document.getElementById("form");
const alertEl = document.getElementById("alert");
const featureBoxes = document.querySelectorAll("#features input[type=checkbox]");

// Default expiry = 1 year
const oneYear = new Date(); oneYear.setFullYear(oneYear.getFullYear() + 1);
document.getElementById("expiresAt").valueAsDate = oneYear;

// Toggle visual state on feature checkboxes
featureBoxes.forEach(cb => {
  const updateLabel = () => cb.parentElement.classList.toggle("checked", cb.checked);
  updateLabel();
  cb.addEventListener("change", updateLabel);
});

function showAlert(kind, msg) {
  alertEl.innerHTML = \`<div class="alert \${kind}">\${msg}</div>\`;
  if (kind === "ok") setTimeout(() => { alertEl.innerHTML = ""; }, 4000);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const features = [...featureBoxes].filter(c => c.checked).map(c => c.value);
  if (features.length === 0) { showAlert("err", "Select at least one feature."); return; }

  const body = {
    sub: document.getElementById("sub").value.trim(),
    orgName: document.getElementById("orgName").value.trim() || undefined,
    tier: document.getElementById("tier").value,
    seats: parseInt(document.getElementById("seats").value, 10),
    features,
    expiresAt: document.getElementById("expiresAt").value,
    hardware: document.getElementById("hardware").value.trim() || null,
    offline: document.getElementById("offline").checked,
  };

  try {
    const res = await fetch("/api/generate", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showAlert("err", data.error || "Generation failed"); return; }

    document.getElementById("result").style.display = "block";
    document.getElementById("jwt").textContent = data.jwt;
    const c = data.claims;
    document.getElementById("claimsPreview").innerHTML =
      \`<span><b>sub:</b> \${c.sub}</span><span><b>tier:</b> \${c.tier}</span><span><b>seats:</b> \${c.seats}</span><span><b>expires in:</b> \${data.expiresInDays} days</span>\${c.hardware ? \`<span><b>hw-bound:</b> \${c.hardware.slice(0,12)}…</span>\` : ""}\`;
    showAlert("ok", "License generated. Copy or download below.");
    window.__lastJwt = data.jwt;
    window.__lastSub = c.sub;
  } catch (err) {
    showAlert("err", "Network error: " + err.message);
  }
});

document.getElementById("keypairBtn").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/init-keypair", { method: "POST" });
    const data = await res.json();
    if (!res.ok) { showAlert("err", data.error); return; }
    if (data.preserved) {
      showAlert("ok", "Existing keypair found at " + data.privateKeyPath + " — preserved.");
    } else {
      showAlert("ok", "New keypair generated. Public key written to " + data.publicKeyPath + ". Paste it into src/core/license.ts KULVEX_LICENSE_PUBLIC_KEY for verification.");
    }
  } catch (err) {
    showAlert("err", "Network error: " + err.message);
  }
});

document.getElementById("copyBtn").addEventListener("click", () => {
  if (!window.__lastJwt) return;
  navigator.clipboard.writeText(window.__lastJwt);
  showAlert("ok", "Copied to clipboard.");
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  if (!window.__lastJwt) return;
  const blob = new Blob([window.__lastJwt], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = \`kcode-license-\${(window.__lastSub || "user").replace(/[^a-z0-9]/gi,"_")}.jwt\`;
  a.click();
  URL.revokeObjectURL(url);
});
</script>
</body>
</html>`;

// ─── Server ─────────────────────────────────────────────────────

export interface ServeOptions {
  port: number;
  host: string;
}

export async function startLicenseServer(opts: ServeOptions): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/" && req.method === "GET") {
        return new Response(HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/generate" && req.method === "POST") {
        try {
          const body = (await req.json()) as LicenseInput;
          const result = signLicenseWithSummary(body);
          return Response.json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: msg }, { status: 400 });
        }
      }

      if (url.pathname === "/api/init-keypair" && req.method === "POST") {
        try {
          const result = generateKeypair();
          return Response.json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const url = `http://${opts.host}:${opts.port}`;
  log.info("license-ui", `license generator at ${url}`);
  return {
    url,
    stop: () => server.stop(true),
  };
}
