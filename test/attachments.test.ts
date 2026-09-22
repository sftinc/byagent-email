import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAttachmentUrl, verifyAttachmentToken } from "../src/attachments";
import { findInbox } from "../src/auth";
import { uuidv7 } from "../src/crypto";
import type { Inbox } from "../src/env";
import { ADMIN_KEY, api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function inbox(local = "agent"): Promise<Inbox> {
  const created = await createInbox(local);
  return (await findInbox(env, { id: created.id }, "live"))!;
}

function tokenOf(url: string): string {
  return url.split("/attachments/")[1];
}

describe("attachment tokens", () => {
  it("mints a 72-character base64url token under https://API_DOMAIN that verifies to its parts", async () => {
    const box = await inbox();
    const messageId = uuidv7();
    const url = await mintAttachmentUrl(env, box, messageId, 3);
    expect(url).toMatch(/^https:\/\/api\.example\.com\/attachments\/[A-Za-z0-9_-]{72}$/);
    expect(await verifyAttachmentToken(env, tokenOf(url))).toEqual({ inbox: box, messageId, index: 3 });
  });

  it("a token minted under one ADMIN_KEY does not verify under another", async () => {
    const box = await inbox();
    const token = tokenOf(await mintAttachmentUrl(env, box, uuidv7(), 0));
    expect(await verifyAttachmentToken({ ...env, ADMIN_KEY: "other" }, token)).toBe("invalid");
  });

  it("any flipped byte is invalid", async () => {
    const box = await inbox();
    const token = tokenOf(await mintAttachmentUrl(env, box, uuidv7(), 0));
    const bytes = Uint8Array.fromBase64(token, { alphabet: "base64url" });
    for (const i of [0, 15, 16, 31, 32, 33, 34, 37, 38, 53]) {
      const flipped = new Uint8Array(bytes);
      flipped[i] ^= 0x01;
      expect(await verifyAttachmentToken(env, flipped.toBase64({ alphabet: "base64url", omitPadding: true }))).toBe("invalid");
    }
  });

  it("garbage, the wrong length, and another inbox's id are invalid", async () => {
    const box = await inbox();
    const other = await inbox("other");
    const token = tokenOf(await mintAttachmentUrl(env, box, uuidv7(), 0));
    expect(await verifyAttachmentToken(env, "not base64!")).toBe("invalid");
    expect(await verifyAttachmentToken(env, token.slice(0, 40))).toBe("invalid");
    // Swap in a real inbox id: the MAC was made with the first inbox's key, so it no longer matches.
    const bytes = Uint8Array.fromBase64(token, { alphabet: "base64url" });
    bytes.set(Uint8Array.fromBase64(tokenOf(await mintAttachmentUrl(env, other, uuidv7(), 0)), { alphabet: "base64url" }).subarray(0, 16), 0);
    expect(await verifyAttachmentToken(env, bytes.toBase64({ alphabet: "base64url", omitPadding: true }))).toBe("invalid");
  });

  it("expires after fifteen minutes", async () => {
    const box = await inbox();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T12:00:00Z") });
    const token = tokenOf(await mintAttachmentUrl(env, box, uuidv7(), 0));
    vi.setSystemTime(new Date("2026-09-22T12:14:59Z"));
    expect(await verifyAttachmentToken(env, token)).toMatchObject({ index: 0 });
    vi.setSystemTime(new Date("2026-09-22T12:15:01Z"));
    expect(await verifyAttachmentToken(env, token)).toBe("expired");
  });

  it("a deleted inbox or a rotated key invalidates outstanding tokens", async () => {
    const box = await inbox();
    const token = tokenOf(await mintAttachmentUrl(env, box, uuidv7(), 0));
    await api(`/admin/inboxes/${box.id}/rotate-key`, { method: "POST", key: ADMIN_KEY });
    expect(await verifyAttachmentToken(env, token)).toBe("invalid");

    const again = await findInbox(env, { id: box.id }, "live");
    const fresh = tokenOf(await mintAttachmentUrl(env, again!, uuidv7(), 0));
    await api(`/admin/inboxes/${box.id}`, { method: "DELETE", key: ADMIN_KEY });
    expect(await verifyAttachmentToken(env, fresh)).toBe("invalid");
  });

  it("refuses an index that does not fit two bytes rather than wrapping it", async () => {
    const box = await inbox();
    await expect(mintAttachmentUrl(env, box, uuidv7(), 65536)).rejects.toThrow(RangeError);
    await expect(mintAttachmentUrl(env, box, uuidv7(), -1)).rejects.toThrow(RangeError);
  });

  it("a forged token reads inboxes and nothing else", async () => {
    const box = await inbox();
    const token = tokenOf(await mintAttachmentUrl(env, box, uuidv7(), 0));
    const bytes = Uint8Array.fromBase64(token, { alphabet: "base64url" });
    bytes[40] ^= 0xff;
    const prepare = vi.spyOn(env.DB, "prepare");
    const get = vi.spyOn(env.MAIL, "get");
    expect(await verifyAttachmentToken(env, bytes.toBase64({ alphabet: "base64url", omitPadding: true }))).toBe("invalid");
    expect(prepare.mock.calls.map(([sql]) => sql)).toEqual([expect.stringMatching(/^SELECT .* FROM inboxes WHERE id = \?/)]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("GET /attachments/:token", () => {
  async function stored() {
    const created = await createInbox("agent");
    await receive(eml({ attachment: { filename: "notes.txt", content: "file body" } }), created.address);
    const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;
    const message = (await (await api(`/messages/${id}`, { key: created.api_key })).json()) as any;
    return { created, id, url: message.attachments[0].url as string };
  }

  it("a read message links each attachment, and the link fetches the bytes with their headers", async () => {
    const { url } = await stored();
    const res = await api(new URL(url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(await res.text()).toBe("file body\n");
  });

  it("the list does not mint links", async () => {
    const { created } = await stored();
    const list = (await (await api("/messages", { key: created.api_key })).json()) as any;
    expect(list.messages[0].attachments[0]).not.toHaveProperty("url");
  });

  it("a forged token is 404 and says only Not found", async () => {
    const { url } = await stored();
    const token = url.split("/attachments/")[1];
    const bytes = Uint8Array.fromBase64(token, { alphabet: "base64url" });
    bytes[45] ^= 0x01;
    const res = await api(`/attachments/${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("an expired link is 410 and names the recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T12:00:00Z") });
    const { url } = await stored();
    vi.setSystemTime(new Date("2026-09-22T12:16:00Z"));
    const res = await api(new URL(url).pathname);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "This link has expired. Read the message again for a new link." });
  });

  it("a purged message is 410 with the purge message, not the expiry one", async () => {
    const { created, id, url } = await stored();
    await api(`/messages/${id}`, { method: "DELETE", key: created.api_key });
    await api(`/admin/inboxes/${created.id}/purge`, { method: "POST", key: ADMIN_KEY });
    const res = await api(new URL(url).pathname);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "This attachment is no longer available. It was purged." });
  });

  it("a token for index 0 does not fetch index 1", async () => {
    const created = await createInbox("agent");
    await receive(eml({ attachment: { filename: "a.txt", content: "A" } }), created.address);
    const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;
    const message = (await (await api(`/messages/${id}`, { key: created.api_key })).json()) as any;
    // One attachment exists; a hand-minted link to index 1 verifies but has nothing behind it.
    const box = (await findInbox(env, { id: created.id }, "live"))!;
    const res = await api(new URL(await mintAttachmentUrl(env, box, id, 1)).pathname);
    expect(res.status).toBe(410);
    expect(message.attachments).toHaveLength(1);
  });

  it("the old key-authenticated route is gone", async () => {
    const { created, id } = await stored();
    expect((await api(`/messages/${id}/attachments/0`, { key: created.api_key })).status).toBe(404);
  });
});

describe("mark_read", () => {
  it("?mark_read=false reads without marking read", async () => {
    const created = await createInbox("agent");
    await receive(eml(), created.address);
    const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;
    const peek = (await (await api(`/messages/${id}?mark_read=false`, { key: created.api_key })).json()) as any;
    expect(peek.read_at).toBeNull();
    const read = (await (await api(`/messages/${id}`, { key: created.api_key })).json()) as any;
    expect(read.read_at).toEqual(expect.any(Number));
  });
});
