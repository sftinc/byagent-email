const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 32;

import type { Env, Inbox, Result } from "./env";
import { type Contact, loadMessage, saveSent, type StoredMessage } from "./mail";
import { findMessage } from "./messages";
import { parseName } from "./validate";
import { NodeHtmlMarkdown } from "node-html-markdown";

type BuildEmailResult = { ok: true; message: EmailMessageBuilder } | { ok: false; status: 400 | 413; error: string };

function list(value: unknown): any[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// A text or html part counts only when it has something besides whitespace.
export function filled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// Plain text as html that shows it as typed: escaped, with line breaks and tabs kept.
export function toHtml(text: string): string {
  return `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

// Html as Markdown, so links, lists and tables survive in the text part.
// Known issue: the parser's cost grows much faster than the input on unclosed tags (15 KB of
// `<b>x` repeated takes ~20 s of CPU), so replying to a hostile html-only message, or sending
// messy html with no text, can hit the Worker's CPU limit. Accepted for now; the fix would be a
// linear converter such as one built on HTMLRewriter.
export function toText(html: string): string {
  return NodeHtmlMarkdown.translate(html);
}

// A recipient is "bob@x.com" or {address, name?}. Returns what the send binding takes: a plain
// address, or {email, name} when it has a display name. null if any entry is malformed.
function recipients(values: unknown[]): (string | EmailAddress)[] | null {
  const out: (string | EmailAddress)[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      out.push(value);
      continue;
    }
    const { address, name } = (value ?? {}) as { address?: unknown; name?: unknown };
    const label = parseName(name);
    if (typeof address !== "string" || address.length === 0 || label === undefined) return null;
    out.push(label ? { email: address, name: label } : address);
  }
  return out;
}

// Validates an agent's POST /send body and turns it into an Email Service message from `from`.
export function buildEmail(body: any, from: string | EmailAddress): BuildEmailResult {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "Body must be a JSON object" };

  const [to, cc, bcc] = [body.to, body.cc, body.bcc].map((value) => recipients(list(value)));
  if (!to || !cc || !bcc) {
    return { ok: false, status: 400, error: "Recipients must be addresses or {address, name}" };
  }
  if (to.length === 0) return { ok: false, status: 400, error: "`to` is required" };
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    return { ok: false, status: 400, error: `At most ${MAX_RECIPIENTS} recipients` };
  }
  if (typeof body.subject !== "string" || body.subject === "") {
    return { ok: false, status: 400, error: "`subject` is required" };
  }
  if (!filled(body.text) && !filled(body.html)) {
    return { ok: false, status: 400, error: "`text` or `html` is required" };
  }
  // Every message carries both parts; whichever the agent left out is generated from the other.
  const text: string = filled(body.text) ? body.text : toText(body.html);
  const html: string = filled(body.html) ? body.html : toHtml(body.text);

  const attachments = list(body.attachments);
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 400, error: `At most ${MAX_ATTACHMENTS} attachments` };
  }
  for (const a of attachments) {
    if (typeof a?.filename !== "string" || typeof a?.type !== "string" || typeof a?.content !== "string") {
      return { ok: false, status: 400, error: "Attachments need `filename`, `type` and base64 `content`" };
    }
  }

  // The send binding treats a string `content` as literal text, so decode base64 to bytes.
  let files: Uint8Array[];
  try {
    files = attachments.map((a) => Uint8Array.fromBase64(a.content));
  } catch {
    return { ok: false, status: 400, error: "Attachment `content` must be valid base64" };
  }

  // Cloudflare's 5 MiB limit applies to the raw content (checked against production).
  const encoder = new TextEncoder();
  const size = encoder.encode(text).length + encoder.encode(html).length + files.reduce((sum, f) => sum + f.length, 0);
  if (size > MAX_BYTES) return { ok: false, status: 413, error: "Message is larger than 5 MiB" };

  const message: EmailMessageBuilder = { from, to, subject: body.subject, text, html };
  if (cc.length) message.cc = cc;
  if (bcc.length) message.bcc = bcc;
  if (attachments.length) {
    message.attachments = attachments.map((a, i) => ({
      filename: a.filename,
      type: a.type,
      content: files[i],
      disposition: "attachment",
    }));
  }
  return { ok: true, message };
}

// Validates and sends one message from `inbox`. `reply_to_id` names one of the inbox's messages
// to reply to in its thread. A provider refusal is a failure that still records a row, so the
// caller gets the row's id alongside the error.
export async function sendMail(env: Env, inbox: Inbox, body: any): Promise<Result<{ id: string; messageId: string }>> {
  const from = inbox.name ? { email: inbox.address, name: inbox.name } : inbox.address;
  const built = buildEmail(body, from);
  if (!built.ok) return { ok: false, status: built.status, error: built.error };

  if (body.reply_to_id !== undefined) {
    const replyTo = typeof body.reply_to_id === "string" ? body.reply_to_id : "";
    const row = replyTo ? await findMessage(env, inbox.id, replyTo) : null;
    const parent = row && (await loadMessage(env, inbox.id, replyTo));
    if (!parent?.message_id) return { ok: false, status: 400, error: "`reply_to_id` is not a message in this inbox" };
    const references = [...parent.references, parent.message_id];
    built.message.headers = { "In-Reply-To": parent.message_id, References: references.join(" ") };
  }
  let messageId: string;
  try {
    ({ messageId } = await env.EMAIL.send(built.message));
  } catch (err: any) {
    const code = err?.code ?? err?.message ?? "Send failed";
    const id = await saveSent(env, inbox, built.message, null, code);
    return { ok: false, status: 502, error: code, data: { id } };
  }
  const id = await saveSent(env, inbox, built.message, messageId);
  return { ok: true, data: { id, messageId } };
}

// Where a reply goes by default. Received mail: its Reply-To, else its sender; reply-all adds
// everyone it was sent to. Mail this inbox sent: its original recipients, never its bcc.
// Postal-mime can produce a contact with no address (e.g. "Cc: Bob"), which sendMail would refuse,
// so those are dropped here rather than inherited.
function defaults(direction: string, parent: StoredMessage, all: boolean): { to: Contact[]; cc: Contact[] } {
  const has = (c: Contact) => c.address !== "";
  if (direction === "out") return { to: parent.to.filter(has), cc: all ? parent.cc.filter(has) : [] };
  const replyTo = parent.reply_to.filter(has);
  const to = replyTo.length ? replyTo : parent.from && has(parent.from) ? [parent.from] : [];
  return { to, cc: all ? [...parent.to, ...parent.cc].filter(has) : [] };
}

// An inherited contact as a recipient. Received names are stored unchecked, so a name sendMail
// would refuse is dropped and the address kept.
function inherit(contact: Contact): string | { address: string; name: string } {
  const name = parseName(contact.name);
  return name ? { address: contact.address, name } : contact.address;
}

// Drops this inbox and repeated addresses (ignoring case, first one wins) across to, then cc.
// An entry with no string address is kept, for sendMail to refuse.
function cleanUp(inbox: Inbox, to: unknown[], cc: unknown[]): [unknown[], unknown[]] {
  const seen = new Set([inbox.address.toLowerCase()]);
  const keep = (r: unknown) => {
    const address = typeof r === "string" ? r : (r as { address?: unknown } | null)?.address;
    if (typeof address !== "string") return true;
    if (seen.has(address.toLowerCase())) return false;
    seen.add(address.toLowerCase());
    return true;
  };
  return [to.filter(keep), cc.filter(keep)];
}

// Postal-mime decodes an encoded-word subject as-is, so a header injected into it (e.g. \r\nBcc:)
// would land in the outgoing Subject verbatim. Collapse control characters first.
function replySubject(subject: string): string {
  const clean = subject.replace(/[\x00-\x1f\x7f]+/g, " ");
  return /^\s*re:/i.test(clean) ? clean : `Re: ${clean}`.trimEnd();
}

// "On <date>, <name> <address> wrote:", dated when the original was sent, else when it arrived.
function quoteHeader(parent: StoredMessage, createdAt: number): string {
  const date = new Date(parent.date ?? "");
  const when = (Number.isNaN(date.getTime()) ? new Date(createdAt) : date).toUTCString();
  const from = parent.from;
  const who = from ? (from.name ? `${from.name} <${from.address}>` : from.address) : "";
  return `On ${when}, ${who ? `${who} ` : ""}wrote:`;
}

// Replies to one of the inbox's messages: works out who it goes to, the subject and the quoted
// original, then hands everything to sendMail, which validates, threads, sends and saves it.
// A `to` or `cc` in the body replaces the default; a `subject` in the body is ignored.
export async function replyMail(env: Env, inbox: Inbox, id: string, body: any, all: boolean): Promise<Result<{ id: string; messageId: string }>> {
  if (!body || typeof body !== "object") return sendMail(env, inbox, body);
  const row = await findMessage(env, inbox.id, id);
  const parent = row && (await loadMessage(env, inbox.id, id));
  if (!row || !parent) return { ok: false, status: 404, error: "Message not found" };

  const fallback = defaults(row.direction, parent, all);
  const [to, cc] = cleanUp(
    inbox,
    body.to !== undefined ? list(body.to) : fallback.to.map(inherit),
    body.cc !== undefined ? list(body.cc) : fallback.cc.map(inherit),
  );

  // With nothing written, the original isn't appended, so sendMail answers "`text` or `html` is required".
  let { text, html } = body;
  if (filled(text) || filled(html)) {
    const header = quoteHeader(parent, row.created_at);
    const mine = { text: filled(text) ? text : toText(html), html: filled(html) ? html : toHtml(text) };
    const theirs = { text: filled(parent.text) ? parent.text : toText(parent.html ?? ""), html: filled(parent.html) ? parent.html : toHtml(parent.text) };
    text = `${mine.text}\n\n${header}\n\n${theirs.text}`;
    html = `${mine.html}<br><br><div>${escapeHtml(header)}</div><br>${theirs.html}`;
  }
  return sendMail(env, inbox, { ...body, to, cc, subject: replySubject(parent.subject), text, html, reply_to_id: id });
}
