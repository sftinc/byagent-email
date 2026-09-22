import type { DeliveryEvent, Env } from "./env";

// The status each event maps to. Anything unrecognised is ignored rather than guessed at.
const STATUS: Record<string, string> = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.complained": "complained",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.failed": "failed",
};

// A send writes R2 and every attachment before its D1 insert, so an event can beat its own row
// into existence. Retry briefly rather than dropping a real bounce; past this, a missing row means
// mail sent before this shipped, or from another system.
const GRACE_MS = 5 * 60_000;

// Queue order is not guaranteed, so a delayed `deferred` must not undo a `delivered`.
const TERMINAL = new Set(["delivered", "bounced", "complained", "rejected", "failed"]);

// The enhanced SMTP code (5.1.1) says why in a form worth storing; `bounce.reason` is hundreds of
// characters of the remote server's folded prose. A soft bounce is retry exhaustion rather than a
// dead address, and the prefix keeps that distinction without a second column.
function reasonFor(event: DeliveryEvent, status: string): string | null {
  const code = event.payload.delivery.smtpEnhancedStatusCode ?? null;
  if (status === "bounced") return event.payload.bounce?.type === "soft" ? `soft:${code}` : code;
  if (status === "rejected") return event.payload.delivery.status;
  if (status === "deferred" || status === "failed") return code;
  return null;
}

// Cloudflare publishes one event per recipient as a message's delivery progresses. Each one is
// matched to its message by Message-ID and overwrites the row's status; see the spec for why a
// message with several recipients keeps only the last outcome processed.
export async function handleDeliveryEvent(batch: MessageBatch<DeliveryEvent>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const status = STATUS[msg.body.type];
    if (status) {
      // No `deleted_at IS NULL` here, deliberately: an event is a fact about what happened to the
      // message whether or not someone has since hidden it, and recording it keeps a restored
      // message truthful. Nothing reaches the user about a deleted message — `deliverWebhook`
      // already filters on `deleted_at IS NULL` (src/webhooks.ts:13).
      const row = await env.DB.prepare("SELECT id, inbox_id, status FROM messages WHERE message_id = ? AND direction = 'out'")
        .bind(msg.body.payload.messageId)
        .first<{ id: string; inbox_id: string; status: string }>();

      if (!row) {
        if (Date.now() - msg.timestamp.getTime() < GRACE_MS) {
          msg.retry();
          continue;
        }
        msg.ack();
        continue;
      }

      if (!(TERMINAL.has(row.status) && !TERMINAL.has(status))) {
        await env.DB.prepare(
          "UPDATE messages SET status = ?, status_reason = ?, updated_at = ? WHERE message_id = ? AND direction = 'out'",
        )
          .bind(status, reasonFor(msg.body, status), Date.now(), msg.body.payload.messageId)
          .run();

        // Delivered needs no interruption; everything else terminal is worth waking the agent for,
        // because by the time this fires nobody is still holding the `POST /send` response.
        if (TERMINAL.has(status) && status !== "delivered") {
          const { results } = await env.DB.prepare("SELECT id FROM webhooks WHERE inbox_id = ? AND deleted_at IS NULL")
            .bind(row.inbox_id)
            .all<{ id: string }>();
          if (results.length > 0) {
            try {
              await env.WEBHOOKS.sendBatch(results.map((w) => ({ body: { webhookId: w.id, messageId: row.id, status } })));
            } catch (err) {
              console.error(err);
            }
          }
        }
      }
    }
    msg.ack();
  }
}
