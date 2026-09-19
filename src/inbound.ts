import PostalMime from "postal-mime";
import { uuidv7 } from "./crypto";
import type { Env } from "./env";
import { addresses, mailKey } from "./mail";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE address = ? AND deleted_at IS NULL")
    .bind(message.to.toLowerCase())
    .first<{ id: string }>();
  if (!inbox) {
    message.setReject("Unknown recipient");
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const email = await PostalMime.parse(raw);
  const id = uuidv7();

  await env.MAIL.put(mailKey(inbox.id, id, "in"), raw);
  await env.DB.prepare(
    "INSERT INTO messages (id, inbox_id, direction, from_addr, from_name, recipients, subject, created_at) VALUES (?, ?, 'in', ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      inbox.id,
      email.from?.address ?? message.from,
      email.from?.name ?? "",
      [...addresses(email.to), ...addresses(email.cc)].join(",").toLowerCase(),
      email.subject ?? null,
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
