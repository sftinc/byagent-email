import PostalMime from "postal-mime";
import { uuidv7 } from "./crypto";
import type { Env } from "./env";
import { addresses, fromEmail, saveMessage } from "./mail";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE address = ? AND deleted_at IS NULL")
    .bind(message.to.toLowerCase())
    .first<{ id: string }>();
  // Mail for an address no inbox holds is still recorded, with no inbox and no stored body:
  // rejecting happens before the mail is parsed, and there is no prefix to write files under.
  if (!inbox) {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages (id, inbox_id, direction, status, status_reason, message_id, from_addr, from_name, recipients, subject, attachments, created_at, updated_at)
       VALUES (?, NULL, 'in', 'rejected', 'unknown_recipient', NULL, ?, '', ?, ?, '[]', ?, ?)`,
    )
      .bind(uuidv7(), message.from, message.to.toLowerCase(), message.headers.get("subject"), now, now)
      .run();
    message.setReject("Unknown recipient");
    return;
  }

  // Mail is parsed once, here, and stored as JSON plus one file per attachment.
  const email = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const { message: stored, files } = fromEmail(email);
  const id = uuidv7();
  const now = Date.now();

  await saveMessage(env, inbox.id, id, stored, files);
  await env.DB.prepare(
    `INSERT INTO messages (id, inbox_id, direction, status, status_reason, message_id, from_addr, from_name, recipients, subject, attachments, created_at, updated_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      inbox.id,
      "received",
      null,
      email.messageId ?? null,
      email.from?.address ?? message.from,
      email.from?.name ?? "",
      [...addresses(email.to), ...addresses(email.cc)].join(",").toLowerCase(),
      email.subject ?? null,
      JSON.stringify(stored.attachments),
      now,
      now,
    )
    .run();

  const { results } = await env.DB.prepare("SELECT id FROM webhooks WHERE inbox_id = ? AND deleted_at IS NULL")
    .bind(inbox.id)
    .all<{ id: string }>();
  if (results.length > 0) {
    try {
      await env.WEBHOOKS.sendBatch(
        results.map((w) => ({ body: { webhookId: w.id, messageId: id } })),
      );
    } catch (err) {
      console.error(err);
    }
  }
}
