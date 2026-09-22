import { hmacSha256 } from "./crypto";
import type { Env, WebhookJob } from "./env";
import { loadMessage } from "./mail";

// Returns true when the job is finished (delivered, or nothing left to deliver).
// Logs every attempt, so a delivery that fails unattended leaves a trace. Needs `observability`
// on in the Worker config to be readable later; without it these only show in `wrangler tail`.
export async function deliverWebhook(job: WebhookJob, env: Env, attempt: number): Promise<boolean> {
  // Skips the job when the webhook or the message has been deleted since it was queued.
  const hook = await env.DB.prepare(
    `SELECT w.url, w.secret, w.bearer, w.inbox_id, i.address, m.direction, m.status, m.status_reason FROM webhooks w
     JOIN inboxes i ON i.id = w.inbox_id
     JOIN messages m ON m.id = ? AND m.inbox_id = w.inbox_id AND m.deleted_at IS NULL
     WHERE w.id = ? AND w.deleted_at IS NULL`,
  )
    .bind(job.messageId, job.webhookId)
    .first<{
      url: string;
      secret: string;
      bearer: string | null;
      inbox_id: string;
      address: string;
      direction: string;
      status: string;
      status_reason: string | null;
    }>();
  const stored = hook && (await loadMessage(env, hook.inbox_id, job.messageId));
  if (!hook || !stored) {
    console.log({ event: "webhook_skipped", webhookId: job.webhookId, messageId: job.messageId, attempt });
    return true;
  }

  const { html, cc, bcc, headers, attachments, ...rest } = stored;
  const message = {
    id: job.messageId,
    direction: hook.direction,
    status: job.status ?? hook.status,
    status_reason: hook.status_reason,
    ...rest,
    attachments: attachments.map((a, index) => ({ index, ...a })),
  };
  const body = JSON.stringify({ event: job.status ? "status" : "mail", inbox: hook.address, message });
  const timestamp = String(Date.now());
  const signature = await hmacSha256(hook.secret, `${timestamp}.${body}`);

  // Exactly one of status and error is set: a null status means the request got no response at all.
  const log = (status: number | null, error: string | null) =>
    console.log({
      event: "webhook_delivery",
      webhookId: job.webhookId,
      messageId: job.messageId,
      url: hook.url,
      attempt,
      status,
      error,
    });

  // The signature proves the delivery came from us. A bearer, when the receiver issued one, is
  // how that receiver authenticates us instead; it is sent verbatim and never logged.
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Timestamp": timestamp,
    "X-Signature": `sha256=${signature}`,
  };
  if (hook.bearer) requestHeaders.Authorization = `Bearer ${hook.bearer}`;

  // Bookkeeping, so a webhook's health outlives the logs. It must never change the outcome:
  // a failed write here would otherwise turn a delivered webhook into a retry.
  const stamp = async (column: "succeeded_at" | "failed_at") => {
    try {
      await env.DB.prepare(`UPDATE webhooks SET ${column} = ? WHERE id = ?`).bind(Date.now(), job.webhookId).run();
    } catch (err) {
      console.log({ event: "webhook_stamp_failed", webhookId: job.webhookId, error: String(err).slice(0, 200) });
    }
  };

  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: requestHeaders,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    log(res.status, null);
    await stamp(res.ok ? "succeeded_at" : "failed_at");
    return res.ok;
  } catch (err) {
    log(null, String(err).slice(0, 200));
    await stamp("failed_at");
    return false;
  }
}

export async function handleQueue(batch: MessageBatch<WebhookJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    if (await deliverWebhook(msg.body, env, msg.attempts)) msg.ack();
    else msg.retry({ delaySeconds: 30 * 2 ** (msg.attempts - 1) });
  }
}
