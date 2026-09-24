import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEmail, toHtml } from "../src/send";
import { api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

const FROM = "agent@email.example.com";

describe("buildEmail", () => {
  it("builds a message from the inbox address", () => {
    const result = buildEmail(
      {
        to: "a@x.com",
        cc: ["b@x.com"],
        subject: "Hi",
        text: "Hello",
        from: "spoof@evil.com",
        attachments: [{ filename: "a.txt", type: "text/plain", content: "aGk=" }],
      },
      FROM,
    );
    expect(result).toEqual({
      ok: true,
      message: {
        from: FROM,
        to: ["a@x.com"],
        cc: ["b@x.com"],
        subject: "Hi",
        text: "Hello",
        html: '<div style="white-space:pre-wrap">Hello</div>',
        attachments: [{ filename: "a.txt", type: "text/plain", content: new Uint8Array([104, 105]), disposition: "attachment" }],
      },
    });
  });

  it.each([
    [null, "Body must be a JSON object"],
    [{ subject: "Hi", text: "x" }, "`to` is required"],
    [{ to: [1], subject: "Hi", text: "x" }, "Recipients must be addresses or {address, name}"],
    [{ to: [{ name: "No address" }], subject: "Hi", text: "x" }, "Recipients must be addresses or {address, name}"],
    [{ to: [{ address: "a@x.com", name: "Bad\nName" }], subject: "Hi", text: "x" }, "Recipients must be addresses or {address, name}"],
    [{ to: "a@x.com", text: "x" }, "`subject` is required"],
    [{ to: "a@x.com", subject: "Hi" }, "`text` or `html` is required"],
    [{ to: "a@x.com", subject: "Hi", text: "" }, "`text` or `html` is required"],
    [{ to: "a@x.com", subject: "Hi", text: "  \n" }, "`text` or `html` is required"],
    [{ to: "a@x.com", subject: "Hi", text: " ", html: "\t" }, "`text` or `html` is required"],
    [{ to: "a@x.com", subject: "Hi", text: "x", attachments: [{ filename: "a" }] }, "Attachments need `filename`, `type` and base64 `content`"],
    [{ to: "a@x.com", subject: "Hi", text: "x", attachments: [{ filename: "a", type: "text/plain", content: "not base64!" }] }, "Attachment `content` must be valid base64"],
  ])("rejects %j", (body, error) => {
    expect(buildEmail(body, FROM)).toEqual({ ok: false, status: 400, error });
  });

  it("takes recipients as addresses or {address, name}", () => {
    const result = buildEmail(
      {
        to: ["plain@x.com", { address: "named@x.com", name: " Bob Smith " }],
        cc: { address: "cc@x.com", name: "" },
        subject: "Hi",
        text: "Hello",
      },
      FROM,
    );
    expect(result).toMatchObject({
      ok: true,
      message: { to: ["plain@x.com", { email: "named@x.com", name: "Bob Smith" }], cc: ["cc@x.com"] },
    });
  });

  it("enforces the platform limits", () => {
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@x.com`);
    expect(buildEmail({ to: many, subject: "Hi", text: "x" }, FROM)).toMatchObject({ ok: false, status: 400 });

    const files = Array.from({ length: 33 }, () => ({ filename: "a", type: "text/plain", content: "" }));
    expect(buildEmail({ to: "a@x.com", subject: "Hi", text: "x", attachments: files }, FROM)).toMatchObject({ ok: false, status: 400 });

    const big = [{ filename: "big.bin", type: "application/octet-stream", content: "A".repeat(7_100_000) }];
    expect(buildEmail({ to: "a@x.com", subject: "Hi", text: "x", attachments: big }, FROM)).toMatchObject({ ok: false, status: 413 });

    // 2.7M characters but 5.4M bytes in UTF-8: the limit counts bytes.
    expect(buildEmail({ to: "a@x.com", subject: "Hi", text: "é".repeat(2_700_000) }, FROM)).toMatchObject({ ok: false, status: 413 });
  });

  it("fills in whichever of text and html is missing, and keeps both when given", () => {
    const message = (body: object) => (buildEmail({ to: "a@x.com", subject: "Hi", ...body }, FROM) as any).message;
    expect(message({ text: "a < b\n\tc" })).toMatchObject({ text: "a < b\n\tc", html: '<div style="white-space:pre-wrap">a &lt; b\n\tc</div>' });
    expect(message({ html: '<p>Hi <a href="https://x.com">there</a></p>' })).toMatchObject({ text: "Hi [there](https://x.com)" });
    expect(message({ text: " ", html: "<b>Hi</b>" })).toMatchObject({ text: "**Hi**", html: "<b>Hi</b>" });
    expect(message({ text: "plain", html: "<i>rich</i>" })).toMatchObject({ text: "plain", html: "<i>rich</i>" });
  });

  it("counts the generated part toward the 5 MiB limit", () => {
    // 3 MB of text is under the limit on its own; the html generated from it pushes the message over.
    expect(buildEmail({ to: "a@x.com", subject: "Hi", text: "a".repeat(3_000_000) }, FROM)).toMatchObject({ ok: false, status: 413 });
  });

  it("toHtml escapes & < > \"", () => {
    expect(toHtml('<a href="x">&</a>')).toBe('<div style="white-space:pre-wrap">&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;</div>');
  });
});

describe("POST /send", () => {
  it("sends from the inbox and returns the message id", async () => {
    const { api_key: key, address } = await createInbox("agent");
    const send = vi.fn(async () => ({ messageId: "cf-123" }));
    const res = await api("/send", { method: "POST", key, body: { to: "a@x.com", subject: "Hi", text: "Hello" } }, { EMAIL: { send } as any });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: expect.any(String), messageId: "cf-123" });
    expect(send).toHaveBeenCalledWith({ from: address, to: ["a@x.com"], subject: "Hi", text: "Hello", html: '<div style="white-space:pre-wrap">Hello</div>' });
  });

  it("sends under the inbox's name when it has one", async () => {
    const { api_key: key, address } = await createInbox("agent", "Agent Smith");
    const send = vi.fn(async () => ({ messageId: "cf-1" }));
    const res = await api("/send", { method: "POST", key, body: { to: "a@x.com", subject: "Hi", text: "Hello" } }, { EMAIL: { send } as any });
    const { id } = (await res.json()) as { id: string };
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: { email: address, name: "Agent Smith" } }));

    const full = (await (await api(`/messages/${id}`, { key })).json()) as { from: unknown };
    expect(full.from).toEqual({ name: "Agent Smith", address });
    const list = (await (await api("/messages?direction=out", { key })).json()) as { messages: { from: unknown }[] };
    expect(list.messages[0].from).toEqual({ name: "Agent Smith", address });
  });

  it("replies in a thread with reply_to_id", async () => {
    const inbox = await createInbox("agent");
    const key = inbox.api_key;
    await receive(eml({ headers: "Message-ID: <first@x.com>\r\nReferences: <root@x.com>\r\n" }), inbox.address);
    const { messages } = (await (await api("/messages", { key })).json()) as { messages: { id: string }[] };

    const send = vi.fn(async () => ({ messageId: "<reply@ours>" }));
    const body = { to: "a@x.com", subject: "Re: Hello", text: "Replying", reply_to_id: messages[0].id };
    const res = await api("/send", { method: "POST", key, body }, { EMAIL: { send } as any });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { "In-Reply-To": "<first@x.com>", References: "<root@x.com> <first@x.com>" } }),
    );

    // The saved reply keeps the thread, so replies can chain.
    const { id } = (await res.json()) as { id: string };
    const saved = (await (await api(`/messages/${id}`, { key })).json()) as any;
    expect(saved).toMatchObject({ in_reply_to: "<first@x.com>", references: ["<root@x.com>", "<first@x.com>"] });

    const chained = await api("/send", { method: "POST", key, body: { ...body, reply_to_id: id } }, { EMAIL: { send } as any });
    expect(chained.status).toBe(200);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: { "In-Reply-To": "<reply@ours>", References: "<root@x.com> <first@x.com> <reply@ours>" },
      }),
    );
  });

  it("rejects a reply_to_id from another inbox or a missing message", async () => {
    const { api_key: key } = await createInbox("agent");
    const other = await createInbox("other");
    await receive(eml({ headers: "Message-ID: <x@x.com>\r\n" }), other.address);
    const theirs = (await (await api("/messages", { key: other.api_key })).json()) as { messages: { id: string }[] };

    for (const reply_to_id of [theirs.messages[0].id, "nope", 5]) {
      const res = await api("/send", { method: "POST", key, body: { to: "a@x.com", subject: "Hi", text: "x", reply_to_id } });
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 for a bad body and 502 with the Cloudflare error code", async () => {
    const { api_key: key } = await createInbox("agent");
    expect((await api("/send", { method: "POST", key, body: { subject: "Hi" } })).status).toBe(400);

    const send = vi.fn(async () => {
      throw Object.assign(new Error("quota"), { code: "E_DAILY_LIMIT_EXCEEDED" });
    });
    const res = await api("/send", { method: "POST", key, body: { to: "a@x.com", subject: "Hi", text: "x" } }, { EMAIL: { send } as any });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ id: expect.any(String), error: "E_DAILY_LIMIT_EXCEEDED" });
  });

  it("stores a failed row and returns its id when the send throws", async () => {
    const inbox = await createInbox("agent");
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("quota"), { code: "E_DAILY_LIMIT_EXCEEDED" }));
    const res = await api(
      "/send",
      { method: "POST", key: inbox.api_key, body: { to: "bob@example.org", subject: "Hi", text: "Hello" } },
      { EMAIL: { send } as any },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { id: string; error: string };
    expect(body.error).toBe("E_DAILY_LIMIT_EXCEEDED");

    const row = await env.DB.prepare("SELECT id, direction, status, status_reason FROM messages").first();
    expect(row).toEqual({ id: body.id, direction: "out", status: "failed", status_reason: "E_DAILY_LIMIT_EXCEEDED" });

    const stored = await (await env.MAIL.get(`${inbox.id}/${body.id}/message.json`))!.json<any>();
    expect(stored.message_id).toBeNull();
  });

  it("stores the message id and updated_at on a sent message", async () => {
    const inbox = await createInbox("agent");
    const send = vi.fn().mockResolvedValue({ messageId: "<m1@email.byagent.io>" });
    await api("/send", { method: "POST", key: inbox.api_key, body: { to: "bob@example.org", subject: "Hi", text: "Hello" } }, { EMAIL: { send } as any });

    const row = await env.DB.prepare("SELECT message_id, created_at, updated_at FROM messages").first<any>();
    expect(row.message_id).toBe("<m1@email.byagent.io>");
    expect(row.updated_at).toBe(row.created_at);
  });

  it("stores a null message id when the send failed", async () => {
    const inbox = await createInbox("agent");
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("down"), { code: "E_X" }));
    await api("/send", { method: "POST", key: inbox.api_key, body: { to: "bob@example.org", subject: "Hi", text: "Hello" } }, { EMAIL: { send } as any });
    const row = await env.DB.prepare("SELECT message_id FROM messages").first<any>();
    expect(row.message_id).toBeNull();
  });
});
