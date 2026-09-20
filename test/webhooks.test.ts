import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256 } from "../src/crypto";
import { handleQueue } from "../src/webhooks";
import { api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);
afterEach(() => vi.unstubAllGlobals());

describe("webhook endpoints", () => {
  it("adds, lists and removes webhooks", async () => {
    const { api_key: key } = await createInbox("agent");
    expect((await api("/webhooks", { method: "POST", key, body: { url: "http://insecure.example" } })).status).toBe(400);

    const a = (await (await api("/webhooks", { method: "POST", key, body: { url: "https://a.example/hook", name: " Ops alerts " } })).json()) as any;
    const b = (await (await api("/webhooks", { method: "POST", key, body: { url: "https://b.example/hook" } })).json()) as any;
    expect(a).toEqual({
      id: expect.any(String),
      name: "Ops alerts",
      url: "https://a.example/hook",
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(b.name).toBeNull();
    expect(b.secret).not.toBe(a.secret);
    expect((await api("/webhooks", { method: "POST", key, body: { url: "https://c.example/hook", name: "x".repeat(101) } })).status).toBe(400);
    const list = (await (await api("/webhooks", { key })).json()) as { webhooks: any[] };
    expect(list.webhooks).toHaveLength(2);

    expect((await api(`/webhooks/${a.id}`, { method: "DELETE", key })).status).toBe(200);
    expect((await api(`/webhooks/${a.id}`, { method: "DELETE", key })).status).toBe(404);
    const after = (await (await api("/webhooks", { key })).json()) as { webhooks: any[] };
    expect(after.webhooks).toEqual([{ id: b.id, name: null, url: "https://b.example/hook" }]);
    const deleted = (await (await api("/webhooks?deleted=true", { key })).json()) as { webhooks: any[] };
    expect(deleted.webhooks).toEqual([
      { id: a.id, name: "Ops alerts", url: "https://a.example/hook", deleted_at: expect.any(Number) },
    ]);
  });

  it("restores a deleted webhook, unless the inbox is already at 10", async () => {
    const { api_key: key } = await createInbox("agent");
    const hook = (await (await api("/webhooks", { method: "POST", key, body: { url: "https://a.example/hook" } })).json()) as { id: string };
    await api(`/webhooks/${hook.id}`, { method: "DELETE", key });

    expect((await api(`/webhooks/${hook.id}/restore`, { method: "POST", key })).status).toBe(200);
    const list = (await (await api("/webhooks", { key })).json()) as { webhooks: { id: string }[] };
    expect(list.webhooks.map((w) => w.id)).toEqual([hook.id]);
    expect((await api(`/webhooks/${hook.id}/restore`, { method: "POST", key })).status).toBe(404);

    await api(`/webhooks/${hook.id}`, { method: "DELETE", key });
    for (let i = 0; i < 10; i++) await api("/webhooks", { method: "POST", key, body: { url: `https://b${i}.example/hook` } });
    const full = await api(`/webhooks/${hook.id}/restore`, { method: "POST", key });
    expect(full.status).toBe(400);
    expect(await full.json()).toEqual({ error: "At most 10 webhooks per inbox" });
  });

  it("takes a supplied secret, and signs deliveries with it", async () => {
    const inbox = await createInbox("agent");
    const secret = "whsec_a-secret-the-receiver-already-knows";
    const hook = (await (await api("/webhooks", { method: "POST", key: inbox.api_key, body: { url: "https://a.example/hook", secret: ` ${secret} ` } })).json()) as any;
    expect(hook.secret).toBe(secret);

    await receive(eml({ subject: "Ping" }), inbox.address, { WEBHOOKS: { sendBatch: vi.fn() } as any });
    const row = await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>();
    const batch = createMessageBatch("agent-inbox-webhooks", [
      { id: "job-1", timestamp: Date.now(), attempts: 1, body: { webhookId: hook.id, messageId: row!.id } },
    ]);
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await handleQueue(batch, env);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Signature"]).toBe(`sha256=${await hmacSha256(secret, `${headers["X-Timestamp"]}.${init.body}`)}`);
  });

  it("refuses a secret that is too short, too long, or not text", async () => {
    const { api_key: key } = await createInbox("agent");
    const bad = ["short", "x".repeat(201), "has\nbreak", 12345];
    for (const secret of bad) {
      const res = await api("/webhooks", { method: "POST", key, body: { url: "https://a.example/hook", secret } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.stringContaining("`secret`") });
    }
  });

  it("caps webhooks at 10 per inbox", async () => {
    const { api_key: key } = await createInbox("agent");
    for (let i = 0; i < 10; i++) {
      const res = await api("/webhooks", { method: "POST", key, body: { url: `https://a${i}.example/hook` } });
      expect(res.status).toBe(201);
    }
    const res = await api("/webhooks", { method: "POST", key, body: { url: "https://eleven.example/hook" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "At most 10 webhooks per inbox" });

    // Deleted webhooks don't count toward the cap.
    const { webhooks } = (await (await api("/webhooks", { key })).json()) as { webhooks: { id: string }[] };
    await api(`/webhooks/${webhooks[0].id}`, { method: "DELETE", key });
    expect((await api("/webhooks", { method: "POST", key, body: { url: "https://eleven.example/hook" } })).status).toBe(201);
  });
});

describe("webhook delivery", () => {
  async function setup() {
    const inbox = await createInbox("agent");
    const hook = (await (await api("/webhooks", { method: "POST", key: inbox.api_key, body: { url: "https://agent.example/hook" } })).json()) as { id: string; secret: string };
    await receive(eml({ subject: "Ping" }), inbox.address, { WEBHOOKS: { sendBatch: vi.fn() } as any });
    const row = await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>();
    const batch = createMessageBatch("agent-inbox-webhooks", [
      { id: "job-1", timestamp: Date.now(), attempts: 1, body: { webhookId: hook.id, messageId: row!.id } },
    ]);
    return { inbox, hook, messageId: row!.id, batch };
  }

  it("posts a signed summary and acks on 2xx", async () => {
    const { inbox, hook, messageId, batch } = await setup();
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createExecutionContext();
    await handleQueue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["job-1"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://agent.example/hook");
    const headers = init.headers as Record<string, string>;
    const expected = await hmacSha256(hook.secret, `${headers["X-Timestamp"]}.${init.body}`);
    expect(headers["X-Signature"]).toBe(`sha256=${expected}`);
    expect(JSON.parse(init.body as string)).toEqual({
      inbox: inbox.address,
      message: {
        id: messageId,
        message_id: null,
        in_reply_to: null,
        references: [],
        from: { name: "Sender", address: "sender@example.org" },
        reply_to: [],
        to: [{ name: "", address: "agent@email.example.com" }],
        subject: "Ping",
        date: expect.any(String),
        text: "Hi there\n",
        attachments: [],
      },
    });
  });

  it("retries with backoff on a failed delivery", async () => {
    const { batch } = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const ctx = createExecutionContext();
    await handleQueue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toMatchObject([{ msgId: "job-1" }]);
  });

  it.each(["webhook", "message"])("acks and skips when the %s was deleted", async (what) => {
    const { inbox, hook, messageId, batch } = await setup();
    const path = what === "webhook" ? `/webhooks/${hook.id}` : `/messages/${messageId}`;
    expect((await api(path, { method: "DELETE", key: inbox.api_key })).status).toBe(200);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createExecutionContext();
    await handleQueue(batch, env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["job-1"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
