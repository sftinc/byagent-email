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

admin.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!c.env.ADMIN_KEY || (await sha256(token)) !== (await sha256(c.env.ADMIN_KEY))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

admin.post("/inboxes", async (c) => {
  const body = await c.req.json<{ address?: unknown }>().catch(() => ({}) as { address?: unknown });
  const address = typeof body.address === "string" ? body.address.toLowerCase() : "";
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

  const apiKey = randomToken();
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO inboxes (id, address, key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(uuidv7(), address, await sha256(apiKey), now, now)
    .run();
  return c.json({ address, api_key: apiKey }, 201);
});

admin.get("/inboxes", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT address, created_at FROM inboxes WHERE deleted_at IS NULL ORDER BY address",
  ).all();
  return c.json({ inboxes: results });
});

admin.delete("/inboxes/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  const inbox = await c.env.DB.prepare("SELECT id FROM inboxes WHERE address = ? AND deleted_at IS NULL")
    .bind(address)
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

admin.post("/inboxes/:address/rotate-key", async (c) => {
  const address = c.req.param("address").toLowerCase();
  const apiKey = randomToken();
  const { meta } = await c.env.DB.prepare(
    "UPDATE inboxes SET key_hash = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL",
  )
    .bind(await sha256(apiKey), Date.now(), address)
    .run();
  if (meta.changes === 0) return c.json({ error: "Inbox not found" }, 404);
  return c.json({ api_key: apiKey });
});
