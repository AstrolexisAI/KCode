// Secret redactor — masks credentials in tool output before the text
// reaches the user or the assistant's context. Applied at the unified
// tool-result boundary (src/core/tool-executor.ts).
//
// Why a dedicated module: the existing logger.sanitize() in
// src/core/logger.ts is tuned for structured log lines and does not
// catch the flat config-file shapes that `cat ~/.bitcoin/bitcoin.conf`
// or `grep rpcpassword …` emit. This module is more aggressive, and
// intentionally narrow-scoped to tool output (not system prompts, not
// message history that's already committed).
//
// Non-goals:
//   * Redacting pastes from the user or text the model wrote itself
//     (we don't want to hide example patterns or explanations).
//   * Inspecting inside fenced code blocks: tool output never contains
//     triple-backticks as meaningful boundaries, so this scans flat.
//
// Design:
//   Each rule is a regex + replacement. The replacement preserves the
//   KEY so the user still sees which credential got redacted (useful
//   for debugging: "redacted API key for anthropic" vs opaque).

const MASK = "***REDACTED***";

interface RedactionRule {
  /** Human-readable label (for telemetry/tests). */
  name: string;
  /** Regex to match. MUST use capture groups: keep group 1, redact group 2. */
  pattern: RegExp;
}

const RULES: RedactionRule[] = [
  // ── RPC / daemon config (bitcoin.conf, geth, ssh-agent prompts) ──
  {
    name: "rpcpassword",
    pattern: /\b(rpcpassword\s*[:=]\s*)([^\s"'#\n]+)/gi,
  },
  {
    name: "rpcuser",
    pattern: /\b(rpcuser\s*[:=]\s*)([^\s"'#\n]+)/gi,
  },

  // ── Generic password= / secret= / token= shapes ──
  // Only triggers when there's an actual non-empty value after.
  {
    name: "password_assign",
    pattern: /\b(password\s*[:=]\s*)([^\s"'#\n]{3,})/gi,
  },
  // Prose form "password tronco" — whitespace-separated credential
  // appearing after "password". Excludes common English/Spanish
  // follower words that indicate a generic-noun usage (policy,
  // field, strength, manager, reset, …) rather than a specific
  // credential reference. Issues #107, #111.
  {
    name: "password_prose",
    pattern:
      /\b(password\s+)(?!(?:policy|policies|field|fields|manager|managers|reset|resets|required|strength|hash|hashes|hashing|protection|expiry|validator|validators|rules|length|setup|input|confirm|confirmation|recovery|prompt|placeholder|example|examples|box|boxes|form|forms|required|generation|generator|generators|security)\b)([a-zA-Z0-9_.!#$%^&*+=-]{4,})/gi,
  },
  {
    name: "passwd_assign",
    pattern: /\b(passwd\s*[:=]\s*)([^\s"'#\n]{3,})/gi,
  },
  // Prose form "contraseña tronco" (Spanish) — denylist Spanish nouns.
  {
    name: "contrasena_prose",
    pattern:
      /\b(contrase[nñ]a\s+)(?!(?:fuerte|débil|debil|segura|temporal|nueva|válida|valida|incorrecta|válida|por\b|para\b|actual|anterior|predeterminada|requerida|ingresada|correcta|larga|corta|encriptada|nunca)\b)([a-zA-Z0-9_.!#$%^&*+=-]{4,})/gi,
  },
  {
    name: "secret_assign",
    pattern: /\b(secret(?:_key)?\s*[:=]\s*)([^\s"'#\n]{8,})/gi,
  },
  {
    name: "token_assign",
    pattern: /\b((?:access_|refresh_|auth_|api_|bearer_)?token\s*[:=]\s*)([^\s"'#\n]{16,})/gi,
  },
  {
    name: "api_key_assign",
    pattern: /\b((?:api[_-]?key|apikey)\s*[:=]\s*)([^\s"'#\n]{12,})/gi,
  },
  {
    name: "private_key_assign",
    pattern: /\b(private[_-]?key\s*[:=]\s*)([^\s"'#\n]{16,})/gi,
  },

  // ── Known provider API key prefixes (match even without key= shape) ──
  // Group 1 empty, group 2 is the full key → replaced whole.
  {
    name: "anthropic_key",
    pattern: /()(sk-ant-api03-[A-Za-z0-9_-]{40,})/g,
  },
  {
    name: "openai_key",
    pattern: /()(sk-proj-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{40,})/g,
  },
  {
    name: "groq_key",
    pattern: /()(gsk_[A-Za-z0-9]{40,})/g,
  },
  {
    name: "xai_key",
    pattern: /()(xai-[A-Za-z0-9]{40,})/g,
  },
  {
    name: "resend_key",
    pattern: /()(re_[A-Za-z0-9_]{20,})/g,
  },
  {
    name: "github_pat",
    pattern: /()(ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g,
  },
  {
    name: "stripe_secret",
    pattern: /()(sk_(?:live|test)_[A-Za-z0-9]{24,})/g,
  },
  {
    name: "stripe_webhook",
    pattern: /()(whsec_[A-Za-z0-9]{24,})/g,
  },

  // ── PEM-encoded private keys ──
  {
    name: "pem_private_key",
    pattern:
      /()(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)/g,
  },

  // ── URLs with embedded credentials: proto://user:pass@host ──
  {
    name: "url_basic_auth",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@[^\s"']+)/gi,
  },

  // ── JWT tokens (3 base64url segments) ──
  {
    name: "jwt",
    pattern: /()(\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/g,
  },
];

/**
 * Apply all redaction rules. Returns the redacted text plus a list of
 * rule names that fired (for telemetry / optional user-visible summary
 * like "3 secrets redacted: rpcpassword, anthropic_key, jwt").
 */
export function redact(text: string): { redacted: string; rulesFired: string[] } {
  if (!text) return { redacted: text, rulesFired: [] };

  const fired = new Set<string>();
  let out = text;

  for (const rule of RULES) {
    const matched = rule.pattern.test(out);
    if (!matched) continue;
    fired.add(rule.name);

    // Special case: url_basic_auth has 3 groups (proto://user:, pass, @host)
    if (rule.name === "url_basic_auth") {
      out = out.replace(rule.pattern, `$1${MASK}$3`);
      continue;
    }
    // Default: group 1 + MASK (replaces group 2 which is the secret value)
    out = out.replace(rule.pattern, `$1${MASK}`);
  }

  return { redacted: out, rulesFired: Array.from(fired) };
}

/**
 * Convenience wrapper for tool output: redacts silently, returns only
 * the redacted string. For tool-result integration where we don't need
 * the telemetry.
 */
export function redactSilently(text: string): string {
  return redact(text).redacted;
}
