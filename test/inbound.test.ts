import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

describe("incoming mail", () => {
  it("rejects mail for an unknown address", async () => {
    const message = await receive(eml(), "nobody@email.example.com");
    expect(message.setReject).toHaveBeenCalledWith("Unknown recipient");
  });

  it("stores the raw email and a message row", async () => {
    const inbox = await createInbox("agent");
    const raw = eml({ subject: "Report" });
    const message = await receive(raw, "Agent@Email.Example.com");
    expect(message.setReject).not.toHaveBeenCalled();

    const row = await env.DB.prepare("SELECT * FROM messages").first<Record<string, unknown>>();
    expect(row).toMatchObject({ inbox: inbox.address, from_addr: "sender@example.org", subject: "Report", read: 0 });
    const stored = await env.MAIL.get(`${inbox.address}/${row!.id}.eml`);
    expect(await stored!.text()).toBe(raw);
  });

  it("queues one job per webhook", async () => {
    const inbox = await createInbox("agent");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO webhooks (id, inbox, url) VALUES ('w1', ?, 'https://a.example/hook')").bind(inbox.address),
      env.DB.prepare("INSERT INTO webhooks (id, inbox, url) VALUES ('w2', ?, 'https://b.example/hook')").bind(inbox.address),
    ]);
    const sendBatch = vi.fn();
    await receive(eml(), inbox.address, { WEBHOOKS: { sendBatch } as any });

    const row = await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>();
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { webhookId: "w1", inbox: inbox.address, messageId: row!.id } },
      { body: { webhookId: "w2", inbox: inbox.address, messageId: row!.id } },
    ]);
  });
});
