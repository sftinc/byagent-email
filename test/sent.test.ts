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
        from: inbox.address,
        to: ["a@x.com", "b@x.com", "c@x.com"],
        subject: "Report",
        received_at: expect.any(Number),
        read: true,
      },
    ]);
  });

  it("returns the full sent message and its attachment", async () => {
    const inbox = await createInbox("agent");
    const { id } = await sendOne(inbox.api_key);

    const res = await api(`/messages/${id}`, { key: inbox.api_key });
    expect(await res.json()).toEqual({
      id,
      from: inbox.address,
      to: ["a@x.com"],
      cc: ["b@x.com"],
      bcc: ["c@x.com"],
      subject: "Report",
      date: expect.any(String),
      text: "See attached",
      html: null,
      attachments: [{ index: 0, filename: "a.txt", type: "text/plain", size: 2 }],
      read: true,
    });

    const file = await api(`/messages/${id}/attachments/0`, { key: inbox.api_key });
    expect(await file.text()).toBe("hi");
  });

  it("lists both directions with direction=all and filters by recipient", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ to: "agent@email.example.com" }), inbox.address);
    await sendOne(inbox.api_key);

    const all = await list(inbox.api_key, "?direction=all");
    expect(all.map((m) => m.direction).sort()).toEqual(["in", "out"]);
    expect((await list(inbox.api_key, "?direction=all&to=C@X.COM")).map((m) => m.direction)).toEqual(["out"]);
    expect((await list(inbox.api_key, "?to=agent@")).map((m) => m.to)).toEqual([["agent@email.example.com"]]);
    expect((await api("/messages?direction=sent", { key: inbox.api_key })).status).toBe(400);
  });

  it("deletes a sent message from D1 and R2", async () => {
    const inbox = await createInbox("agent");
    const { id } = await sendOne(inbox.api_key);
    expect((await api(`/messages/${id}`, { method: "DELETE", key: inbox.api_key })).status).toBe(200);
    expect(await list(inbox.api_key, "?direction=all")).toEqual([]);
    expect((await env.MAIL.list()).objects).toHaveLength(0);
  });

  it("stores nothing when the send fails", async () => {
    const inbox = await createInbox("agent");
    const send = vi.fn(async () => {
      throw new Error("down");
    });
    const body = { to: "a@x.com", subject: "Hi", text: "x" };
    expect((await api("/send", { method: "POST", key: inbox.api_key, body }, { EMAIL: { send } as any })).status).toBe(502);
    expect(await list(inbox.api_key, "?direction=all")).toEqual([]);
  });
});
