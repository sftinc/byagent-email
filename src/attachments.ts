import { findInbox } from "./auth";
import { bytesToUuid, hmacSha256Bytes, uuidToBytes } from "./crypto";
import type { Env, Inbox } from "./env";

// A link to one attachment that needs no API key: 54 bytes, base64url, in the path.
//   inbox id (16) · message id (16) · index (u16) · expiry, Unix seconds (u32) · HMAC-SHA256[:16]
// Signed with LINK_KEY and the inbox's key_hash together. Fifteen minutes, because these land in
// transcripts that outlive them.
const TTL_SECONDS = 15 * 60;
const SIGNED = 38;
const MAC = 16;

// Two keys, each for its own reason. key_hash makes a link per inbox, so rotating an inbox's key
// revokes its links and no other inbox's. LINK_KEY is a Worker secret that signs nothing else: it
// is not in D1, so reading D1 — which holds key_hash — is not enough to mint a link, and the admin
// key can be rotated without touching links. Without LINK_KEY there is no link at all, rather than
// one anyone with D1 could forge.
async function mac(env: Env, keyHash: string, tuple: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (!env.LINK_KEY) throw new Error("LINK_KEY is not set, so attachment links cannot be signed");
  return (await hmacSha256Bytes(`${env.LINK_KEY}:${keyHash}`, tuple)).subarray(0, MAC);
}

export async function mintAttachmentUrl(env: Env, inbox: Inbox, messageId: string, index: number): Promise<string> {
  // Refused rather than wrapped: a wrapped index would sign a link to the wrong attachment.
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) throw new RangeError(`attachment index out of range: ${index}`);
  const bytes = new Uint8Array(SIGNED + MAC);
  bytes.set(uuidToBytes(inbox.id), 0);
  bytes.set(uuidToBytes(messageId), 16);
  const view = new DataView(bytes.buffer);
  view.setUint16(32, index);
  view.setUint32(34, Math.floor(Date.now() / 1000) + TTL_SECONDS);
  bytes.set(await mac(env, inbox.key_hash, bytes.subarray(0, SIGNED)), SIGNED);
  return `https://${env.API_DOMAIN}/attachments/${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

export type Verified = { inbox: Inbox; messageId: string; index: number };

// "invalid" covers a malformed token, a bad signature, and an unknown or deleted inbox alike, so
// none can be told from the others. Only `inboxes` is read before the signature passes: a forged
// token never reaches a message or an R2 lookup, so it cannot probe whether a message exists.
export async function verifyAttachmentToken(env: Env, token: string): Promise<Verified | "invalid" | "expired"> {
  if (!env.LINK_KEY) return "invalid";
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.fromBase64(token, { alphabet: "base64url" });
  } catch {
    return "invalid";
  }
  if (bytes.length !== SIGNED + MAC) return "invalid";
  const inbox = await findInbox(env, { id: bytesToUuid(bytes.subarray(0, 16)) }, "live");
  if (!inbox) return "invalid";
  const expected = await mac(env, inbox.key_hash, bytes.subarray(0, SIGNED));
  if (!crypto.subtle.timingSafeEqual(expected, bytes.subarray(SIGNED))) return "invalid";
  const view = new DataView(bytes.buffer);
  if (view.getUint32(34) < Math.floor(Date.now() / 1000)) return "expired";
  return { inbox, messageId: bytesToUuid(bytes.subarray(16, 32)), index: view.getUint16(32) };
}
