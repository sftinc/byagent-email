import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { app } from "../src/api";
import type { Env } from "../src/env";
import { handleEmail } from "../src/inbound";

export const ADMIN_KEY = "test-admin-key";

// Storage is shared between tests, so every test starts by emptying D1 and R2.
export async function reset(): Promise<void> {
  await env.DB.batch(["messages", "webhooks", "inboxes"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const { objects } = await env.MAIL.list();
  if (objects.length > 0) await env.MAIL.delete(objects.map((o) => o.key));
}

export function api(
  path: string,
  { method = "GET", key, body }: { method?: string; key?: string; body?: unknown } = {},
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return Promise.resolve(
    app.request(
      path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { ...env, ...overrides },
    ),
  );
}

// Creates <local>@email.example.com, with an optional display name.
export async function createInbox(local = "agent", name?: string) {
  const res = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { address: `${local}@email.example.com`, name } });
  return (await res.json()) as { id: string; address: string; name: string | null; api_key: string };
}

export function eml({
  from = "sender@example.org",
  to = "agent@email.example.com",
  subject = "Hello",
  text = "Hi there",
  headers = "",
  attachment,
}: {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  headers?: string; // extra header lines, each ending in \r\n
  attachment?: { filename: string; content: string };
} = {}): string {
  const head = `From: Sender <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Sat, 19 Sep 2026 10:00:00 +0000\r\n${headers}MIME-Version: 1.0\r\n`;
  if (!attachment) return `${head}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  return (
    `${head}Content-Type: multipart/mixed; boundary=BOUNDARY\r\n\r\n` +
    `--BOUNDARY\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n` +
    `--BOUNDARY\r\nContent-Type: text/plain; name="${attachment.filename}"\r\n` +
    `Content-Disposition: attachment; filename="${attachment.filename}"\r\n\r\n${attachment.content}\r\n` +
    `--BOUNDARY--\r\n`
  );
}

// Delivers a raw email to the `email` handler, the way Email Routing would.
export async function receive(raw: string, to = "agent@email.example.com", overrides: Partial<Env> = {}) {
  const headers = new Headers();
  const subject = raw.match(/^Subject: (.*?)\r?$/m)?.[1];
  if (subject) headers.set("subject", subject);

  const message = {
    from: "sender@example.org",
    to,
    raw: new Response(raw).body!,
    rawSize: raw.length,
    headers,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
    canBeForwarded: true,
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
  await handleEmail(message, { ...env, ...overrides });
  return message;
}
