import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAttachmentUrl, verifyAttachmentToken } from "../src/attachments";
import { findInbox } from "../src/auth";
import { uuidv7 } from "../src/crypto";
import type { Inbox } from "../src/env";
import { ADMIN_KEY, api, createInbox, reset } from "./helpers";

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
  it("mints a 72-character base64url token under API_URL that verifies to its parts", async () => {
    const box = await inbox();
    const messageId = uuidv7();
    const url = await mintAttachmentUrl(env, box, messageId, 3);
    expect(url).toMatch(/^https:\/\/api\.example\.com\/attachments\/[A-Za-z0-9_-]{72}$/);
    expect(await verifyAttachmentToken(env, tokenOf(url))).toEqual({ inbox: box, messageId, index: 3 });
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
