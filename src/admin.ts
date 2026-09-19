import { Hono } from "hono";
import { randomToken, sha256 } from "./crypto";
import type { Env } from "./env";
import { purgeMessages } from "./mail";

export const admin = new Hono<{ Bindings: Env }>();

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
  const exists = await c.env.DB.prepare("SELECT 1 FROM inboxes WHERE address = ?").bind(address).first();
  if (exists) return c.json({ error: "Inbox already exists" }, 409);

  const apiKey = randomToken();
  const webhookSecret = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO inboxes (address, key_hash, webhook_secret, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(address, await sha256(apiKey), webhookSecret, Date.now())
    .run();
  return c.json({ address, api_key: apiKey, webhook_secret: webhookSecret }, 201);
});

admin.get("/inboxes", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT address, created_at FROM inboxes ORDER BY address",
  ).all();
  return c.json({ inboxes: results });
});

admin.delete("/inboxes/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  const exists = await c.env.DB.prepare("SELECT 1 FROM inboxes WHERE address = ?").bind(address).first();
  if (!exists) return c.json({ error: "Inbox not found" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM webhooks WHERE inbox = ?").bind(address),
    c.env.DB.prepare("DELETE FROM inboxes WHERE address = ?").bind(address),
  ]);
  await purgeMessages(c.env, "inbox = ?", address);
  return c.json({ ok: true });
});

admin.post("/inboxes/:address/rotate-key", async (c) => {
  const address = c.req.param("address").toLowerCase();
  const apiKey = randomToken();
  const { meta } = await c.env.DB.prepare("UPDATE inboxes SET key_hash = ? WHERE address = ?")
    .bind(await sha256(apiKey), address)
    .run();
  if (meta.changes === 0) return c.json({ error: "Inbox not found" }, 404);
  return c.json({ api_key: apiKey });
});
