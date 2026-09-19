import PostalMime, { type Address, type Email } from "postal-mime";
import type { Env } from "./env";

export function rawKey(inbox: string, id: string): string {
  return `${inbox}/${id}.eml`;
}

export async function loadMessage(env: Env, inbox: string, id: string): Promise<Email | null> {
  const object = await env.MAIL.get(rawKey(inbox, id));
  return object ? PostalMime.parse(await object.arrayBuffer()) : null;
}

function addresses(list: Address[] = []): string[] {
  return list.flatMap((a) => (a.address ? [a.address] : (a.group ?? []).map((m) => m.address)));
}

export function summarize(id: string, email: Email) {
  return {
    id,
    from: email.from?.address ?? "",
    to: addresses(email.to),
    cc: addresses(email.cc),
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
    const { results } = await env.DB.prepare(`SELECT id, inbox FROM messages WHERE ${where} LIMIT 100`)
      .bind(...params)
      .all<{ id: string; inbox: string }>();
    if (results.length === 0) return;
    await env.MAIL.delete(results.map((m) => rawKey(m.inbox, m.id)));
    await env.DB.batch(results.map((m) => env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id)));
  }
}
