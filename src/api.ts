import { Hono } from "hono";
import { except } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { admin } from "./admin";
import { sha256 } from "./crypto";
import type { Env, Inbox } from "./env";
import { type Attachment, loadAttachment } from "./mail";
import { deleteMessage, findMessage, listMessages, markUnread, readMessage, restoreMessage } from "./messages";
import { sendMail } from "./send";
import { reply } from "./reply";
import { createWebhook, deleteWebhook, listWebhooks, restoreWebhook } from "./webhooks";

type App = { Bindings: Env; Variables: { inbox: Inbox } };

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
    ? await c.env.DB.prepare("SELECT id, address, name, key_hash, deleted_at FROM inboxes WHERE key_hash = ? AND deleted_at IS NULL")
        .bind(await sha256(token))
        .first<Inbox>()
    : null;
  if (!row) return c.json({ error: "Unauthorized" }, 401);
  c.set("inbox", row);
  await next();
});

// Unauthenticated, for uptime checks: 200 when the database answers, 503 when it doesn't.
app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch (err) {
    console.error(err);
    return c.json({ ok: false }, 503);
  }
  return c.json({ ok: true });
});

app.route("/admin", admin);
app.use("*", except(["/admin/*", "/health"], inboxAuth));

app.get("/messages", async (c) =>
  reply(
    c,
    await listMessages(c.env, c.get("inbox"), {
      direction: c.req.query("direction"),
      unread: c.req.query("unread") === "true",
      from: c.req.query("from"),
      to: c.req.query("to"),
      subject: c.req.query("subject"),
      deleted: c.req.query("deleted") === "true",
      before: c.req.query("before"),
      after: c.req.query("after"),
    }),
  ),
);

app.get("/messages/:id", async (c) => reply(c, await readMessage(c.env, c.get("inbox"), c.req.param("id"))));

app.get("/messages/:id/attachments/:index", async (c) => {
  const id = c.req.param("id");
  const index = Number(c.req.param("index"));
  const row = await findMessage(c.env, c.get("inbox").id, id);
  const attachment = row && (JSON.parse(row.attachments) as Attachment[])[index];
  const file = attachment && (await loadAttachment(c.env, c.get("inbox").id, id, index));
  if (!file) return c.json({ error: "Attachment not found" }, 404);
  const asciiSafe = attachment.filename.replace(/["\\\r\n]/g, "").replace(/[^\x00-\x7f]/g, "");
  return new Response(file.body, {
    headers: {
      "Content-Type": attachment.type,
      "Content-Disposition": `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    },
  });
});

app.post("/messages/:id/unread", async (c) => reply(c, await markUnread(c.env, c.get("inbox"), c.req.param("id"))));

app.delete("/messages/:id", async (c) => reply(c, await deleteMessage(c.env, c.get("inbox"), c.req.param("id"))));

app.post("/messages/:id/restore", async (c) => reply(c, await restoreMessage(c.env, c.get("inbox"), c.req.param("id"))));

app.get("/webhooks", async (c) => reply(c, await listWebhooks(c.env, c.get("inbox"), c.req.query("deleted") === "true")));
app.post("/webhooks", async (c) =>
  reply(c, await createWebhook(c.env, c.get("inbox"), await c.req.json().catch(() => ({}))), 201),
);
app.delete("/webhooks/:id", async (c) => reply(c, await deleteWebhook(c.env, c.get("inbox"), c.req.param("id"))));
app.post("/webhooks/:id/restore", async (c) => reply(c, await restoreWebhook(c.env, c.get("inbox"), c.req.param("id"))));

app.post("/send", async (c) => reply(c, await sendMail(c.env, c.get("inbox"), await c.req.json<any>().catch(() => null))));
