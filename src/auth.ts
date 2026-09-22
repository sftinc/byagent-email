import { sha256 } from "./crypto";
import type { Env, Inbox, Result } from "./env";

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

export function bearer(header: string | undefined): string | undefined {
  const token = header?.replace(/^Bearer /, "");
  return token || undefined;
}

// One header carries either credential; the token says which. The digest is computed once and
// serves both comparisons. ADMIN_KEY is the plaintext secret (scripts/setup.mjs), so it is hashed
// too, and never compared when unset — an empty token must not become the admin.
export async function authenticate(env: Env, token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  const digest = await sha256(token);
  if (env.ADMIN_KEY && digest === (await sha256(env.ADMIN_KEY))) return ADMIN;
  const inbox = await env.DB.prepare("SELECT id, address, name, key_hash, deleted_at FROM inboxes WHERE key_hash = ? AND deleted_at IS NULL")
    .bind(digest)
    .first<Inbox>();
  return inbox ? { kind: "inbox", inbox } : null;
}

// The inbox an operation acts on. An inbox key needs no selector and refuses one naming another
// inbox; the admin key names no inbox, so it must pass one — an address or an id, told apart by
// shape. Admin never falls through to an inbox lookup: a missing selector is an argument error.
export async function resolveInbox(env: Env, principal: Principal, selector: string | undefined, policy: Policy): Promise<Result<Inbox>> {
  if (principal.kind === "inbox") {
    const own = principal.inbox;
    if (selector !== undefined && selector !== own.id && selector.toLowerCase() !== own.address) {
      return { ok: false, status: 403, error: `This key is for ${own.address}` };
    }
    return { ok: true, data: own };
  }
  if (!selector) return { ok: false, status: 400, error: "`inbox` is required with the admin key: an address or an inbox id" };
  const inbox = await findInbox(env, selector.includes("@") ? { address: selector } : { id: selector }, policy);
  return inbox ? { ok: true, data: inbox } : { ok: false, status: 404, error: "Inbox not found" };
}
