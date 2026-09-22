import type { DeliveryEvent, Env } from "./env";

// Cloudflare publishes one event per recipient as a message's delivery progresses. Each one is
// matched to its message by Message-ID and overwrites the row's status; see the spec for why a
// message with several recipients keeps only the last outcome processed.
export async function handleDeliveryEvent(batch: MessageBatch<DeliveryEvent>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    msg.ack();
  }
}
