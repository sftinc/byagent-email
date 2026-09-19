import PostalMime from "postal-mime";
import { uuidv7 } from "./crypto";
import type { Env } from "./env";
import { addresses, fromEmail, saveMessage } from "./mail";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE address = ? AND deleted_at IS NULL")
    .bind(message.to.toLowerCase())
    .first<{ id: string }>();
  if (!inbox) {
    message.setReject("Unknown recipient");
    return;
  }

  // Mail is parsed once, here, and stored as JSON plus one file per attachment.
  const email = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const { message: stored, files } = fromEmail(email);
  const id = uuidv7();

  await saveMessage(env, inbox.id, id, stored, files);
  await env.DB.prepare(
    `INSERT INTO messages (id, inbox_id, direction, from_addr, from_name, recipients, subject, attachments, created_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      inbox.id,
      email.from?.address ?? message.from,
      email.from?.name ?? "",
      [...addresses(email.to), ...addresses(email.cc)].join(",").toLowerCase(),
      email.subject ?? null,
      JSON.stringify(stored.attachments),
      Date.now(),
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
