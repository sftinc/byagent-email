import { Hono } from "hono";
import { randomToken, sha256, uuidv7 } from "./crypto";
import type { Env } from "./env";
import { purgeInboxFiles, purgeMessages } from "./mail";
import { BAD_NAME, parseName } from "./validate";

export const admin = new Hono<{ Bindings: Env }>();

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

admin.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!c.env.ADMIN_KEY || (await sha256(token)) !== (await sha256(c.env.ADMIN_KEY))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

admin.post("/inboxes", async (c) => {
  const body = await c.req.json<{ address?: unknown; name?: unknown }>().catch(() => ({}) as { address?: unknown; name?: unknown });
  const address = typeof body.address === "string" ? body.address.toLowerCase() : "";
  const name = parseName(body.name);
  if (name === undefined) return c.json({ error: BAD_NAME }, 400);
  // Any domain works, as long as it is set up for this Worker in Cloudflare (see README).
  if (!/^[a-z0-9._-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/.test(address)) {
    return c.json({ error: "`address` must look like name@example.com (name: 1-64 of a-z 0-9 . _ -)" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT deleted_at FROM inboxes WHERE address = ?")
    .bind(address)
    .first<{ deleted_at: number | null }>();
  if (exists) {
    const error = exists.deleted_at ? "Inbox already exists, deleted: restore it instead" : "Inbox already exists";
    return c.json({ error }, 409);
  }
  const domain = address.split("@")[1];
  if (!(await hasCloudflareMx(domain))) {
    return c.json({ error: `${domain} has no Cloudflare Email Routing MX records` }, 400);
  }

  const id = uuidv7();
  const apiKey = randomToken();
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO inboxes (id, address, name, key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, address, name, await sha256(apiKey), now, now)
    .run();
  return c.json({ id, address, name, api_key: apiKey }, 201);
});

admin.get("/inboxes", async (c) => {
  const deleted = c.req.query("deleted") === "true";
  const { results } = await c.env.DB.prepare(
    `SELECT id, address, name, created_at${deleted ? ", deleted_at" : ""} FROM inboxes
     WHERE deleted_at IS ${deleted ? "NOT NULL" : "NULL"} ORDER BY address`,
  ).all();
  return c.json({ inboxes: results });
});

// Mail for addresses no inbox holds. Unpaged like the other admin lists, but capped: the row
// count here is set by whoever is mailing the domain, not by us.
admin.get("/rejected", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, from_addr, recipients, subject, status_reason, created_at FROM messages
     WHERE inbox_id IS NULL ORDER BY id DESC LIMIT 100`,
  ).all();
  return c.json({ rejected: results });
});

admin.patch("/inboxes/:id", async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  const name = parseName(body.name);
  if (name === undefined) return c.json({ error: BAD_NAME }, 400);
  const inbox = await c.env.DB.prepare(
    "UPDATE inboxes SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING id, address, name",
  )
    .bind(name, Date.now(), c.req.param("id"))
    .first();
  if (!inbox) return c.json({ error: "Inbox not found" }, 404);
  return c.json(inbox);
});

admin.delete("/inboxes/:id", async (c) => {
  const inbox = await c.env.DB.prepare("SELECT id FROM inboxes WHERE id = ? AND deleted_at IS NULL")
    .bind(c.req.param("id"))
    .first<{ id: string }>();
  if (!inbox) return c.json({ error: "Inbox not found" }, 404);

  // Soft delete: only the inbox row is marked. Its webhooks and messages are unreachable while
  // it is deleted, and come back as they were if it is restored.
  await c.env.DB.prepare("UPDATE inboxes SET deleted_at = ? WHERE id = ?").bind(Date.now(), inbox.id).run();
  return c.json({ ok: true });
});

admin.post("/inboxes/:id/restore", async (c) => {
  const inbox = await c.env.DB.prepare("SELECT id, address, name FROM inboxes WHERE id = ? AND deleted_at IS NOT NULL")
    .bind(c.req.param("id"))
    .first<{ id: string; address: string; name: string | null }>();
  if (!inbox) return c.json({ error: "Inbox not found" }, 404);
  await c.env.DB.prepare("UPDATE inboxes SET deleted_at = NULL, updated_at = ? WHERE id = ?")
    .bind(Date.now(), inbox.id)
    .run();
  return c.json({ id: inbox.id, address: inbox.address, name: inbox.name });
});

// Permanent, unlike every other delete. A live inbox loses only what was already deleted;
// a deleted inbox is removed entirely, which needs ?confirm=true.
admin.post("/inboxes/:id/purge", async (c) => {
  const id = c.req.param("id");
  const inbox = await c.env.DB.prepare("SELECT id, deleted_at FROM inboxes WHERE id = ?")
    .bind(id)
    .first<{ id: string; deleted_at: number | null }>();
  if (!inbox) return c.json({ error: "Inbox not found" }, 404);

  if (inbox.deleted_at) {
    if (c.req.query("confirm") !== "true") {
      return c.json({ error: "Purging a deleted inbox removes it and all its mail: pass ?confirm=true" }, 400);
    }
    const counts = await c.env.DB.batch<{ n: number }>([
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?").bind(id),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE inbox_id = ?").bind(id),
    ]);
    // Its messages and webhooks go with it (ON DELETE CASCADE), then its stored mail.
    await c.env.DB.prepare("DELETE FROM inboxes WHERE id = ?").bind(id).run();
    await purgeInboxFiles(c.env, id);
    return c.json({ messages: counts[0].results[0].n, webhooks: counts[1].results[0].n, inbox: true });
  }

  const messages = await purgeMessages(c.env, "inbox_id = ? AND deleted_at IS NOT NULL", id);
  const { meta } = await c.env.DB.prepare("DELETE FROM webhooks WHERE inbox_id = ? AND deleted_at IS NOT NULL")
    .bind(id)
    .run();
  return c.json({ messages, webhooks: meta.changes, inbox: false });
});

admin.post("/inboxes/:id/rotate-key", async (c) => {
  const apiKey = randomToken();
  const { meta } = await c.env.DB.prepare(
    "UPDATE inboxes SET key_hash = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(await sha256(apiKey), Date.now(), c.req.param("id"))
    .run();
  if (meta.changes === 0) return c.json({ error: "Inbox not found" }, 404);
  return c.json({ api_key: apiKey });
});
