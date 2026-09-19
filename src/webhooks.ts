import { hmacSha256 } from "./crypto";
import type { Env, WebhookJob } from "./env";
import { loadMessage, summarize } from "./mail";

// Returns true when the job is finished (delivered, or nothing left to deliver).
export async function deliverWebhook(job: WebhookJob, env: Env): Promise<boolean> {
  const hook = await env.DB.prepare(
    "SELECT w.url, i.webhook_secret AS secret FROM webhooks w JOIN inboxes i ON i.address = w.inbox WHERE w.id = ?",
  )
    .bind(job.webhookId)
    .first<{ url: string; secret: string }>();
  const email = hook && (await loadMessage(env, job.inbox, job.messageId, "in"));
  if (!hook || !email) return true;

  const { html, cc, bcc, ...message } = summarize(job.messageId, email);
  const body = JSON.stringify({ inbox: job.inbox, message });
  const timestamp = String(Date.now());
  const signature = await hmacSha256(hook.secret, `${timestamp}.${body}`);

  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp": timestamp,
        "X-Signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export async function handleQueue(batch: MessageBatch<WebhookJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    if (await deliverWebhook(msg.body, env)) msg.ack();
    else msg.retry({ delaySeconds: 30 * 2 ** (msg.attempts - 1) });
  }
}
