// An optional display name, for an inbox or a webhook. null or "" means none. Line breaks and other
// control characters are refused, so a name can't add headers to outgoing mail.
// Returns undefined when the value is invalid.
export function parseName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) return undefined;
  return name || null;
}

export const BAD_NAME = "`name` must be text, at most 100 characters, with no line breaks";

// A token the receiver issued, sent as `Authorization: Bearer ...`. Omitted means no such header.
// Trimmed, because a pasted token with stray whitespace would be rejected on every delivery.
// Control characters are refused: a line break in a header value would inject a header.
// Returns undefined when the value is invalid.
export function parseBearer(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const bearer = value.trim();
  if (!bearer || bearer.length > 500 || /[\x00-\x1f\x7f]/.test(bearer)) return undefined;
  return bearer;
}

export const BAD_BEARER = "`bearer` must be text, 1 to 500 characters, with no line breaks";
