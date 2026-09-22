import type { Env, Inbox } from "./env";

export type Principal = { kind: "admin" } | { kind: "inbox"; inbox: Inbox };
export const ADMIN: Principal = { kind: "admin" };

// Which inboxes an operation may act on. The routes disagree about deleted_at on purpose: restoring
// a live inbox is meaningless, rotating a deleted one's key is refused, and purge reads the state
// to decide what it removes.
export type Policy = "live" | "deleted" | "any";

const STATE = { live: "AND deleted_at IS NULL", deleted: "AND deleted_at IS NOT NULL", any: "" };

export function findInbox(env: Env, by: { id: string } | { address: string }, policy: Policy): Promise<Inbox | null> {
  const [column, value] = "id" in by ? ["id", by.id] : ["address", by.address.toLowerCase()];
  return env.DB.prepare(`SELECT id, address, name, key_hash, deleted_at FROM inboxes WHERE ${column} = ? ${STATE[policy]}`)
    .bind(value)
    .first<Inbox>();
}
