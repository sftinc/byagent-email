import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

async function setup() {
  const inbox = await createInbox("agent");
  await receive(eml({ subject: "First", attachment: { filename: "notes.txt", content: "file body" } }), inbox.address);
  const row = await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>();
  return { key: inbox.api_key, id: row!.id };
}

describe("messages", () => {
  it("requires an inbox key", async () => {
    expect((await api("/messages")).status).toBe(401);
    expect((await api("/messages", { key: "nope" })).status).toBe(401);
  });

  it("lists messages with an unread filter", async () => {
    const { key, id } = await setup();
    expect(await (await api("/messages", { key })).json()).toEqual({
      messages: [
        {
          id,
          direction: "in",
          from: { name: "Sender", address: "sender@example.org" },
          recipients: ["agent@email.example.com"],
          subject: "First",
          read: false,
          created_at: expect.any(Number),
        },
      ],
      paging: { before: null, after: null },
    });

    await api(`/messages/${id}/read`, { method: "POST", key });
    const unread = (await (await api("/messages?unread=true", { key })).json()) as { messages: any[] };
    expect(unread.messages).toEqual([]);
  });

  it("filters by part of the sender address, ignoring case", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ from: "bob@example.org" }), inbox.address);
    await receive(eml({ from: "alice@other.com" }), inbox.address);
    const from = async (q: string) =>
      ((await (await api(`/messages?from=${encodeURIComponent(q)}`, { key: inbox.api_key })).json()) as { messages: any[] })
        .messages.map((m) => m.from.address);

    expect(await from("BOB@example.org")).toEqual(["bob@example.org"]);
    expect(await from("@other.com")).toEqual(["alice@other.com"]);
    expect(await from("nobody")).toEqual([]);
  });

  it("filters by part of the subject, ignoring case", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ subject: "March invoice" }), inbox.address);
    await receive(eml({ subject: "Lunch plans" }), inbox.address);
    const subjects = async (q: string) =>
      ((await (await api(`/messages?subject=${encodeURIComponent(q)}`, { key: inbox.api_key })).json()) as { messages: any[] })
        .messages.map((m) => m.subject);

    expect(await subjects("INVOICE")).toEqual(["March invoice"]);
    expect(await subjects("nch")).toEqual(["Lunch plans"]);
    expect(await subjects("nothing")).toEqual([]);
  });

  it("pages 20 at a time, newest first, with cursors for both directions", async () => {
    const inbox = await createInbox("agent");
    for (let i = 0; i < 25; i++) await receive(eml({ subject: `M${i}` }), inbox.address);
    const { results } = await env.DB.prepare("SELECT id FROM messages ORDER BY id DESC").all<{ id: string }>();
    const n = results.map((r) => r.id); // newest first
    const list = async (query: string) => {
      const res = await api(`/messages${query}`, { key: inbox.api_key });
      const body = (await res.json()) as { messages: { id: string }[]; paging: unknown };
      return { ids: body.messages.map((m) => m.id), paging: body.paging };
    };

    expect(await list("")).toEqual({ ids: n.slice(0, 20), paging: { before: n[19], after: null } });
    expect(await list(`?before=${n[19]}`)).toEqual({ ids: n.slice(20), paging: { before: null, after: n[20] } });
    expect(await list(`?after=${n[20]}`)).toEqual({ ids: n.slice(0, 20), paging: { before: n[19], after: null } });
    expect(await list(`?after=${n[24]}`)).toEqual({ ids: n.slice(4, 24), paging: { before: n[23], after: n[4] } });
    // An empty page points back the way it came.
    expect(await list(`?before=${n[24]}`)).toEqual({ ids: [], paging: { before: null, after: n[24] } });
    // Paging follows the filters: there is no sent mail in either direction.
    expect(await list(`?direction=out&before=${n[10]}`)).toEqual({ ids: [], paging: { before: null, after: null } });
    expect((await api(`/messages?before=${n[0]}&after=${n[1]}`, { key: inbox.api_key })).status).toBe(400);
  });

  it("only shows an inbox its own messages", async () => {
    const { id } = await setup();
    const other = await createInbox("other");
    const list = (await (await api("/messages", { key: other.api_key })).json()) as { messages: any[] };
    expect(list.messages).toEqual([]);
    expect((await api(`/messages/${id}`, { key: other.api_key })).status).toBe(404);
  });

  it("returns the full parsed message", async () => {
    const { key, id } = await setup();
    const res = await api(`/messages/${id}`, { key });
    expect(await res.json()).toEqual({
      id,
      direction: "in",
      message_id: null,
      in_reply_to: null,
      references: [],
      from: { name: "Sender", address: "sender@example.org" },
      reply_to: [],
      to: [{ name: "", address: "agent@email.example.com" }],
      cc: [],
      bcc: [],
      subject: "First",
      date: expect.any(String),
      text: "Hi there\n",
      html: null,
      attachments: [{ index: 0, filename: "notes.txt", type: "text/plain", size: 10 }],
      headers: expect.arrayContaining([{ key: "subject", value: "First" }]),
      read: false,
      created_at: expect.any(Number),
    });
  });

  it("returns the headers needed to reply in a thread", async () => {
    const inbox = await createInbox("agent");
    const headers =
      "Message-ID: <b@x.com>\r\nIn-Reply-To: <a@x.com>\r\nReferences: <root@x.com> <a@x.com>\r\nReply-To: Team <team@x.com>\r\n";
    await receive(eml({ subject: "Re: Plan", headers }), inbox.address);
    const { messages } = (await (await api("/messages", { key: inbox.api_key })).json()) as { messages: { id: string }[] };
    const full = await (await api(`/messages/${messages[0].id}`, { key: inbox.api_key })).json();
    expect(full).toMatchObject({
      message_id: "<b@x.com>",
      in_reply_to: "<a@x.com>",
      references: ["<root@x.com>", "<a@x.com>"],
      reply_to: [{ name: "Team", address: "team@x.com" }],
    });
  });

  it("downloads an attachment", async () => {
    const { key, id } = await setup();
    const res = await api(`/messages/${id}/attachments/0`, { key });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`);
    expect(await res.text()).toBe("file body\n");
    expect((await api(`/messages/${id}/attachments/5`, { key })).status).toBe(404);
  });

  it("marks read and soft-deletes, keeping the stored mail", async () => {
    const { key, id } = await setup();
    expect((await api(`/messages/${id}/read`, { method: "POST", key })).status).toBe(200);
    expect(((await (await api(`/messages/${id}`, { key })).json()) as any).read).toBe(true);

    expect((await api(`/messages/${id}`, { method: "DELETE", key })).status).toBe(200);
    expect((await api(`/messages/${id}`, { key })).status).toBe(404);
    expect((await api(`/messages/${id}/attachments/0`, { key })).status).toBe(404);
    expect((await api(`/messages/${id}/read`, { method: "POST", key })).status).toBe(404);
    expect((await api(`/messages/${id}`, { method: "DELETE", key })).status).toBe(404);
    const list = (await (await api("/messages", { key })).json()) as { messages: unknown[] };
    expect(list.messages).toEqual([]);
    const row = await env.DB.prepare("SELECT deleted_at FROM messages WHERE id = ?").bind(id).first<{ deleted_at: number }>();
    expect(row!.deleted_at).toEqual(expect.any(Number));
    expect((await env.MAIL.list()).objects).toHaveLength(1);
  });
});
