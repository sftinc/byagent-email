import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY, api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

describe("admin", () => {
  it("rejects a missing or wrong admin key", async () => {
    expect((await api("/admin/inboxes")).status).toBe(401);
    expect((await api("/admin/inboxes", { key: "wrong" })).status).toBe(401);
  });

  it("creates an inbox and returns its key once", async () => {
    const res = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { address: "Claude@Email.Example.com" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { address: string; api_key: string; webhook_secret: string };
    expect(body.address).toBe("claude@email.example.com");
    expect(body.api_key).toMatch(/^[0-9a-f]{64}$/);
    expect(body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);

    const list = await api("/admin/inboxes", { key: ADMIN_KEY });
    const { inboxes } = (await list.json()) as { inboxes: { address: string }[] };
    expect(inboxes.map((i) => i.address)).toEqual(["claude@email.example.com"]);
  });

  it("validates the address and refuses duplicates", async () => {
    for (const address of ["claude", "no spaces@example.com", "claude@", "claude@nodot"]) {
      const bad = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { address } });
      expect(bad.status).toBe(400);
    }
    await createInbox("claude");
    const dup = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { address: "claude@email.example.com" } });
    expect(dup.status).toBe(409);
  });

  it("creates inboxes on any domain", async () => {
    const res = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { address: "bot@mail.other.org" } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { address: string }).address).toBe("bot@mail.other.org");
  });

  it("refuses a domain that isn't set up for Cloudflare Email Routing", async () => {
    const res = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { address: "bot@nomx.example.org" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "nomx.example.org has no Cloudflare Email Routing MX records" });
  });

  it("rotates a key so the old one stops working", async () => {
    const inbox = await createInbox("agent");
    const res = await api(`/admin/inboxes/${inbox.address}/rotate-key`, { method: "POST", key: ADMIN_KEY });
    const { api_key } = (await res.json()) as { api_key: string };
    expect((await api("/messages", { key: inbox.api_key })).status).toBe(401);
    expect((await api("/messages", { key: api_key })).status).toBe(200);
  });

  it("deletes an inbox with its webhooks, messages and stored mail", async () => {
    const inbox = await createInbox("agent");
    await env.DB.prepare("INSERT INTO webhooks (id, inbox, url) VALUES ('w1', ?, 'https://example.com/hook')")
      .bind(inbox.address)
      .run();
    await receive(eml(), inbox.address, { WEBHOOKS: { sendBatch: async () => {} } as any });

    const res = await api(`/admin/inboxes/${inbox.address}`, { method: "DELETE", key: ADMIN_KEY });
    expect(res.status).toBe(200);
    for (const table of ["inboxes", "webhooks", "messages"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
    expect((await env.MAIL.list({ prefix: `${inbox.address}/` })).objects).toHaveLength(0);
    expect((await api(`/admin/inboxes/${inbox.address}`, { method: "DELETE", key: ADMIN_KEY })).status).toBe(404);
  });
});
