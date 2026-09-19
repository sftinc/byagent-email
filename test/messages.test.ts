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

  it("lists messages with unread and since filters", async () => {
    const { key, id } = await setup();
    const all = (await (await api("/messages", { key })).json()) as { messages: any[] };
    expect(all.messages).toEqual([
      {
        id,
        direction: "in",
        from: "sender@example.org",
        to: ["agent@email.example.com"],
        subject: "First",
        received_at: expect.any(Number),
        read: false,
      },
    ]);

    await api(`/messages/${id}/read`, { method: "POST", key });
    const unread = (await (await api("/messages?unread=true", { key })).json()) as { messages: any[] };
    expect(unread.messages).toEqual([]);

    const future = Date.now() + 60_000;
    const since = (await (await api(`/messages?since=${future}`, { key })).json()) as { messages: any[] };
    expect(since.messages).toEqual([]);
  });

  it("filters by part of the sender address, ignoring case", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ from: "bob@example.org" }), inbox.address);
    await receive(eml({ from: "alice@other.com" }), inbox.address);
    const from = async (q: string) =>
      ((await (await api(`/messages?from=${encodeURIComponent(q)}`, { key: inbox.api_key })).json()) as { messages: any[] })
        .messages.map((m) => m.from);

    expect(await from("BOB@example.org")).toEqual(["bob@example.org"]);
    expect(await from("@other.com")).toEqual(["alice@other.com"]);
    expect(await from("nobody")).toEqual([]);
  });

  it("orders since results oldest first, and the default newest first", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ subject: "A" }), inbox.address);
    await receive(eml({ subject: "B" }), inbox.address);
    await receive(eml({ subject: "C" }), inbox.address);
    const rows = await env.DB.prepare("SELECT id, subject FROM messages").all<{ id: string; subject: string }>();
    const byName = (subject: string) => rows.results.find((r) => r.subject === subject)!.id;
    const [a, b, c] = [byName("A"), byName("B"), byName("C")];

    const base = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET received_at = ? WHERE id = ?").bind(base, a),
      env.DB.prepare("UPDATE messages SET received_at = ? WHERE id = ?").bind(base + 1000, b),
      env.DB.prepare("UPDATE messages SET received_at = ? WHERE id = ?").bind(base + 2000, c),
    ]);

    const since = (await (await api(`/messages?since=${base}`, { key: inbox.api_key })).json()) as { messages: any[] };
    expect(since.messages.map((m) => m.id)).toEqual([b, c]);

    const all = (await (await api("/messages", { key: inbox.api_key })).json()) as { messages: any[] };
    expect(all.messages.map((m) => m.id)).toEqual([c, b, a]);
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
      from: "sender@example.org",
      to: ["agent@email.example.com"],
      cc: [],
      bcc: [],
      subject: "First",
      date: expect.any(String),
      text: "Hi there\n",
      html: null,
      attachments: [{ index: 0, filename: "notes.txt", type: "text/plain", size: 10 }],
      read: false,
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

  it("marks read and deletes", async () => {
    const { key, id } = await setup();
    expect((await api(`/messages/${id}/read`, { method: "POST", key })).status).toBe(200);
    expect(((await (await api(`/messages/${id}`, { key })).json()) as any).read).toBe(true);

    expect((await api(`/messages/${id}`, { method: "DELETE", key })).status).toBe(200);
    expect((await api(`/messages/${id}`, { key })).status).toBe(404);
    expect((await env.MAIL.list()).objects).toHaveLength(0);
    expect((await api(`/messages/${id}/read`, { method: "POST", key })).status).toBe(404);
  });
});
