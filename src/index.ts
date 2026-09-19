import { app } from "./api";
import type { Env, WebhookJob } from "./env";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env, WebhookJob>;
