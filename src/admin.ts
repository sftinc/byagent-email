import { Hono } from "hono";
import { randomToken, sha256, uuidv7 } from "./crypto";
import type { Env } from "./env";

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

// An inbox's optional display name. null or "" means no name. Line breaks and other control
// characters are refused, so a name can't add headers to outgoing mail. undefined = invalid.
function parseName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) return undefined;
  return name || null;
}

const BAD_NAME = "`name` must be text, at most 100 characters, with no line breaks";

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
  const exists = await c.env.DB.prepare("SELECT 1 FROM inboxes WHERE address = ? AND deleted_at IS NULL")
    .bind(address)
    .first();
  if (exists) return c.json({ error: "Inbox already exists" }, 409);
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
  const { results } = await c.env.DB.prepare(
    "SELECT id, address, name, created_at FROM inboxes WHERE deleted_at IS NULL ORDER BY address",
  ).all();
  return c.json({ inboxes: results });
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

  // Soft delete: the inbox, its webhooks and its messages are hidden, and stored mail is kept.
  const now = Date.now();
  await c.env.DB.batch(
    ["webhooks", "messages"]
      .map((table) =>
        c.env.DB.prepare(`UPDATE ${table} SET deleted_at = ? WHERE inbox_id = ? AND deleted_at IS NULL`).bind(now, inbox.id),
      )
      .concat(c.env.DB.prepare("UPDATE inboxes SET deleted_at = ? WHERE id = ?").bind(now, inbox.id)),
  );
  return c.json({ ok: true });
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
