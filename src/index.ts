import { app } from "./api";
import { handleScheduled } from "./cleanup";
import type { Env, WebhookJob } from "./env";
import { handleEmail } from "./inbound";
import { handleQueue } from "./webhooks";

export default {
  fetch: app.fetch,
  email: (message, env) => handleEmail(message, env),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (_controller, env) => handleScheduled(env),
} satisfies ExportedHandler<Env, WebhookJob>;
