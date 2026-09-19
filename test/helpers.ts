import { env } from "cloudflare:workers";
import { app } from "../src/api";
import type { Env } from "../src/env";

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

export async function createInbox(name = "agent") {
  const res = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { name } });
  return (await res.json()) as { address: string; api_key: string; webhook_secret: string };
}
