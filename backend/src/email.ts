// KCode Backend — Email notifications via Resend (optional)
// Falls back to console logging if RESEND_API_KEY is not set

const RESEND_API = "https://api.resend.com/emails";

export async function sendProKeyEmail(email: string, proKey: string, plan: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "KCode Pro <pro@kulvex.ai>";

  if (!apiKey) {
    console.log(`[email] Would send pro key to ${email} (RESEND_API_KEY not set)`);
    console.log(`[email] Key: ${proKey}`);
    return;
  }

  const planLabel = plan === "team" ? "Team" : "Pro";

  await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: `Your KCode ${planLabel} key`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 2rem;">
          <h2 style="color: #e6edf3;">KCode ${planLabel} activated</h2>
          <p style="color: #8b949e;">Thank you for subscribing! Here is your Pro key:</p>
          <pre style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; color: #58a6ff; font-family: monospace; font-size: 14px; word-break: break-all;">${proKey}</pre>
          <p style="color: #8b949e;">Activate it in your terminal:</p>
          <pre style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; color: #e6edf3; font-family: monospace;">kcode pro activate ${proKey}</pre>
          <p style="color: #8b949e; margin-top: 1.5rem; font-size: 0.85rem;">
            Manage your subscription anytime: <code>kcode pro manage</code><br/>
            Questions? Reply to this email.
          </p>
        </div>
      `,
    }),
  });

  console.log(`[email] Pro key sent to ${email}`);
}

/**
 * Welcome email on signup — includes the email-verification link.
 * The verification token is a single-use hash stored in the
 * email_tokens table; hitting /verify-email?token=X flips
 * users.email_verified = 1.
 */
export async function sendWelcomeEmail(
  email: string,
  verifyUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Astrolexis <no-reply@astrolexis.space>";

  if (!apiKey) {
    console.log(`[email] Would send welcome email to ${email} (RESEND_API_KEY not set)`);
    console.log(`[email] Verify URL: ${verifyUrl}`);
    return;
  }

  await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Welcome to Astrolexis — verify your email",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 2rem; background: #0a0f1c; color: #e2e8f0;">
          <h2 style="color: #00f5ff;">⚡ Welcome to Astrolexis</h2>
          <p>Thanks for signing up. Click the button below to verify your email and unlock everything:</p>
          <p style="text-align:center;margin:2rem 0;">
            <a href="${verifyUrl}" style="background:#00f5ff;color:#000;padding:0.8rem 2rem;border-radius:8px;text-decoration:none;font-weight:600;">Verify email</a>
          </p>
          <p style="color:#94a3b8;font-size:0.85rem;">Or paste this link into your browser:<br/><code style="word-break:break-all;">${verifyUrl}</code></p>
          <p style="color:#94a3b8;font-size:0.85rem;margin-top:2rem;">Link expires in 24 hours. If you didn't create an Astrolexis account, ignore this email.</p>
        </div>
      `,
    }),
  });

  console.log(`[email] Welcome email sent to ${email}`);
}

/** Password reset — triggered by /forgot-password. */
export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Astrolexis <no-reply@astrolexis.space>";

  if (!apiKey) {
    console.log(`[email] Would send reset to ${email} (RESEND_API_KEY not set)`);
    console.log(`[email] Reset URL: ${resetUrl}`);
    return;
  }

  await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Astrolexis — password reset",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 2rem; background: #0a0f1c; color: #e2e8f0;">
          <h2 style="color: #00f5ff;">Reset your Astrolexis password</h2>
          <p>Click the button below to pick a new password:</p>
          <p style="text-align:center;margin:2rem 0;">
            <a href="${resetUrl}" style="background:#00f5ff;color:#000;padding:0.8rem 2rem;border-radius:8px;text-decoration:none;font-weight:600;">Reset password</a>
          </p>
          <p style="color:#94a3b8;font-size:0.85rem;">Link expires in 1 hour. If you didn't request this reset, ignore this email — your password won't change.</p>
        </div>
      `,
    }),
  });

  console.log(`[email] Password reset email sent to ${email}`);
}

export async function sendTrialKeyEmail(email: string, trialKey: string, days: number): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "KCode Pro <pro@kulvex.ai>";

  if (!apiKey) {
    console.log(`[email] Would send trial key to ${email} (RESEND_API_KEY not set)`);
    console.log(`[email] Key: ${trialKey} (${days} days)`);
    return;
  }

  await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: `Your KCode Pro trial (${days} days)`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 2rem;">
          <h2 style="color: #e6edf3;">KCode Pro trial started</h2>
          <p style="color: #8b949e;">You have ${days} days of full Pro access. Here is your trial key:</p>
          <pre style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; color: #d29922; font-family: monospace; font-size: 14px; word-break: break-all;">${trialKey}</pre>
          <p style="color: #8b949e;">Activate it in your terminal:</p>
          <pre style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; color: #e6edf3; font-family: monospace;">kcode pro activate ${trialKey}</pre>
          <p style="color: #8b949e; margin-top: 1.5rem; font-size: 0.85rem;">
            Upgrade anytime: <a href="https://kulvex.ai/pro" style="color: #58a6ff;">kulvex.ai/pro</a>
          </p>
        </div>
      `,
    }),
  });

  console.log(`[email] Trial key sent to ${email}`);
}
