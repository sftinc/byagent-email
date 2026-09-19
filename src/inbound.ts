import PostalMime from "postal-mime";
import type { Env } from "./env";
import { rawKey } from "./mail";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const inbox = message.to.toLowerCase();
  const found = await env.DB.prepare("SELECT 1 FROM inboxes WHERE address = ?").bind(inbox).first();
  if (!found) {
    message.setReject("Unknown recipient");
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const email = await PostalMime.parse(raw);
  const id = crypto.randomUUID();

  await env.MAIL.put(rawKey(inbox, id), raw);
  await env.DB.prepare(
    "INSERT INTO messages (id, inbox, from_addr, subject, received_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, inbox, email.from?.address ?? message.from, email.subject ?? null, Date.now())
    .run();

  const { results } = await env.DB.prepare("SELECT id FROM webhooks WHERE inbox = ?")
    .bind(inbox)
    .all<{ id: string }>();
  if (results.length > 0) {
    try {
      await env.WEBHOOKS.sendBatch(
        results.map((w) => ({ body: { webhookId: w.id, inbox, messageId: id } })),
      );
    } catch (err) {
      console.error(err);
    }
  }
}
