import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

describe("incoming mail", () => {
  it("rejects mail for an unknown address and stores a rejected row", async () => {
    const message = await receive(eml({ subject: "Spam" }), "nobody@email.example.com");
    expect(message.setReject).toHaveBeenCalledWith("Unknown recipient");

    const row = await env.DB.prepare("SELECT * FROM messages").first<Record<string, unknown>>();
    expect(row).toMatchObject({
      inbox_id: null,
      direction: "in",
      status: "rejected",
      status_reason: "unknown_recipient",
      from_addr: "sender@example.org",
      recipients: "nobody@email.example.com",
      subject: "Spam",
      attachments: "[]",
    });
    expect((await env.MAIL.list()).objects).toEqual([]);
  });

  it("stores the parsed message, its attachments and a row", async () => {
    await createInbox("agent");
    const raw = eml({ subject: "Report", attachment: { filename: "notes.txt", content: "file body" } });
    const message = await receive(raw, "Agent@Email.Example.com");
    expect(message.setReject).not.toHaveBeenCalled();

    const { id: inboxId } = (await env.DB.prepare("SELECT id FROM inboxes").first<{ id: string }>())!;
    const row = await env.DB.prepare("SELECT * FROM messages").first<Record<string, unknown>>();
    expect(row).toMatchObject({
      inbox_id: inboxId,
      from_addr: "sender@example.org",
      from_name: "Sender",
      subject: "Report",
      read_at: null,
      attachments: JSON.stringify([{ filename: "notes.txt", type: "text/plain", size: 10, disposition: "attachment" }]),
    });

    const stored = await (await env.MAIL.get(`${inboxId}/${row!.id}/message.json`))!.json<any>();
    expect(stored).toMatchObject({ subject: "Report", text: "Hi there\n", from: { name: "Sender", address: "sender@example.org" } });
    expect(await (await env.MAIL.get(`${inboxId}/${row!.id}/0`))!.text()).toBe("file body\n");
  });

  it("queues one job per webhook", async () => {
    const inbox = await createInbox("agent");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret, created_at) SELECT 'w1', id, 'https://a.example/hook', 's', 0 FROM inboxes"),
      env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret, created_at) SELECT 'w2', id, 'https://b.example/hook', 's', 0 FROM inboxes"),
    ]);
    const sendBatch = vi.fn();
    await receive(eml(), inbox.address, { WEBHOOKS: { sendBatch } as any });

    const row = await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>();
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { webhookId: "w1", messageId: row!.id } },
      { body: { webhookId: "w2", messageId: row!.id } },
    ]);
  });

  it("stores received mail with a received status", async () => {
    await createInbox("agent");
    await receive(eml(), "agent@email.example.com");
    const row = await env.DB.prepare("SELECT status, status_reason FROM messages").first();
    expect(row).toEqual({ status: "received", status_reason: null });
  });

  const bounceStatus = () =>
    env.DB.prepare("SELECT status, status_reason FROM messages").first<{ status: string; status_reason: string | null }>();

  it("flags a bounce with a null return path", async () => {
    await createInbox("agent");
    await receive(eml({ headers: "Return-Path: <>\r\n" }), "agent@email.example.com");
    expect(await bounceStatus()).toEqual({ status: "bounced", status_reason: "null-return-path" });
  });

  it("flags a bounce sent as a delivery status report", async () => {
    await createInbox("agent");
    const raw =
      "From: Mail Delivery System <noreply@example.org>\r\n" +
      "To: agent@email.example.com\r\n" +
      "Subject: Undelivered Mail Returned to Sender\r\n" +
      "Date: Sat, 19 Sep 2026 10:00:00 +0000\r\n" +
      "MIME-Version: 1.0\r\n" +
      'Content-Type: multipart/report; report-type=delivery-status; boundary=B\r\n\r\n' +
      "--B\r\nContent-Type: text/plain\r\n\r\nDelivery failed\r\n" +
      "--B--\r\n";
    await receive(raw, "agent@email.example.com");
    expect(await bounceStatus()).toEqual({ status: "bounced", status_reason: "multipart/report" });
  });

  it("flags a bounce from the mailer daemon", async () => {
    await createInbox("agent");
    await receive(eml({ from: "MAILER-DAEMON@example.org" }), "agent@email.example.com");
    expect(await bounceStatus()).toEqual({ status: "bounced", status_reason: "mailer-daemon" });
  });

  it("does not flag ordinary mail as a bounce", async () => {
    await createInbox("agent");
    await receive(eml(), "agent@email.example.com");
    expect(await bounceStatus()).toEqual({ status: "received", status_reason: null });
  });

  it("does not flag an auto-reply with a null return path as a bounce", async () => {
    await createInbox("agent");
    await receive(eml({ headers: "Return-Path: <>\r\nAuto-Submitted: auto-replied\r\n" }), "agent@email.example.com");
    expect(await bounceStatus()).toEqual({ status: "received", status_reason: null });
  });

  it("still flags a DSN carrying Auto-Submitted: auto-generated as a bounce", async () => {
    await createInbox("agent");
    await receive(eml({ headers: "Return-Path: <>\r\nAuto-Submitted: auto-generated\r\n" }), "agent@email.example.com");
    expect(await bounceStatus()).toEqual({ status: "bounced", status_reason: "null-return-path" });
  });
});
