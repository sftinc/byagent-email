const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 32;

import { parseName } from "./validate";

type Result = { ok: true; message: EmailMessageBuilder } | { ok: false; status: 400 | 413; error: string };

function list(value: unknown): any[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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

export function addressOf(recipient: string | EmailAddress): string {
  return typeof recipient === "string" ? recipient : recipient.email;
}

// Validates an agent's POST /send body and turns it into an Email Service message from `from`.
export function buildEmail(body: any, from: string | EmailAddress): Result {
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
  if (typeof body.text !== "string" && typeof body.html !== "string") {
    return { ok: false, status: 400, error: "`text` or `html` is required" };
  }

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
  const size =
    encoder.encode(body.text ?? "").length +
    encoder.encode(body.html ?? "").length +
    files.reduce((sum, f) => sum + f.length, 0);
  if (size > MAX_BYTES) return { ok: false, status: 413, error: "Message is larger than 5 MiB" };

  const message: EmailMessageBuilder = { from, to, subject: body.subject };
  if (cc.length) message.cc = cc;
  if (bcc.length) message.bcc = bcc;
  if (typeof body.text === "string") message.text = body.text;
  if (typeof body.html === "string") message.html = body.html;
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
