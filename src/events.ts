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
      await env.DB.prepare(
        "UPDATE messages SET status = ?, status_reason = ?, updated_at = ? WHERE message_id = ? AND direction = 'out'",
      )
        .bind(status, reasonFor(msg.body, status), Date.now(), msg.body.payload.messageId)
        .run();
    }
    msg.ack();
  }
}
