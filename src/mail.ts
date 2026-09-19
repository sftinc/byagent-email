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
