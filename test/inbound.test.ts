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
    await createInbox("agent");
    const raw = eml({ subject: "Report" });
    const message = await receive(raw, "Agent@Email.Example.com");
    expect(message.setReject).not.toHaveBeenCalled();

    const { id: inboxId } = (await env.DB.prepare("SELECT id FROM inboxes").first<{ id: string }>())!;
    const row = await env.DB.prepare("SELECT * FROM messages").first<Record<string, unknown>>();
    expect(row).toMatchObject({ inbox_id: inboxId, from_addr: "sender@example.org", subject: "Report", read: 0 });
    const stored = await env.MAIL.get(`${inboxId}/${row!.id}.eml`);
    expect(await stored!.text()).toBe(raw);
  });

  it("queues one job per webhook", async () => {
    const inbox = await createInbox("agent");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret) SELECT 'w1', id, 'https://a.example/hook', 's' FROM inboxes"),
      env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret) SELECT 'w2', id, 'https://b.example/hook', 's' FROM inboxes"),
    ]);
    const sendBatch = vi.fn();
    await receive(eml(), inbox.address, { WEBHOOKS: { sendBatch } as any });

    const row = await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>();
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { webhookId: "w1", messageId: row!.id } },
      { body: { webhookId: "w2", messageId: row!.id } },
    ]);
  });
});
