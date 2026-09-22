import { bytesToUuid, hmacSha256Bytes, uuidToBytes } from "./crypto";
import type { Env, Inbox } from "./env";

// A link to one attachment that needs no API key: 54 bytes, base64url, in the path.
//   inbox id (16) · message id (16) · index (u16) · expiry, Unix seconds (u32) · HMAC-SHA256[:16]
// Signed with the inbox's key_hash, so rotating its key revokes every link it minted, and no
// other inbox's. Fifteen minutes, because these land in transcripts that outlive them.
const TTL_SECONDS = 15 * 60;
const SIGNED = 38;
const MAC = 16;

async function mac(keyHash: string, tuple: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return (await hmacSha256Bytes(keyHash, tuple)).subarray(0, MAC);
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
  bytes.set(await mac(inbox.key_hash, bytes.subarray(0, SIGNED)), SIGNED);
  return `${env.API_URL}/attachments/${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

export type Verified = { inbox: Inbox; messageId: string; index: number };

// "invalid" covers a malformed token, a bad signature, and an unknown or deleted inbox alike, so
// none can be told from the others. Only `inboxes` is read before the signature passes: a forged
// token never reaches a message or an R2 lookup, so it cannot probe whether a message exists.
export async function verifyAttachmentToken(env: Env, token: string): Promise<Verified | "invalid" | "expired"> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.fromBase64(token, { alphabet: "base64url" });
  } catch {
    return "invalid";
  }
  if (bytes.length !== SIGNED + MAC) return "invalid";
  const inbox = await env.DB.prepare("SELECT id, address, name, key_hash, deleted_at FROM inboxes WHERE id = ? AND deleted_at IS NULL")
    .bind(bytesToUuid(bytes.subarray(0, 16)))
    .first<Inbox>();
  if (!inbox) return "invalid";
  const expected = await mac(inbox.key_hash, bytes.subarray(0, SIGNED));
  if (!crypto.subtle.timingSafeEqual(expected, bytes.subarray(SIGNED))) return "invalid";
  const view = new DataView(bytes.buffer);
  if (view.getUint32(34) < Math.floor(Date.now() / 1000)) return "expired";
  return { inbox, messageId: bytesToUuid(bytes.subarray(16, 32)), index: view.getUint16(32) };
}
