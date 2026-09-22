import type { Env, Inbox, Result } from "./env";
import { type Attachment, loadMessage } from "./mail";

export function findMessage(env: Env, inboxId: string, id: string) {
  // Deleted messages are still readable by id; only changing them 404s.
  return env.DB.prepare(
    "SELECT direction, status, status_reason, attachments, created_at, updated_at, read_at, deleted_at FROM messages WHERE id = ? AND inbox_id = ?",
  )
    .bind(id, inboxId)
    .first<{
      direction: string;
      status: string;
      status_reason: string | null;
      attachments: string;
      created_at: number;
      updated_at: number;
      read_at: number | null;
      deleted_at: number | null;
    }>();
}

const NOT_FOUND: Result<never> = { ok: false, status: 404, error: "Message not found" };

export interface ListParams {
  direction?: string;
  unread?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  deleted?: boolean; // only deleted messages; otherwise only live ones
  before?: string;
  after?: string;
}

// Lists messages 20 at a time, newest first. IDs are UUID v7, so they sort by creation time
// with no ties. `paging.before` / `paging.after` are the ids to pass for older / newer mail.
export async function listMessages(env: Env, inbox: Inbox, params: ListParams) {
  let where = `inbox_id = ? AND deleted_at IS ${params.deleted ? "NOT NULL" : "NULL"}`;
  const bound: unknown[] = [inbox.id];
  const direction = params.direction ?? "in";
  if (!["in", "out", "all"].includes(direction)) {
    return { ok: false, status: 400, error: "`direction` must be in, out or all" } as const;
  }
  if (direction !== "all") {
    where += " AND direction = ?";
    bound.push(direction);
  }
  if (params.unread) where += " AND read_at IS NULL";
  const filters: [string | undefined, string][] = [
    [params.from, "from_addr"],
    [params.to, "recipients"],
    [params.subject, "subject"],
  ];
  for (const [value, column] of filters) {
    if (value) {
      where += ` AND instr(lower(${column}), lower(?)) > 0`;
      bound.push(value);
    }
  }
  const { before, after } = params;
  if (before && after) return { ok: false, status: 400, error: "Use `before` or `after`, not both" } as const;

  // Fetch one extra row to learn whether there's more in the direction we're paging.
  const cursor = after ? " AND id > ? ORDER BY id ASC" : before ? " AND id < ? ORDER BY id DESC" : " ORDER BY id DESC";
  const { results } = await env.DB.prepare(
    `SELECT id, direction, status, status_reason, from_addr, from_name, recipients, subject, attachments, created_at, updated_at, read_at, deleted_at
     FROM messages WHERE ${where}${cursor} LIMIT 21`,
  )
    .bind(...bound, ...(after || before ? [after || before] : []))
    .all<{
      id: string;
      status: string;
      status_reason: string | null;
      from_addr: string;
      from_name: string;
      recipients: string;
      attachments: string;
    }>();
  const more = results.length > 20;
  const page = results.slice(0, 20);
  if (after) page.reverse();

  // The page's edges; an empty page measures from the cursor it was given.
  const newest = page[0]?.id ?? before;
  const oldest = page.at(-1)?.id ?? after;
  const exists = async (op: "<" | ">", id?: string) =>
    id !== undefined &&
    (await env.DB.prepare(`SELECT 1 FROM messages WHERE ${where} AND id ${op} ? LIMIT 1`).bind(...bound, id).first()) !== null;
  const hasOlder = after ? await exists("<", oldest) : more;
  const hasNewer = after ? more : await exists(">", newest);

  return {
    ok: true,
    data: {
      messages: page.map(({ from_addr, from_name, ...m }) => ({
        ...m,
        from: { name: from_name, address: from_addr },
        recipients: m.recipients ? m.recipients.split(",") : [],
        attachments: (JSON.parse(m.attachments) as Attachment[]).map((a, index) => ({ index, ...a })),
      })),
      paging: { before: hasOlder ? oldest : null, after: hasNewer ? newest : null },
    },
  } as const;
}

// Reading a message marks it read, keeping the first time, unless `markRead` is false.
// markUnread undoes it.
export async function readMessage(env: Env, inbox: Inbox, id: string, markRead = true) {
  const row = await findMessage(env, inbox.id, id);
  const stored = row && (await loadMessage(env, inbox.id, id));
  if (!row || !stored) return NOT_FOUND;

  let readAt = row.read_at;
  if (markRead && readAt === null && row.deleted_at === null) {
    readAt = Date.now();
    await env.DB.prepare("UPDATE messages SET read_at = ?, updated_at = ? WHERE id = ?").bind(readAt, readAt, id).run();
  }
  return {
    ok: true,
    data: {
      id,
      ...stored,
      attachments: stored.attachments.map((a, index) => ({ index, ...a })),
      direction: row.direction,
      status: row.status,
      status_reason: row.status_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
      read_at: readAt,
      deleted_at: row.deleted_at,
    },
  } as const;
}

const OK: Result<{ ok: true }> = { ok: true, data: { ok: true } };

export async function markUnread(env: Env, inbox: Inbox, id: string): Promise<Result<{ ok: true }>> {
  const { meta } = await env.DB.prepare(
    "UPDATE messages SET read_at = NULL, updated_at = ? WHERE id = ? AND inbox_id = ? AND deleted_at IS NULL",
  )
    .bind(Date.now(), id, inbox.id)
    .run();
  return meta.changes === 0 ? NOT_FOUND : OK;
}

export async function deleteMessage(env: Env, inbox: Inbox, id: string): Promise<Result<{ ok: true }>> {
  const now = Date.now();
  const { meta } = await env.DB.prepare(
    "UPDATE messages SET deleted_at = ?, updated_at = ? WHERE id = ? AND inbox_id = ? AND deleted_at IS NULL",
  )
    .bind(now, now, id, inbox.id)
    .run();
  return meta.changes === 0 ? NOT_FOUND : OK;
}

export async function restoreMessage(env: Env, inbox: Inbox, id: string): Promise<Result<{ ok: true }>> {
  const { meta } = await env.DB.prepare(
    "UPDATE messages SET deleted_at = NULL, updated_at = ? WHERE id = ? AND inbox_id = ? AND deleted_at IS NOT NULL",
  )
    .bind(Date.now(), id, inbox.id)
    .run();
  return meta.changes === 0 ? NOT_FOUND : OK;
}
