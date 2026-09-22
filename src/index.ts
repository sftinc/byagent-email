import { app } from "./api";
import { handleScheduled } from "./cleanup";
import type { DeliveryEvent, Env, WebhookJob } from "./env";
import { handleDeliveryEvent } from "./events";
import { handleEmail } from "./inbound";
import { handleQueue } from "./webhooks";

export default {
  fetch: app.fetch,
  email: (message, env) => handleEmail(message, env),
  // Two queues: our own webhook jobs, and the delivery events Cloudflare publishes to us.
  queue: (batch, env) =>
    batch.queue === "agent-inbox-email-events"
      ? handleDeliveryEvent(batch as MessageBatch<DeliveryEvent>, env)
      : handleQueue(batch as MessageBatch<WebhookJob>, env),
  scheduled: (_controller, env) => handleScheduled(env),
} satisfies ExportedHandler<Env, WebhookJob | DeliveryEvent>;
