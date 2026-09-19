import type { Address, Email } from "postal-mime";
import { uuidv7 } from "./crypto";
import type { Env, Inbox } from "./env";

// Every message is stored under its own prefix: `message.json` plus one file per attachment,
// named by its position. Mail is parsed once, when it arrives, and never re-parsed on read.
export function messageKey(inboxId: string, id: string, file: string): string {
  return `${inboxId}/${id}/${file}`;
}

export interface Contact {
  name: string;
  address: string;
}

export interface Attachment {
  filename: string;
  type: string;
  size: number;
  disposition: string;
  content_id?: string;
}

// What the API returns for a message, minus the fields that live in D1.
export interface StoredMessage {
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from: Contact | null;
  reply_to: Contact[];
  to: Contact[];
  cc: Contact[];
  bcc: Contact[];
  subject: string;
  date: string | null;
  text: string;
  html: string | null;
  attachments: Attachment[];
  headers: { key: string; value: string }[];
}

// Flattens address groups into their members.
function contacts(list: Address[] = []): Contact[] {
  return list.flatMap((a) => (a.group ? a.group : [a])).map((a) => ({ name: a.name, address: a.address ?? "" }));
}

export function addresses(list: Address[] = []): string[] {
  return contacts(list).map((c) => c.address);
}

// Turns a parsed email into what we store: the message, and the attachment bytes.
export function fromEmail(email: Email): { message: StoredMessage; files: Uint8Array[] } {
  const files = email.attachments.map((a) =>
    typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content),
  );
  return {
    message: {
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
      attachments: email.attachments.map((a, i) => ({
        filename: a.filename ?? "attachment",
        type: a.mimeType,
        size: files[i].length,
        disposition: a.disposition ?? "attachment",
        ...(a.contentId ? { content_id: a.contentId } : {}),
      })),
      headers: (email.headers ?? []).map(({ key, value }) => ({ key, value })),
    },
    files,
  };
}

export async function saveMessage(
  env: Env,
  inboxId: string,
  id: string,
  message: StoredMessage,
  files: Uint8Array[],
): Promise<void> {
  await Promise.all([
    env.MAIL.put(messageKey(inboxId, id, "message.json"), JSON.stringify(message)),
    ...files.map((bytes, i) => env.MAIL.put(messageKey(inboxId, id, String(i)), bytes)),
  ]);
}

export async function loadMessage(env: Env, inboxId: string, id: string): Promise<StoredMessage | null> {
  const object = await env.MAIL.get(messageKey(inboxId, id, "message.json"));
  return object ? object.json<StoredMessage>() : null;
}

export function loadAttachment(env: Env, inboxId: string, id: string, index: number): Promise<R2ObjectBody | null> {
  return env.MAIL.get(messageKey(inboxId, id, String(index)));
}

// Sent mail is stored the same way, built from what was sent rather than from a parsed email.
export async function saveSent(env: Env, inbox: Inbox, message: EmailMessageBuilder, messageId: string): Promise<string> {
  const id = uuidv7();
  const [to, cc, bcc] = [message.to, message.cc, message.bcc].map((list) => (list ?? []) as string[]);
  const named = (address: string): Contact => ({ name: "", address });
  const files = (message.attachments ?? []).map((a) => a.content as Uint8Array);
  const stored: StoredMessage = {
    message_id: messageId,
    in_reply_to: message.headers?.["In-Reply-To"] ?? null,
    references: message.headers?.References?.split(/\s+/).filter(Boolean) ?? [],
    from: { name: inbox.name ?? "", address: inbox.address },
    reply_to: [],
    to: to.map(named),
    cc: cc.map(named),
    bcc: bcc.map(named),
    subject: message.subject,
    date: new Date().toISOString(),
    text: message.text ?? "",
    html: message.html ?? null,
    attachments: (message.attachments ?? []).map((a, i) => ({
      filename: a.filename,
      type: a.type,
      size: files[i].length,
      disposition: "attachment",
    })),
    headers: [],
  };

  await saveMessage(env, inbox.id, id, stored, files);
  await env.DB.prepare(
    `INSERT INTO messages (id, inbox_id, direction, from_addr, from_name, recipients, subject, attachments, read, created_at)
     VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      id,
      inbox.id,
      inbox.address,
      inbox.name ?? "",
      [...to, ...cc, ...bcc].join(",").toLowerCase(),
      message.subject,
      JSON.stringify(stored.attachments),
      Date.now(),
    )
    .run();
  return id;
}

// Permanently deletes the messages matching `where` (a fixed SQL fragment), from R2 and D1,
// in batches. Used only by purge; normal deletes are soft.
export async function purgeMessages(env: Env, where: string, ...params: unknown[]): Promise<number> {
  let purged = 0;
  while (true) {
    const { results } = await env.DB.prepare(`SELECT id, inbox_id, attachments FROM messages WHERE ${where} LIMIT 100`)
      .bind(...params)
      .all<{ id: string; inbox_id: string; attachments: string }>();
    if (results.length === 0) return purged;
    const keys = results.flatMap((m) => {
      const files = (JSON.parse(m.attachments) as Attachment[]).map((_, i) => String(i));
      return ["message.json", ...files].map((file) => messageKey(m.inbox_id, m.id, file));
    });
    await env.MAIL.delete(keys);
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
