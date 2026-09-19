const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 32;

type Result = { ok: true; message: EmailMessageBuilder } | { ok: false; status: 400 | 413; error: string };

function list(value: unknown): any[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isStringList(value: unknown[]): value is string[] {
  return value.every((v) => typeof v === "string" && v.length > 0);
}

// Validates an agent's POST /send body and turns it into an Email Service message from `from`.
export function buildEmail(body: any, from: string): Result {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "Body must be a JSON object" };

  const to = list(body.to);
  const cc = list(body.cc);
  const bcc = list(body.bcc);
  if (to.length === 0) return { ok: false, status: 400, error: "`to` is required" };
  if (![to, cc, bcc].every(isStringList)) return { ok: false, status: 400, error: "Recipients must be email strings" };
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

  const size =
    (body.text?.length ?? 0) +
    (body.html?.length ?? 0) +
    attachments.reduce((sum, a) => sum + Math.floor((a.content.length * 3) / 4), 0);
  if (size > MAX_BYTES) return { ok: false, status: 413, error: "Message is larger than 5 MiB" };

  const message: EmailMessageBuilder = { from, to, subject: body.subject };
  if (cc.length) message.cc = cc;
  if (bcc.length) message.bcc = bcc;
  if (typeof body.text === "string") message.text = body.text;
  if (typeof body.html === "string") message.html = body.html;
  // The send binding treats a string `content` as literal text, so decode base64 to bytes.
  try {
    if (attachments.length) {
      message.attachments = attachments.map((a) => ({
        filename: a.filename,
        type: a.type,
        content: Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0)),
        disposition: "attachment",
      }));
    }
  } catch {
    return { ok: false, status: 400, error: "Attachment `content` must be valid base64" };
  }
  return { ok: true, message };
}
