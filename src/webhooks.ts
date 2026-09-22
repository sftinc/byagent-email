import { hmacSha256, randomToken, uuidv7 } from "./crypto";
import type { Env, Inbox, Result, WebhookJob } from "./env";
import { loadMessage } from "./mail";
import { BAD_BEARER, BAD_NAME, parseBearer, parseName } from "./validate";

// How many webhooks the inbox has, against the cap of 10.
async function webhookCount(env: Env, inboxId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE inbox_id = ? AND deleted_at IS NULL")
    .bind(inboxId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const TOO_MANY: Result<never> = { ok: false, status: 400, error: "At most 10 webhooks per inbox" };
const NOT_FOUND: Result<never> = { ok: false, status: 404, error: "Webhook not found" };
const OK: Result<{ ok: true }> = { ok: true, data: { ok: true } };

export async function listWebhooks(env: Env, inbox: Inbox, deleted: boolean) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, url, succeeded_at, failed_at${deleted ? ", deleted_at" : ""} FROM webhooks WHERE inbox_id = ? AND deleted_at IS ${deleted ? "NOT NULL" : "NULL"}`,
  )
    .bind(inbox.id)
    .all();
  return { ok: true, data: { webhooks: results } } as const;
}

export async function createWebhook(
  env: Env,
  inbox: Inbox,
  body: { url?: unknown; name?: unknown; bearer?: unknown },
): Promise<Result<{ id: string; name: string | null; url: string; secret: string }>> {
  const url = typeof body.url === "string" && URL.canParse(body.url) ? new URL(body.url) : null;
  if (url?.protocol !== "https:") return { ok: false, status: 400, error: "`url` must be an https:// URL" };
  const name = parseName(body.name);
  if (name === undefined) return { ok: false, status: 400, error: BAD_NAME };
  const bearer = parseBearer(body.bearer);
  if (bearer === undefined) return { ok: false, status: 400, error: BAD_BEARER };
  if ((await webhookCount(env, inbox.id)) >= 10) return TOO_MANY;
  const id = uuidv7();
  const secret = randomToken();
  await env.DB.prepare(
    "INSERT INTO webhooks (id, inbox_id, name, url, secret, bearer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, inbox.id, name, url.href, secret, bearer, Date.now())
    .run();
  return { ok: true, data: { id, name, url: url.href, secret } };
}

export async function deleteWebhook(env: Env, inbox: Inbox, id: string): Promise<Result<{ ok: true }>> {
  const { meta } = await env.DB.prepare(
    "UPDATE webhooks SET deleted_at = ? WHERE id = ? AND inbox_id = ? AND deleted_at IS NULL",
  )
    .bind(Date.now(), id, inbox.id)
    .run();
  return meta.changes === 0 ? NOT_FOUND : OK;
}

export async function restoreWebhook(env: Env, inbox: Inbox, id: string): Promise<Result<{ ok: true }>> {
  const found = await env.DB.prepare("SELECT 1 FROM webhooks WHERE id = ? AND inbox_id = ? AND deleted_at IS NOT NULL")
    .bind(id, inbox.id)
    .first();
  if (!found) return NOT_FOUND;
  if ((await webhookCount(env, inbox.id)) >= 10) return TOO_MANY;
  await env.DB.prepare("UPDATE webhooks SET deleted_at = NULL WHERE id = ?").bind(id).run();
  return OK;
}

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
  // status and status_reason must come from the same source: a second terminal event can land
  // between enqueue and delivery, so re-reading one from the row and the other from the job could
  // pair a bounce's status with a later (or earlier) reason. job.status decides which pair applies;
  // `job.statusReason ?? null` keeps a legitimate null (e.g. `complained`) from falling through to
  // the row's.
  const status = job.status ?? hook.status;
  const status_reason = job.status ? (job.statusReason ?? null) : hook.status_reason;
  const message = {
    id: job.messageId,
    direction: hook.direction,
    status,
    status_reason,
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
