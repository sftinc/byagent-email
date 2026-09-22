const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

// UUID v7: a millisecond timestamp, then random bits, so IDs sort roughly by creation time.
export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant
  return formatUuid(Date.now().toString(16).padStart(12, "0") + toHex(bytes.buffer).slice(12));
}

// A UUID's 16 raw bytes, for packing into a token, and back.
export function uuidToBytes(id: string): Uint8Array<ArrayBuffer> {
  const hex = id.replace(/-/g, "");
  return new Uint8Array(16).map((_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export function bytesToUuid(bytes: Uint8Array): string {
  return formatUuid(toHex(bytes));
}

export async function sha256(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacSha256(secret: string, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)));
}

export async function hmacSha256Bytes(secret: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), data));
}
