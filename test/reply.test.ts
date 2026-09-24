import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/api";
import { api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

// eml() with a Message-ID, which a message needs to be replied to.
const mail = (opts: Parameters<typeof eml>[0] = {}) => eml({ ...opts, headers: `Message-ID: <first@x.com>\r\n${opts.headers ?? ""}` });

// A send binding that records what it was asked to send.
function binding() {
  const send = vi.fn(async (_message: any) => ({ messageId: `<${crypto.randomUUID()}@ours>` }));
  return { EMAIL: { send } as any, last: () => send.mock.lastCall![0] };
}

// Receives `raw` into a fresh inbox; returns the inbox and the message id.
async function received(raw: string) {
  const inbox = await createInbox("agent");
  await receive(raw, inbox.address);
  const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;
  return { inbox, key: inbox.api_key, id };
}

const post = (key: string, path: string, body: unknown, EMAIL?: any) => api(path, { method: "POST", key, body }, EMAIL ? { EMAIL } : {});

describe("reply", () => {
  it("replies to the sender by name, in the thread, with Re: and the original below", async () => {
    const { key, id } = await received(mail());
    const b = binding();
    const res = await post(key, `/messages/${id}/reply`, { text: "Thanks" }, b.EMAIL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: expect.any(String), messageId: expect.any(String) });
    expect(b.last()).toMatchObject({
      to: [{ email: "sender@example.org", name: "Sender" }],
      subject: "Re: Hello",
      headers: { "In-Reply-To": "<first@x.com>", References: "<first@x.com>" },
      text: "Thanks\n\nOn Sat, 19 Sep 2026 10:00:00 GMT, Sender <sender@example.org> wrote:\n\nHi there\n",
    });
    expect(b.last().html).toMatch(
      /^<div style="white-space:pre-wrap">Thanks<\/div><br><br><div>On Sat, 19 Sep 2026 10:00:00 GMT, Sender &lt;sender@example.org&gt; wrote:<\/div><br>.*Hi there/s,
    );
    expect(b.last().cc).toBeUndefined();
  });

  it("goes to Reply-To when the message has one", async () => {
    const { key, id } = await received(mail({ headers: "Reply-To: Help Desk <help@example.org>\r\n" }));
    const b = binding();
    await post(key, `/messages/${id}/reply`, { text: "x" }, b.EMAIL);
    expect(b.last().to).toEqual([{ email: "help@example.org", name: "Help Desk" }]);
  });

  it("ignores a subject in the body, and doesn't double Re:", async () => {
    for (const [subject, expected] of [["RE: Hello", "RE: Hello"], ["re: Hello", "re: Hello"], ["Fwd: Hi", "Re: Fwd: Hi"], ["", "Re:"]]) {
      await reset();
      const { key, id } = await received(mail({ subject }));
      const b = binding();
      await post(key, `/messages/${id}/reply`, { text: "x", subject: "Other" }, b.EMAIL);
      expect(b.last().subject).toBe(expected);
    }
  });

  it("collapses control characters an encoded subject decodes to, before adding Re:", async () => {
    const { key, id } = await received(mail({ subject: "=?utf-8?Q?Hi=0D=0ABcc=3A_victim=40x.org?=" }));
    const b = binding();
    await post(key, `/messages/${id}/reply`, { text: "x" }, b.EMAIL);
    expect(b.last().subject).toBe("Re: Hi Bcc: victim@x.org");
  });

  it("includes an html-only original in both parts", async () => {
    const raw = mail({ text: "<p>Hi <b>Bob</b></p>" }).replace("Content-Type: text/plain", "Content-Type: text/html");
    const { key, id } = await received(raw);
    const b = binding();
    await post(key, `/messages/${id}/reply`, { html: "<p>Sure</p>" }, b.EMAIL);
    expect(b.last().text).toMatch(/^Sure\n\nOn .* wrote:\n\n.*Hi (\*\*)?Bob/s);
    expect(b.last().html).toMatch(/^<p>Sure<\/p><br><br><div>On .* wrote:<\/div><br>.*<b>Bob<\/b>/s);
  });

  it("quotes a blank html part as generated from the text, not as blank html", async () => {
    const raw =
      "From: Sender <sender@example.org>\r\nTo: agent@email.example.com\r\nSubject: Hello\r\n" +
      "Date: Sat, 19 Sep 2026 10:00:00 +0000\r\nMessage-ID: <first@x.com>\r\nMIME-Version: 1.0\r\n" +
      "Content-Type: multipart/alternative; boundary=BOUNDARY\r\n\r\n" +
      "--BOUNDARY\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHi there\r\n" +
      "--BOUNDARY\r\nContent-Type: text/html; charset=utf-8\r\n\r\n \r\n--BOUNDARY--\r\n";
    const { key, id } = await received(raw);
    const b = binding();
    await post(key, `/messages/${id}/reply`, { text: "Thanks" }, b.EMAIL);
    expect(b.last().html).toMatch(/Hi there/);
  });

  it("reply-all copies the other recipients once, never this inbox or the sender again", async () => {
    const raw = mail({
      to: "Agent <agent@email.example.com>, Carol <carol@example.org>",
      headers: "Cc: Again <Sender@Example.org>, Dan <dan@example.org>\r\n",
    });
    const { key, id } = await received(raw);
    const b = binding();
    await post(key, `/messages/${id}/reply-all`, { text: "All" }, b.EMAIL);
    expect(b.last().to).toEqual([{ email: "sender@example.org", name: "Sender" }]);
    expect(b.last().cc).toEqual([
      { email: "carol@example.org", name: "Carol" },
      { email: "dan@example.org", name: "Dan" },
    ]);
  });

  it("drops an inherited cc with no address, reply-all still works", async () => {
    const { key, id } = await received(mail({ headers: "Cc: Bob, Dan <dan@example.org>\r\n" }));
    const b = binding();
    const res = await post(key, `/messages/${id}/reply-all`, { text: "x" }, b.EMAIL);
    expect(res.status).toBe(200);
    expect(b.last().cc).toEqual([{ email: "dan@example.org", name: "Dan" }]);
  });

  it("to mail the inbox sent, goes to its original recipients, never its bcc", async () => {
    const inbox = await createInbox("agent");
    const b = binding();
    const body = { to: { address: "bob@x.com", name: "Bob" }, cc: "carol@x.com", bcc: "dave@x.com", subject: "Plan", text: "Here" };
    const { id } = (await (await post(inbox.api_key, "/send", body, b.EMAIL)).json()) as { id: string };

    await post(inbox.api_key, `/messages/${id}/reply`, { text: "Following up" }, b.EMAIL);
    expect(b.last()).toMatchObject({ to: [{ email: "bob@x.com", name: "Bob" }], subject: "Re: Plan" });
    expect(b.last().cc).toBeUndefined();

    await post(inbox.api_key, `/messages/${id}/reply-all`, { text: "Following up" }, b.EMAIL);
    expect(b.last()).toMatchObject({ to: [{ email: "bob@x.com", name: "Bob" }], cc: ["carol@x.com"] });
    expect(b.last().bcc).toBeUndefined();
  });

  it("takes to and cc from the body over the defaults, then drops repeats and this inbox", async () => {
    const { key, id, inbox } = await received(mail({ headers: "Cc: Carol <carol@example.org>, Dan <dan@example.org>\r\n" }));
    const b = binding();
    await post(key, `/messages/${id}/reply-all`, { to: ["carol@example.org", inbox.address], text: "x" }, b.EMAIL);
    expect(b.last().to).toEqual(["carol@example.org"]);
    expect(b.last().cc).toEqual([{ email: "dan@example.org", name: "Dan" }]);

    await post(key, `/messages/${id}/reply-all`, { cc: [], text: "x" }, b.EMAIL);
    expect(b.last().cc).toBeUndefined();
  });

  it("drops an inherited name sendMail would refuse, but refuses the same name from the caller", async () => {
    const long = "a".repeat(101);
    const { key, id } = await received(mail().replace("From: Sender <sender@example.org>", `From: ${long} <sender@example.org>`));
    const b = binding();
    expect((await post(key, `/messages/${id}/reply`, { text: "x" }, b.EMAIL)).status).toBe(200);
    expect(b.last().to).toEqual(["sender@example.org"]);

    const res = await post(key, `/messages/${id}/reply`, { to: { address: "x@x.com", name: long }, text: "x" }, b.EMAIL);
    expect(res.status).toBe(400);
  });

  it("inherits a from name with a control character as the plain address", async () => {
    const { key, id } = await received(
      mail().replace("From: Sender <sender@example.org>", "From: =?utf-8?Q?Evil=0D=0ABcc=3A_x=40x.org?= <sender@example.org>"),
    );
    const b = binding();
    expect((await post(key, `/messages/${id}/reply`, { text: "x" }, b.EMAIL)).status).toBe(200);
    expect(b.last().to).toEqual(["sender@example.org"]);
  });

  it("refuses a reply with no text or html, even with an empty body", async () => {
    const { key, id } = await received(mail());
    for (const body of [{}, { text: "" }, { text: "  \n", html: " " }]) {
      const res = await post(key, `/messages/${id}/reply`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "`text` or `html` is required" });
    }
  });

  it("answers 400, not 500, for malformed JSON or a null body", async () => {
    const { key, id } = await received(mail());
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const bad = await app.request(`/messages/${id}/reply`, { method: "POST", headers, body: "{nope" }, env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Body must be a JSON object" });
    expect((await post(key, `/messages/${id}/reply-all`, null)).status).toBe(400);
  });

  it("is 404 for a message that isn't in this inbox", async () => {
    const { id } = await received(mail());
    const other = await createInbox("other");
    expect((await post(other.api_key, `/messages/${id}/reply`, { text: "x" })).status).toBe(404);
    expect((await post(other.api_key, "/messages/nope/reply-all", { text: "x" })).status).toBe(404);
  });

  it("answers 400 `to` is required when the original has no sender", async () => {
    const { key, id } = await received(mail().replace("From: Sender <sender@example.org>\r\n", ""));
    const res = await post(key, `/messages/${id}/reply`, { text: "x" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "`to` is required" });
  });

  it("dates the quote from when it arrived when the original has no Date", async () => {
    const { key, id } = await received(mail().replace(/Date: .*\r\n/, ""));
    const b = binding();
    await post(key, `/messages/${id}/reply`, { text: "x" }, b.EMAIL);
    expect(b.last().text).toMatch(/\n\nOn \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT, Sender <sender@example.org> wrote:\n\n/);
  });

  it("can reply to a deleted message, like /send with reply_to_id", async () => {
    const { key, id } = await received(mail());
    await api(`/messages/${id}`, { method: "DELETE", key });
    const b = binding();
    expect((await post(key, `/messages/${id}/reply`, { text: "x" }, b.EMAIL)).status).toBe(200);
  });
});
