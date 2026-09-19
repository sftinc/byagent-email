import { app } from "./api";
import type { Env, WebhookJob } from "./env";
import { handleEmail } from "./inbound";

export default {
  fetch: app.fetch,
  email: (message, env) => handleEmail(message, env),
} satisfies ExportedHandler<Env, WebhookJob>;
