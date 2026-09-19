import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY, api, createInbox, reset } from "./helpers";

beforeEach(reset);

describe("admin", () => {
  it("rejects a missing or wrong admin key", async () => {
    expect((await api("/admin/inboxes")).status).toBe(401);
    expect((await api("/admin/inboxes", { key: "wrong" })).status).toBe(401);
  });

  it("creates an inbox and returns its key once", async () => {
    const res = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { name: "Claude" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { address: string; api_key: string; webhook_secret: string };
    expect(body.address).toBe("claude@email.example.com");
    expect(body.api_key).toMatch(/^[0-9a-f]{64}$/);
    expect(body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);

    const list = await api("/admin/inboxes", { key: ADMIN_KEY });
    const { inboxes } = (await list.json()) as { inboxes: { address: string }[] };
    expect(inboxes.map((i) => i.address)).toEqual(["claude@email.example.com"]);
  });

  it("validates the name and refuses duplicates", async () => {
    const bad = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { name: "no spaces" } });
    expect(bad.status).toBe(400);
    await createInbox("claude");
    const dup = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { name: "claude" } });
    expect(dup.status).toBe(409);
  });

  it("rotates a key so the old one stops working", async () => {
    const inbox = await createInbox("agent");
    const res = await api(`/admin/inboxes/${inbox.address}/rotate-key`, { method: "POST", key: ADMIN_KEY });
    const { api_key } = (await res.json()) as { api_key: string };
    expect((await api("/messages", { key: inbox.api_key })).status).toBe(401);
    expect((await api("/messages", { key: api_key })).status).toBe(200);
  });
});
