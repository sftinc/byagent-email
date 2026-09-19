import { app } from "./api";
import type { Env, WebhookJob } from "./env";
import { handleEmail } from "./inbound";
import { handleQueue } from "./webhooks";

export default {
  fetch: app.fetch,
  email: (message, env) => handleEmail(message, env),
  queue: (batch, env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env, WebhookJob>;
