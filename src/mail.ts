import PostalMime, { type Address, type Email } from "postal-mime";
import { uuidv7 } from "./crypto";
import type { Env, Inbox } from "./env";

export type Direction = "in" | "out";

// Received mail is stored raw. Sent mail has no raw MIME, so it's stored as JSON in postal-mime's shape.
export function mailKey(inboxId: string, id: string, direction: Direction): string {
  return `${inboxId}/${id}.${direction === "in" ? "eml" : "json"}`;
}

export async function loadMessage(env: Env, inboxId: string, id: string, direction: Direction): Promise<Email | null> {
  const object = await env.MAIL.get(mailKey(inboxId, id, direction));
  if (!object) return null;
  if (direction === "in") return PostalMime.parse(await object.arrayBuffer());
  const email = await object.json<Email>();
  email.attachments = email.attachments.map((a) => ({ ...a, content: Uint8Array.fromBase64(a.content as string) }));
  return email;
}

// Saves a message built by buildEmail, whose recipients are string arrays and attachments are bytes.
export async function saveSent(env: Env, inbox: Inbox, message: EmailMessageBuilder, messageId: string): Promise<string> {
  const id = uuidv7();
  const [to, cc, bcc] = [message.to, message.cc, message.bcc].map((list) => (list ?? []) as string[]);
  const email = {
    from: { name: inbox.name ?? "", address: inbox.address },
    to: to.map((address) => ({ name: "", address })),
    cc: cc.map((address) => ({ name: "", address })),
    bcc: bcc.map((address) => ({ name: "", address })),
    messageId,
    inReplyTo: message.headers?.["In-Reply-To"],
    references: message.headers?.References,
    subject: message.subject,
    date: new Date().toISOString(),
    text: message.text,
    html: message.html,
    attachments: (message.attachments ?? []).map((a) => ({
      filename: a.filename,
      mimeType: a.type,
      content: (a.content as Uint8Array).toBase64(),
    })),
  };
  await env.MAIL.put(mailKey(inbox.id, id, "out"), JSON.stringify(email));
  await env.DB.prepare(
    "INSERT INTO messages (id, inbox_id, direction, from_addr, from_name, recipients, subject, read, created_at) VALUES (?, ?, 'out', ?, ?, ?, ?, 1, ?)",
  )
    .bind(
      id,
      inbox.id,
      inbox.address,
      inbox.name ?? "",
      [...to, ...cc, ...bcc].join(",").toLowerCase(),
      message.subject,
      Date.now(),
    )
    .run();
  return id;
}

// Flattens address groups into their members, as { name, address }.
function contacts(list: Address[] = []): { name: string; address: string }[] {
  return list.flatMap((a) => (a.group ? a.group : [a])).map((a) => ({ name: a.name, address: a.address ?? "" }));
}

export function addresses(list: Address[] = []): string[] {
  return contacts(list).map((c) => c.address);
}

export function summarize(id: string, email: Email) {
  return {
    id,
    message_id: email.messageId ?? null,
    in_reply_to: email.inReplyTo ?? null,
    references: email.references?.split(/\s+/).filter(Boolean) ?? [],
    from: email.from ? contacts([email.from])[0] : null,
    reply_to: contacts(email.replyTo),
    to: contacts(email.to),
    cc: contacts(email.cc),
    bcc: contacts(email.bcc),
    subject: email.subject ?? "",
    date: email.date ?? null,
    text: email.text ?? "",
    html: email.html ?? null,
    attachments: email.attachments.map((a, index) => ({
      index,
      filename: a.filename,
      type: a.mimeType,
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
    })),
    headers: (email.headers ?? []).map(({ key, value }) => ({ key, value })),
  };
}

// Permanently deletes the messages matching `where` (a fixed SQL fragment), from R2 and D1,
// in batches. Used only by purge; normal deletes are soft.
export async function purgeMessages(env: Env, where: string, ...params: unknown[]): Promise<number> {
  let purged = 0;
  while (true) {
    const { results } = await env.DB.prepare(`SELECT id, inbox_id, direction FROM messages WHERE ${where} LIMIT 100`)
      .bind(...params)
      .all<{ id: string; inbox_id: string; direction: Direction }>();
    if (results.length === 0) return purged;
    await env.MAIL.delete(results.map((m) => mailKey(m.inbox_id, m.id, m.direction)));
    await env.DB.batch(results.map((m) => env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id)));
    purged += results.length;
  }
}

// Deletes every stored file of an inbox, whatever its messages say.
export async function purgeInboxFiles(env: Env, inboxId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.MAIL.list({ prefix: `${inboxId}/`, cursor });
    if (listed.objects.length > 0) await env.MAIL.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
