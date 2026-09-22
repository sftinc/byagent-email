import { randomToken, sha256, uuidv7 } from "./crypto";
import type { Env, Inbox, Result } from "./env";
import { purgeInboxFiles, purgeMessages } from "./mail";
import { BAD_NAME, parseName } from "./validate";

// True when the domain's MX records point at Cloudflare Email Routing. It doesn't prove the
// catch-all rule targets this Worker, but it catches typos and domains that aren't set up.
async function hasCloudflareMx(domain: string): Promise<boolean> {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
    headers: { Accept: "application/dns-json" },
  });
  if (!res.ok) throw new Error(`DNS lookup for ${domain} failed: ${res.status}`);
  const { Answer = [] } = await res.json<{ Answer?: { data: string }[] }>();
  return Answer.some((a) => a.data.toLowerCase().endsWith(".mx.cloudflare.net."));
}

export async function createInbox(
  env: Env,
  body: { address?: unknown; name?: unknown },
): Promise<Result<{ id: string; address: string; name: string | null; api_key: string }>> {
  const address = typeof body.address === "string" ? body.address.toLowerCase() : "";
  const name = parseName(body.name);
  if (name === undefined) return { ok: false, status: 400, error: BAD_NAME };
  // Any domain works, as long as it is set up for this Worker in Cloudflare (see README).
  if (!/^[a-z0-9._-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/.test(address)) {
    return { ok: false, status: 400, error: "`address` must look like name@example.com (name: 1-64 of a-z 0-9 . _ -)" };
  }
  const exists = await env.DB.prepare("SELECT deleted_at FROM inboxes WHERE address = ?")
    .bind(address)
    .first<{ deleted_at: number | null }>();
  if (exists) {
    const error = exists.deleted_at ? "Inbox already exists, deleted: restore it instead" : "Inbox already exists";
    return { ok: false, status: 409, error };
  }
  const domain = address.split("@")[1];
  if (!(await hasCloudflareMx(domain))) {
    return { ok: false, status: 400, error: `${domain} has no Cloudflare Email Routing MX records` };
  }

  const id = uuidv7();
  const apiKey = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO inboxes (id, address, name, key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, address, name, await sha256(apiKey), now, now)
    .run();
  return { ok: true, data: { id, address, name, api_key: apiKey } };
}

export async function listInboxes(env: Env, deleted: boolean) {
  const { results } = await env.DB.prepare(
    `SELECT id, address, name, created_at${deleted ? ", deleted_at" : ""} FROM inboxes
     WHERE deleted_at IS ${deleted ? "NOT NULL" : "NULL"} ORDER BY address`,
  ).all();
  return { ok: true, data: { inboxes: results } } as const;
}

// Mail for addresses no inbox holds. Unpaged like the other admin lists, but capped: the row
// count here is set by whoever is mailing the domain, not by us.
export async function listRejected(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, from_addr, recipients, subject, status_reason, created_at FROM messages
     WHERE inbox_id IS NULL ORDER BY id DESC LIMIT 100`,
  ).all();
  return { ok: true, data: { rejected: results } } as const;
}

const HINT = "Queues > agent-inbox-email-events > Subscriptions > Subscribe to events (source \"Email Sending\", this domain)";

// Nothing credential-free can read subscription state, so the symptom stands in for the cause:
// without a subscription, sent mail never advances past 'sent'.
export async function listDomains(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT substr(i.address, instr(i.address, '@') + 1) AS domain,
            COUNT(DISTINCT i.id) AS inboxes,
            COUNT(m.id) AS sent,
            COUNT(CASE WHEN m.status != 'sent' THEN 1 END) AS advanced,
            MIN(m.created_at) AS oldest
     FROM inboxes i
     LEFT JOIN messages m ON m.inbox_id = i.id AND m.direction = 'out' AND m.deleted_at IS NULL AND m.message_id IS NOT NULL
     WHERE i.deleted_at IS NULL
     GROUP BY domain ORDER BY domain`,
  ).all<{ domain: string; inboxes: number; sent: number; advanced: number; oldest: number | null }>();

  const stale = Date.now() - 3600_000;
  return {
    ok: true,
    data: {
      domains: results.map(({ oldest, ...d }) => ({
        ...d,
        hint: d.sent > 0 && d.advanced === 0 && oldest !== null && oldest < stale ? HINT : null,
      })),
    },
  } as const;
}

export async function renameInbox(env: Env, inbox: Inbox, name: unknown): Promise<Result<{ id: string; address: string; name: string | null }>> {
  const parsed = parseName(name);
  if (parsed === undefined) return { ok: false, status: 400, error: BAD_NAME };
  const { meta } = await env.DB.prepare("UPDATE inboxes SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(parsed, Date.now(), inbox.id)
    .run();
  if (meta.changes === 0) return { ok: false, status: 404, error: "Inbox not found" };
  return { ok: true, data: { id: inbox.id, address: inbox.address, name: parsed } };
}

// Soft delete: only the inbox row is marked. Its webhooks and messages are unreachable while
// it is deleted, and come back as they were if it is restored.
export async function deleteInbox(env: Env, inbox: Inbox): Promise<Result<{ ok: true }>> {
  await env.DB.prepare("UPDATE inboxes SET deleted_at = ? WHERE id = ?").bind(Date.now(), inbox.id).run();
  return { ok: true, data: { ok: true } };
}

export async function restoreInbox(env: Env, inbox: Inbox): Promise<Result<{ id: string; address: string; name: string | null }>> {
  await env.DB.prepare("UPDATE inboxes SET deleted_at = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), inbox.id).run();
  return { ok: true, data: { id: inbox.id, address: inbox.address, name: inbox.name } };
}

// Permanent, unlike every other delete. A live inbox loses only what was already deleted;
// a deleted inbox is removed entirely, which needs `confirm`.
export async function purgeInbox(env: Env, inbox: Inbox, confirm: boolean): Promise<Result<{ messages: number; webhooks: number; inbox: boolean }>> {
  if (inbox.deleted_at) {
    if (!confirm) {
      return { ok: false, status: 400, error: "Purging a deleted inbox removes it and all its mail: pass confirm=true" };
    }
    const counts = await env.DB.batch<{ n: number }>([
      env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?").bind(inbox.id),
      env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE inbox_id = ?").bind(inbox.id),
    ]);
    // Its messages and webhooks go with it (ON DELETE CASCADE), then its stored mail.
    await env.DB.prepare("DELETE FROM inboxes WHERE id = ?").bind(inbox.id).run();
    await purgeInboxFiles(env, inbox.id);
    return { ok: true, data: { messages: counts[0].results[0].n, webhooks: counts[1].results[0].n, inbox: true } };
  }

  const messages = await purgeMessages(env, "inbox_id = ? AND deleted_at IS NOT NULL", inbox.id);
  const { meta } = await env.DB.prepare("DELETE FROM webhooks WHERE inbox_id = ? AND deleted_at IS NOT NULL")
    .bind(inbox.id)
    .run();
  return { ok: true, data: { messages, webhooks: meta.changes, inbox: false } };
}

// Invalidates the key a running agent holds, and every attachment link signed with it.
export async function rotateInboxKey(env: Env, inbox: Inbox): Promise<Result<{ api_key: string }>> {
  const apiKey = randomToken();
  const { meta } = await env.DB.prepare("UPDATE inboxes SET key_hash = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(await sha256(apiKey), Date.now(), inbox.id)
    .run();
  if (meta.changes === 0) return { ok: false, status: 404, error: "Inbox not found" };
  return { ok: true, data: { api_key: apiKey } };
}
