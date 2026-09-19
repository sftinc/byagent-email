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

    const a = (await (await api("/webhooks", { method: "POST", key, body: { url: "https://a.example/hook" } })).json()) as any;
    const b = (await (await api("/webhooks", { method: "POST", key, body: { url: "https://b.example/hook" } })).json()) as any;
    const list = (await (await api("/webhooks", { key })).json()) as { webhooks: any[] };
    expect(list.webhooks).toHaveLength(2);

    expect((await api(`/webhooks/${a.id}`, { method: "DELETE", key })).status).toBe(200);
    expect((await api(`/webhooks/${a.id}`, { method: "DELETE", key })).status).toBe(404);
    const after = (await (await api("/webhooks", { key })).json()) as { webhooks: any[] };
    expect(after.webhooks).toEqual([{ id: b.id, url: "https://b.example/hook" }]);
  });
});

describe("webhook delivery", () => {
  async function setup() {
    const inbox = await createInbox("agent");
    const hook = (await (await api("/webhooks", { method: "POST", key: inbox.api_key, body: { url: "https://agent.example/hook" } })).json()) as { id: string };
    await receive(eml({ subject: "Ping" }), inbox.address, { WEBHOOKS: { sendBatch: vi.fn() } as any });
    const row = await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>();
    const batch = createMessageBatch("byagent-email-webhooks", [
      { id: "job-1", timestamp: Date.now(), attempts: 1, body: { webhookId: hook.id, inbox: inbox.address, messageId: row!.id } },
    ]);
    return { inbox, messageId: row!.id, batch };
  }

  it("posts a signed summary and acks on 2xx", async () => {
    const { inbox, messageId, batch } = await setup();
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createExecutionContext();
    await handleQueue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["job-1"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://agent.example/hook");
    const headers = init.headers as Record<string, string>;
    const expected = await hmacSha256(inbox.webhook_secret, `${headers["X-Timestamp"]}.${init.body}`);
    expect(headers["X-Signature"]).toBe(`sha256=${expected}`);
    expect(JSON.parse(init.body as string)).toEqual({
      inbox: inbox.address,
      message: {
        id: messageId,
        from: "sender@example.org",
        to: ["agent@email.example.com"],
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

  it("acks and skips when the webhook was removed", async () => {
    const { inbox, batch } = await setup();
    await env.DB.prepare("DELETE FROM webhooks WHERE inbox = ?").bind(inbox.address).run();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createExecutionContext();
    await handleQueue(batch, env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["job-1"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
