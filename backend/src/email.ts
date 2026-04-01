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
