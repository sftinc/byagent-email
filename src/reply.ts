import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Result } from "./env";

// The one REST mapping of a Result: the data with the given status, or the error with its own.
// A failure's `data` is merged under the error, so a failed send answers `{ id, error }`.
export function reply<T extends object>(c: Context, result: Result<T>, status: ContentfulStatusCode = 200): Response {
  if (result.ok) return c.json(result.data, status);
  return c.json({ ...(result.data as object | undefined), error: result.error }, result.status as ContentfulStatusCode);
}
