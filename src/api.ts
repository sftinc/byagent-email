import { Hono } from "hono";
import { except } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { admin } from "./admin";
import { randomToken, sha256, uuidv7 } from "./crypto";
import type { Env } from "./env";
import { type Direction, loadMessage, purgeMessages, saveSent, summarize } from "./mail";
import { buildEmail } from "./send";

type App = { Bindings: Env; Variables: { inboxId: string; address: string } };

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
    ? await c.env.DB.prepare("SELECT id, address FROM inboxes WHERE key_hash = ?")
        .bind(await sha256(token))
        .first<{ id: string; address: string }>()
    : null;
  if (!row) return c.json({ error: "Unauthorized" }, 401);
  c.set("inboxId", row.id);
  c.set("address", row.address);
  await next();
});

app.route("/admin", admin);
app.use("*", except("/admin/*", inboxAuth));

app.get("/messages", async (c) => {
  let sql =
    'SELECT id, direction, from_addr AS "from", recipients, subject, received_at, read FROM messages WHERE inbox_id = ?';
  const params: unknown[] = [c.get("inboxId")];
  const direction = c.req.query("direction") ?? "in";
  if (!["in", "out", "all"].includes(direction)) return c.json({ error: "`direction` must be in, out or all" }, 400);
  if (direction !== "all") {
    sql += " AND direction = ?";
    params.push(direction);
  }
  if (c.req.query("unread") === "true") sql += " AND read = 0";
  for (const [param, column] of [["from", "from_addr"], ["to", "recipients"]]) {
    const value = c.req.query(param);
    if (value) {
      sql += ` AND instr(lower(${column}), lower(?)) > 0`;
      params.push(value);
    }
  }
  const since = Number(c.req.query("since"));
  if (since > 0) {
    sql += " AND received_at > ?";
    params.push(since);
  }
  sql += since > 0 ? " ORDER BY received_at ASC LIMIT 100" : " ORDER BY received_at DESC LIMIT 100";
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<{ recipients: string; read: number }>();
  return c.json({
    messages: results.map((m) => ({ ...m, recipients: m.recipients ? m.recipients.split(",") : [], read: m.read === 1 })),
  });
});

async function findMessage(env: Env, inboxId: string, id: string) {
  return env.DB.prepare("SELECT read, direction FROM messages WHERE id = ? AND inbox_id = ?")
    .bind(id, inboxId)
    .first<{ read: number; direction: Direction }>();
}

app.get("/messages/:id", async (c) => {
  const id = c.req.param("id");
  const row = await findMessage(c.env, c.get("inboxId"), id);
  const email = row && (await loadMessage(c.env, c.get("inboxId"), id, row.direction));
  if (!row || !email) return c.json({ error: "Message not found" }, 404);
  return c.json({ ...summarize(id, email), read: row.read === 1 });
});

app.get("/messages/:id/attachments/:index", async (c) => {
  const id = c.req.param("id");
  const row = await findMessage(c.env, c.get("inboxId"), id);
  const email = row && (await loadMessage(c.env, c.get("inboxId"), id, row.direction));
  const attachment = email?.attachments[Number(c.req.param("index"))];
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);
  const filename = attachment.filename ?? "attachment";
  const asciiSafe = filename.replace(/["\\\r\n]/g, "").replace(/[^\x00-\x7f]/g, "");
  return new Response(attachment.content, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Disposition": `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
});

app.post("/messages/:id/read", async (c) => {
  const { meta } = await c.env.DB.prepare("UPDATE messages SET read = 1 WHERE id = ? AND inbox_id = ?")
    .bind(c.req.param("id"), c.get("inboxId"))
    .run();
  if (meta.changes === 0) return c.json({ error: "Message not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/messages/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await findMessage(c.env, c.get("inboxId"), id))) return c.json({ error: "Message not found" }, 404);
  await purgeMessages(c.env, "id = ?", id);
  return c.json({ ok: true });
});

app.get("/webhooks", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, url FROM webhooks WHERE inbox_id = ?")
    .bind(c.get("inboxId"))
    .all();
  return c.json({ webhooks: results });
});

app.post("/webhooks", async (c) => {
  const body = await c.req.json<{ url?: unknown }>().catch(() => ({}) as { url?: unknown });
  const url = typeof body.url === "string" && URL.canParse(body.url) ? new URL(body.url) : null;
  if (url?.protocol !== "https:") return c.json({ error: "`url` must be an https:// URL" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE inbox_id = ?")
    .bind(c.get("inboxId"))
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 10) return c.json({ error: "At most 10 webhooks per inbox" }, 400);
  const id = uuidv7();
  const secret = randomToken();
  await c.env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret) VALUES (?, ?, ?, ?)")
    .bind(id, c.get("inboxId"), url.href, secret)
    .run();
  return c.json({ id, url: url.href, secret }, 201);
});

app.delete("/webhooks/:id", async (c) => {
  const { meta } = await c.env.DB.prepare("DELETE FROM webhooks WHERE id = ? AND inbox_id = ?")
    .bind(c.req.param("id"), c.get("inboxId"))
    .run();
  if (meta.changes === 0) return c.json({ error: "Webhook not found" }, 404);
  return c.json({ ok: true });
});

app.post("/send", async (c) => {
  const built = buildEmail(await c.req.json().catch(() => null), c.get("address"));
  if (!built.ok) return c.json({ error: built.error }, built.status);
  let messageId: string;
  try {
    ({ messageId } = await c.env.EMAIL.send(built.message));
  } catch (err: any) {
    return c.json({ error: err?.code ?? err?.message ?? "Send failed" }, 502);
  }
  const id = await saveSent(c.env, c.get("inboxId"), c.get("address"), built.message);
  return c.json({ id, messageId });
});
