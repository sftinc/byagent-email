import { Hono } from "hono";
import { except } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { admin } from "./admin";
import { sha256 } from "./crypto";
import type { Env } from "./env";
import { loadMessage, purgeMessages, summarize } from "./mail";
import { buildEmail } from "./send";

type App = { Bindings: Env; Variables: { inbox: string } };

export const app = new Hono<App>();

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// Every route except /admin/* is authenticated with an inbox API key.
const inboxAuth = createMiddleware<App>(async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
  const row = token
    ? await c.env.DB.prepare("SELECT address FROM inboxes WHERE key_hash = ?")
        .bind(await sha256(token))
        .first<{ address: string }>()
    : null;
  if (!row) return c.json({ error: "Unauthorized" }, 401);
  c.set("inbox", row.address);
  await next();
});

app.route("/admin", admin);
app.use("*", except("/admin/*", inboxAuth));

app.get("/messages", async (c) => {
  let sql = 'SELECT id, from_addr AS "from", subject, received_at, read FROM messages WHERE inbox = ?';
  const params: unknown[] = [c.get("inbox")];
  if (c.req.query("unread") === "true") sql += " AND read = 0";
  const since = Number(c.req.query("since"));
  if (since > 0) {
    sql += " AND received_at > ?";
    params.push(since);
  }
  sql += " ORDER BY received_at DESC LIMIT 100";
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<{ read: number }>();
  return c.json({ messages: results.map((m) => ({ ...m, read: m.read === 1 })) });
});

async function findMessage(env: Env, inbox: string, id: string) {
  return env.DB.prepare("SELECT read FROM messages WHERE id = ? AND inbox = ?")
    .bind(id, inbox)
    .first<{ read: number }>();
}

app.get("/messages/:id", async (c) => {
  const id = c.req.param("id");
  const row = await findMessage(c.env, c.get("inbox"), id);
  const email = row && (await loadMessage(c.env, c.get("inbox"), id));
  if (!row || !email) return c.json({ error: "Message not found" }, 404);
  return c.json({ ...summarize(id, email), read: row.read === 1 });
});

app.get("/messages/:id/attachments/:index", async (c) => {
  const id = c.req.param("id");
  const row = await findMessage(c.env, c.get("inbox"), id);
  const email = row && (await loadMessage(c.env, c.get("inbox"), id));
  const attachment = email?.attachments[Number(c.req.param("index"))];
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);
  const filename = (attachment.filename ?? "attachment").replace(/["\\\r\n]/g, "");
  return new Response(attachment.content, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

app.post("/messages/:id/read", async (c) => {
  const { meta } = await c.env.DB.prepare("UPDATE messages SET read = 1 WHERE id = ? AND inbox = ?")
    .bind(c.req.param("id"), c.get("inbox"))
    .run();
  if (meta.changes === 0) return c.json({ error: "Message not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/messages/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await findMessage(c.env, c.get("inbox"), id))) return c.json({ error: "Message not found" }, 404);
  await purgeMessages(c.env, "id = ?", id);
  return c.json({ ok: true });
});

app.get("/webhooks", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, url FROM webhooks WHERE inbox = ?")
    .bind(c.get("inbox"))
    .all();
  return c.json({ webhooks: results });
});

app.post("/webhooks", async (c) => {
  const body = await c.req.json<{ url?: unknown }>().catch(() => ({}) as { url?: unknown });
  const url = typeof body.url === "string" && URL.canParse(body.url) ? new URL(body.url) : null;
  if (url?.protocol !== "https:") return c.json({ error: "`url` must be an https:// URL" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO webhooks (id, inbox, url) VALUES (?, ?, ?)")
    .bind(id, c.get("inbox"), url.href)
    .run();
  return c.json({ id, url: url.href }, 201);
});

app.delete("/webhooks/:id", async (c) => {
  const { meta } = await c.env.DB.prepare("DELETE FROM webhooks WHERE id = ? AND inbox = ?")
    .bind(c.req.param("id"), c.get("inbox"))
    .run();
  if (meta.changes === 0) return c.json({ error: "Webhook not found" }, 404);
  return c.json({ ok: true });
});

app.post("/send", async (c) => {
  const built = buildEmail(await c.req.json().catch(() => null), c.get("inbox"));
  if (!built.ok) return c.json({ error: built.error }, built.status);
  try {
    const { messageId } = await c.env.EMAIL.send(built.message);
    return c.json({ messageId });
  } catch (err: any) {
    return c.json({ error: err?.code ?? err?.message ?? "Send failed" }, 502);
  }
});
