import { Hono } from "hono";
import { except } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { admin } from "./admin";
import { verifyAttachmentToken } from "./attachments";
import { authenticate, bearer, resolveInbox } from "./auth";
import type { Env, Inbox } from "./env";
import { type Attachment, loadAttachment } from "./mail";
import { mcp } from "./mcp";
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

// Every route except /admin/*, /health, /mcp and /attachments/* takes a bearer token: an inbox key,
// or the admin key with `?inbox=` naming the inbox to act on. Admin use of an inbox is logged,
// since it writes no row of its own.
const inboxAuth = createMiddleware<App>(async (c, next) => {
  const principal = await authenticate(c.env, bearer(c.req.header("Authorization")));
  if (!principal) return c.json({ error: "Unauthorized" }, 401);
  const inbox = await resolveInbox(c.env, principal, c.req.query("inbox"), "live");
  if (!inbox.ok) return reply(c, inbox);
  if (principal.kind === "admin") console.log({ event: "admin_access", method: c.req.method, path: c.req.path, inbox: inbox.data.address });
  c.set("inbox", inbox.data);
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

// Fetches one attachment by signed link. Authorized by the token alone, so anything holding the
// link can follow it; see src/attachments.ts for what the token proves and for how long.
app.get("/attachments/:token", async (c) => {
  const verified = await verifyAttachmentToken(c.env, c.req.param("token"));
  if (verified === "invalid") return c.json({ error: "Not found" }, 404);
  if (verified === "expired") return c.json({ error: "This link has expired. Read the message again for a new link." }, 410);
  const { inbox, messageId, index } = verified;
  const row = await findMessage(c.env, inbox.id, messageId);
  const attachment = row && (JSON.parse(row.attachments) as Attachment[])[index];
  const file = attachment && (await loadAttachment(c.env, inbox.id, messageId, index));
  if (!file) return c.json({ error: "This attachment is no longer available. It was purged." }, 410);
  const asciiSafe = attachment.filename.replace(/["\\\r\n]/g, "").replace(/[^\x00-\x7f]/g, "");
  return new Response(file.body, {
    headers: {
      "Content-Type": attachment.type,
      "Content-Disposition": `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    },
  });
});

app.route("/admin", admin);
app.route("/mcp", mcp);
app.use("*", except(["/admin/*", "/health", "/attachments/*", "/mcp"], inboxAuth));

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

app.get("/messages/:id", async (c) =>
  reply(c, await readMessage(c.env, c.get("inbox"), c.req.param("id"), c.req.query("mark_read") !== "false")),
);

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
