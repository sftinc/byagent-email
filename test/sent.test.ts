import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

const EMAIL = { send: vi.fn(async () => ({ messageId: "cf-123" })) } as any;

async function sendOne(key: string) {
  const body = {
    to: "a@x.com",
    cc: "b@x.com",
    bcc: ["c@x.com"],
    subject: "Report",
    text: "See attached",
    attachments: [{ filename: "a.txt", type: "text/plain", content: "aGk=" }],
  };
  const res = await api("/send", { method: "POST", key, body }, { EMAIL });
  return (await res.json()) as { id: string; messageId: string };
}

async function list(key: string, query = "") {
  return ((await (await api(`/messages${query}`, { key })).json()) as { messages: any[] }).messages;
}

describe("sent mail", () => {
  it("is stored and listed with direction=out, but not by default", async () => {
    const inbox = await createInbox("agent");
    const sent = await sendOne(inbox.api_key);
    expect(sent).toEqual({ id: expect.any(String), messageId: "cf-123" });

    expect(await list(inbox.api_key)).toEqual([]);
    expect(await list(inbox.api_key, "?direction=out")).toEqual([
      {
        id: sent.id,
        direction: "out",
        status: "sent",
        status_reason: null,
        from: { name: "", address: inbox.address },
        recipients: [
          { name: "", address: "a@x.com" },
          { name: "", address: "b@x.com" },
          { name: "", address: "c@x.com" },
        ],
        subject: "Report",
        attachments: [{ index: 0, filename: "a.txt", type: "text/plain", size: 2, disposition: "attachment" }],
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
        read_at: expect.any(Number),
        deleted_at: null,
      },
    ]);
  });

  it("returns the full sent message and its attachment", async () => {
    const inbox = await createInbox("agent");
    const { id } = await sendOne(inbox.api_key);

    const res = await api(`/messages/${id}`, { key: inbox.api_key });
    const full = (await res.json()) as any;
    expect(full).toEqual({
      id,
      direction: "out",
      status: "sent",
      status_reason: null,
      message_id: "cf-123",
      in_reply_to: null,
      references: [],
      from: { name: "", address: inbox.address },
      reply_to: [],
      to: [{ name: "", address: "a@x.com" }],
      cc: [{ name: "", address: "b@x.com" }],
      bcc: [{ name: "", address: "c@x.com" }],
      subject: "Report",
      date: expect.any(String),
      text: "See attached",
      html: null,
      attachments: [{ index: 0, filename: "a.txt", type: "text/plain", size: 2, disposition: "attachment", url: expect.any(String) }],
      headers: [],
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      read_at: expect.any(Number),
      deleted_at: null,
    });

    const file = await api(new URL(full.attachments[0].url).pathname);
    expect(await file.text()).toBe("hi");
  });

  it("keeps recipient names on the saved copy, and filters by address", async () => {
    const inbox = await createInbox("agent");
    const body = {
      to: [{ address: "Bob@x.com", name: "Bob Smith" }],
      cc: "plain@x.com",
      subject: "Named",
      text: "Hi",
    };
    const res = await api("/send", { method: "POST", key: inbox.api_key, body }, { EMAIL });
    const { id } = (await res.json()) as { id: string };

    const full = (await (await api(`/messages/${id}`, { key: inbox.api_key })).json()) as any;
    expect(full.to).toEqual([{ name: "Bob Smith", address: "Bob@x.com" }]);
    expect(full.cc).toEqual([{ name: "", address: "plain@x.com" }]);
    expect((await list(inbox.api_key, "?direction=out"))[0].recipients).toEqual([
      { name: "Bob Smith", address: "bob@x.com" },
      { name: "", address: "plain@x.com" },
    ]);
    expect((await list(inbox.api_key, "?direction=out&to=smith")).map((m: any) => m.id)).toEqual([id]);
  });

  it("lists both directions with direction=all and filters by recipient", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ to: "agent@email.example.com" }), inbox.address);
    await sendOne(inbox.api_key);

    const all = await list(inbox.api_key, "?direction=all");
    expect(all.map((m) => m.direction).sort()).toEqual(["in", "out"]);
    expect((await list(inbox.api_key, "?direction=all&to=C@X.COM")).map((m) => m.direction)).toEqual(["out"]);
    expect((await list(inbox.api_key, "?to=agent@")).map((m) => m.recipients)).toEqual([[{ name: "", address: "agent@email.example.com" }]]);
    expect((await api("/messages?direction=sent", { key: inbox.api_key })).status).toBe(400);
  });

  it("soft-deletes a sent message, keeping its files", async () => {
    const inbox = await createInbox("agent");
    const { id } = await sendOne(inbox.api_key);
    expect((await api(`/messages/${id}`, { method: "DELETE", key: inbox.api_key })).status).toBe(200);
    expect(await list(inbox.api_key, "?direction=all")).toEqual([]);
    expect((await env.MAIL.list()).objects).toHaveLength(2); // message.json and its attachment
  });

  it("stores a failed message, listed with direction=all, when the send fails", async () => {
    const inbox = await createInbox("agent");
    const send = vi.fn(async () => {
      throw new Error("down");
    });
    const body = { to: "a@x.com", subject: "Hi", text: "x" };
    expect((await api("/send", { method: "POST", key: inbox.api_key, body }, { EMAIL: { send } as any })).status).toBe(502);
    const all = await list(inbox.api_key, "?direction=all");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ direction: "out", status: "failed", status_reason: "down" });
  });

  it("stores sent mail with a sent status", async () => {
    const inbox = await createInbox("agent");
    const send = vi.fn().mockResolvedValue({ messageId: "<m1@email.example.com>" });
    await api("/send", { method: "POST", key: inbox.api_key, body: { to: "bob@example.org", subject: "Hi", text: "Hello" } }, { EMAIL: { send } as any });
    const row = await env.DB.prepare("SELECT status, status_reason FROM messages").first();
    expect(row).toEqual({ status: "sent", status_reason: null });
  });
});
