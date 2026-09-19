import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEmail } from "../src/send";
import { api, createInbox, reset } from "./helpers";

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
        attachments: [{ filename: "a.txt", type: "text/plain", content: new Uint8Array([104, 105]), disposition: "attachment" }],
      },
    });
  });

  it.each([
    [null, "Body must be a JSON object"],
    [{ subject: "Hi", text: "x" }, "`to` is required"],
    [{ to: [1], subject: "Hi", text: "x" }, "Recipients must be email strings"],
    [{ to: "a@x.com", text: "x" }, "`subject` is required"],
    [{ to: "a@x.com", subject: "Hi" }, "`text` or `html` is required"],
    [{ to: "a@x.com", subject: "Hi", text: "x", attachments: [{ filename: "a" }] }, "Attachments need `filename`, `type` and base64 `content`"],
    [{ to: "a@x.com", subject: "Hi", text: "x", attachments: [{ filename: "a", type: "text/plain", content: "not base64!" }] }, "Attachment `content` must be valid base64"],
  ])("rejects %j", (body, error) => {
    expect(buildEmail(body, FROM)).toEqual({ ok: false, status: 400, error });
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
});

describe("POST /send", () => {
  it("sends from the inbox and returns the message id", async () => {
    const { api_key: key, address } = await createInbox("agent");
    const send = vi.fn(async () => ({ messageId: "cf-123" }));
    const res = await api("/send", { method: "POST", key, body: { to: "a@x.com", subject: "Hi", text: "Hello" } }, { EMAIL: { send } as any });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: "cf-123" });
    expect(send).toHaveBeenCalledWith({ from: address, to: ["a@x.com"], subject: "Hi", text: "Hello" });
  });

  it("returns 400 for a bad body and 502 with the Cloudflare error code", async () => {
    const { api_key: key } = await createInbox("agent");
    expect((await api("/send", { method: "POST", key, body: { subject: "Hi" } })).status).toBe(400);

    const send = vi.fn(async () => {
      throw Object.assign(new Error("quota"), { code: "E_DAILY_LIMIT_EXCEEDED" });
    });
    const res = await api("/send", { method: "POST", key, body: { to: "a@x.com", subject: "Hi", text: "x" } }, { EMAIL: { send } as any });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "E_DAILY_LIMIT_EXCEEDED" });
  });
});
