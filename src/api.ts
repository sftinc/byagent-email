import { Hono } from "hono";
import { except } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { admin } from "./admin";
import { randomToken, sha256, uuidv7 } from "./crypto";
import type { Env, Inbox } from "./env";
import { type Attachment, loadAttachment, loadMessage, saveSent } from "./mail";
import { buildEmail } from "./send";
import { BAD_BEARER, BAD_NAME, parseBearer, parseName } from "./validate";

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
    ? await c.env.DB.prepare("SELECT id, address, name FROM inboxes WHERE key_hash = ? AND deleted_at IS NULL")
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

// Lists messages 20 at a time, newest first. IDs are UUID v7, so they sort by creation time
// with no ties. `paging.before` / `paging.after` are the ids to pass for older / newer mail.
app.get("/messages", async (c) => {
  // `deleted=true` lists only deleted messages; otherwise only live ones.
  const deleted = c.req.query("deleted") === "true";
  let where = `inbox_id = ? AND deleted_at IS ${deleted ? "NOT NULL" : "NULL"}`;
  const params: unknown[] = [c.get("inbox").id];
  const direction = c.req.query("direction") ?? "in";
  if (!["in", "out", "all"].includes(direction)) return c.json({ error: "`direction` must be in, out or all" }, 400);
  if (direction !== "all") {
    where += " AND direction = ?";
    params.push(direction);
  }
  if (c.req.query("unread") === "true") where += " AND read_at IS NULL";
  for (const [param, column] of [["from", "from_addr"], ["to", "recipients"], ["subject", "subject"]]) {
    const value = c.req.query(param);
    if (value) {
      where += ` AND instr(lower(${column}), lower(?)) > 0`;
      params.push(value);
    }
  }
  const before = c.req.query("before");
  const after = c.req.query("after");
  if (before && after) return c.json({ error: "Use `before` or `after`, not both" }, 400);

  // Fetch one extra row to learn whether there's more in the direction we're paging.
  const cursor = after ? " AND id > ? ORDER BY id ASC" : before ? " AND id < ? ORDER BY id DESC" : " ORDER BY id DESC";
  const { results } = await c.env.DB.prepare(
    `SELECT id, direction, from_addr, from_name, recipients, subject, attachments, created_at, read_at, deleted_at
     FROM messages WHERE ${where}${cursor} LIMIT 21`,
  )
    .bind(...params, ...(after || before ? [after || before] : []))
    .all<{ id: string; from_addr: string; from_name: string; recipients: string; attachments: string }>();
  const more = results.length > 20;
  const page = results.slice(0, 20);
  if (after) page.reverse();

  // The page's edges; an empty page measures from the cursor it was given.
  const newest = page[0]?.id ?? before;
  const oldest = page.at(-1)?.id ?? after;
  const exists = async (op: "<" | ">", id?: string) =>
    id !== undefined &&
    (await c.env.DB.prepare(`SELECT 1 FROM messages WHERE ${where} AND id ${op} ? LIMIT 1`).bind(...params, id).first()) !== null;
  const hasOlder = after ? await exists("<", oldest) : more;
  const hasNewer = after ? more : await exists(">", newest);

  return c.json({
    messages: page.map(({ from_addr, from_name, ...m }) => ({
      ...m,
      from: { name: from_name, address: from_addr },
      recipients: m.recipients ? m.recipients.split(",") : [],
      attachments: (JSON.parse(m.attachments) as Attachment[]).map((a, index) => ({ index, ...a })),
    })),
    paging: { before: hasOlder ? oldest : null, after: hasNewer ? newest : null },
  });
});

function findMessage(env: Env, inboxId: string, id: string) {
  // Deleted messages are still readable by id; only changing them 404s.
  return env.DB.prepare(
    "SELECT direction, attachments, created_at, read_at, deleted_at FROM messages WHERE id = ? AND inbox_id = ?",
  )
    .bind(id, inboxId)
    .first<{ direction: string; attachments: string; created_at: number; read_at: number | null; deleted_at: number | null }>();
}

// Reading a message marks it read, keeping the first time. POST /messages/:id/unread undoes it.
app.get("/messages/:id", async (c) => {
  const id = c.req.param("id");
  const row = await findMessage(c.env, c.get("inbox").id, id);
  const stored = row && (await loadMessage(c.env, c.get("inbox").id, id));
  if (!row || !stored) return c.json({ error: "Message not found" }, 404);

  let readAt = row.read_at;
  if (readAt === null && row.deleted_at === null) {
    readAt = Date.now();
    await c.env.DB.prepare("UPDATE messages SET read_at = ? WHERE id = ?").bind(readAt, id).run();
  }
  return c.json({
    id,
    ...stored,
    attachments: stored.attachments.map((a, index) => ({ index, ...a })),
    direction: row.direction,
    created_at: row.created_at,
    read_at: readAt,
    deleted_at: row.deleted_at,
  });
});

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

app.post("/messages/:id/unread", async (c) => {
  const { meta } = await c.env.DB.prepare(
    "UPDATE messages SET read_at = NULL WHERE id = ? AND inbox_id = ? AND deleted_at IS NULL",
  )
    .bind(c.req.param("id"), c.get("inbox").id)
    .run();
  if (meta.changes === 0) return c.json({ error: "Message not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/messages/:id", async (c) => {
  const { meta } = await c.env.DB.prepare(
    "UPDATE messages SET deleted_at = ? WHERE id = ? AND inbox_id = ? AND deleted_at IS NULL",
  )
    .bind(Date.now(), c.req.param("id"), c.get("inbox").id)
    .run();
  if (meta.changes === 0) return c.json({ error: "Message not found" }, 404);
  return c.json({ ok: true });
});

app.post("/messages/:id/restore", async (c) => {
  const { meta } = await c.env.DB.prepare(
    "UPDATE messages SET deleted_at = NULL WHERE id = ? AND inbox_id = ? AND deleted_at IS NOT NULL",
  )
    .bind(c.req.param("id"), c.get("inbox").id)
    .run();
  if (meta.changes === 0) return c.json({ error: "Message not found" }, 404);
  return c.json({ ok: true });
});

// How many webhooks the inbox has, against the cap of 10.
async function webhookCount(env: Env, inboxId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE inbox_id = ? AND deleted_at IS NULL")
    .bind(inboxId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const TOO_MANY = "At most 10 webhooks per inbox";

app.get("/webhooks", async (c) => {
  const deleted = c.req.query("deleted") === "true";
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, url, succeeded_at, failed_at${deleted ? ", deleted_at" : ""} FROM webhooks WHERE inbox_id = ? AND deleted_at IS ${deleted ? "NOT NULL" : "NULL"}`,
  )
    .bind(c.get("inbox").id)
    .all();
  return c.json({ webhooks: results });
});

app.post("/webhooks", async (c) => {
  type WebhookBody = { url?: unknown; name?: unknown; bearer?: unknown };
  const body = await c.req.json<WebhookBody>().catch(() => ({}) as WebhookBody);
  const url = typeof body.url === "string" && URL.canParse(body.url) ? new URL(body.url) : null;
  if (url?.protocol !== "https:") return c.json({ error: "`url` must be an https:// URL" }, 400);
  const name = parseName(body.name);
  if (name === undefined) return c.json({ error: BAD_NAME }, 400);
  const bearer = parseBearer(body.bearer);
  if (bearer === undefined) return c.json({ error: BAD_BEARER }, 400);
  if ((await webhookCount(c.env, c.get("inbox").id)) >= 10) return c.json({ error: TOO_MANY }, 400);
  const id = uuidv7();
  const secret = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO webhooks (id, inbox_id, name, url, secret, bearer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, c.get("inbox").id, name, url.href, secret, bearer, Date.now())
    .run();
  return c.json({ id, name, url: url.href, secret }, 201);
});

app.delete("/webhooks/:id", async (c) => {
  const { meta } = await c.env.DB.prepare(
    "UPDATE webhooks SET deleted_at = ? WHERE id = ? AND inbox_id = ? AND deleted_at IS NULL",
  )
    .bind(Date.now(), c.req.param("id"), c.get("inbox").id)
    .run();
  if (meta.changes === 0) return c.json({ error: "Webhook not found" }, 404);
  return c.json({ ok: true });
});

app.post("/webhooks/:id/restore", async (c) => {
  const id = c.req.param("id");
  const found = await c.env.DB.prepare("SELECT 1 FROM webhooks WHERE id = ? AND inbox_id = ? AND deleted_at IS NOT NULL")
    .bind(id, c.get("inbox").id)
    .first();
  if (!found) return c.json({ error: "Webhook not found" }, 404);
  if ((await webhookCount(c.env, c.get("inbox").id)) >= 10) return c.json({ error: TOO_MANY }, 400);
  await c.env.DB.prepare("UPDATE webhooks SET deleted_at = NULL WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

app.post("/send", async (c) => {
  const inbox = c.get("inbox");
  const from = inbox.name ? { email: inbox.address, name: inbox.name } : inbox.address;
  const body = await c.req.json<any>().catch(() => null);
  const built = buildEmail(body, from);
  if (!built.ok) return c.json({ error: built.error }, built.status);

  // `reply_to_id` is one of this inbox's messages: reply in its thread.
  if (body.reply_to_id !== undefined) {
    const replyTo = typeof body.reply_to_id === "string" ? body.reply_to_id : "";
    const row = replyTo ? await findMessage(c.env, inbox.id, replyTo) : null;
    const parent = row && (await loadMessage(c.env, inbox.id, replyTo));
    if (!parent?.message_id) return c.json({ error: "`reply_to_id` is not a message in this inbox" }, 400);
    const references = [...parent.references, parent.message_id];
    built.message.headers = { "In-Reply-To": parent.message_id, References: references.join(" ") };
  }
  let messageId: string;
  try {
    ({ messageId } = await c.env.EMAIL.send(built.message));
  } catch (err: any) {
    return c.json({ error: err?.code ?? err?.message ?? "Send failed" }, 502);
  }
  const id = await saveSent(c.env, inbox, built.message, messageId);
  return c.json({ id, messageId });
});
