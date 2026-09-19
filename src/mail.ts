import PostalMime, { type Address, type Email } from "postal-mime";
import { uuidv7 } from "./crypto";
import type { Env } from "./env";

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
export async function saveSent(env: Env, inboxId: string, address: string, message: EmailMessageBuilder): Promise<string> {
  const id = uuidv7();
  const [to, cc, bcc] = [message.to, message.cc, message.bcc].map((list) => (list ?? []) as string[]);
  const email = {
    from: { name: "", address },
    to: to.map((address) => ({ name: "", address })),
    cc: cc.map((address) => ({ name: "", address })),
    bcc: bcc.map((address) => ({ name: "", address })),
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
  await env.MAIL.put(mailKey(inboxId, id, "out"), JSON.stringify(email));
  await env.DB.prepare(
    "INSERT INTO messages (id, inbox_id, from_addr, subject, received_at, read, direction, recipients) VALUES (?, ?, ?, ?, ?, 1, 'out', ?)",
  )
    .bind(id, inboxId, address, message.subject, Date.now(), [...to, ...cc, ...bcc].join(",").toLowerCase())
    .run();
  return id;
}

export function addresses(list: Address[] = []): string[] {
  return list.flatMap((a) => (a.address ? [a.address] : (a.group ?? []).map((m) => m.address)));
}

export function summarize(id: string, email: Email) {
  return {
    id,
    from: email.from?.address ?? "",
    to: addresses(email.to),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
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
  };
}

// Deletes every message matching `where` (a fixed SQL fragment), from R2 and D1, in batches.
export async function purgeMessages(env: Env, where: string, ...params: unknown[]): Promise<void> {
  while (true) {
    const { results } = await env.DB.prepare(`SELECT id, inbox_id, direction FROM messages WHERE ${where} LIMIT 100`)
      .bind(...params)
      .all<{ id: string; inbox_id: string; direction: Direction }>();
    if (results.length === 0) return;
    await env.MAIL.delete(results.map((m) => mailKey(m.inbox_id, m.id, m.direction)));
    await env.DB.batch(results.map((m) => env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id)));
  }
}
