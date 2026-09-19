import type { Env } from "./env";
import { purgeMessages } from "./mail";

// Daily: permanently deletes messages older than RETENTION_DAYS, with their stored files.
// Only messages; inboxes and webhooks are left alone. `0` (the default) keeps mail forever.
export async function handleScheduled(env: Env): Promise<void> {
  const days = Number(env.RETENTION_DAYS);
  if (!(days > 0)) return;
  const purged = await purgeMessages(env, "created_at < ?", Date.now() - days * 86_400_000);
  if (purged > 0) console.log(`Retention: purged ${purged} messages older than ${days} days`);
}
