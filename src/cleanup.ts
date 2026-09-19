import type { Env } from "./env";
import { purgeMessages } from "./mail";

export async function handleScheduled(env: Env): Promise<void> {
  const days = Number(env.RETENTION_DAYS);
  if (!(days > 0)) return;
  await purgeMessages(env, "received_at < ?", Date.now() - days * 86_400_000);
}
