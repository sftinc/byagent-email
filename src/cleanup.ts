import type { Env } from "./env";

export async function handleScheduled(env: Env): Promise<void> {
  const days = Number(env.RETENTION_DAYS);
  if (!(days > 0)) return;
  // Soft delete, like every other delete: rows and stored mail are kept.
  await env.DB.prepare("UPDATE messages SET deleted_at = ? WHERE created_at < ? AND deleted_at IS NULL")
    .bind(Date.now(), Date.now() - days * 86_400_000)
    .run();
}
