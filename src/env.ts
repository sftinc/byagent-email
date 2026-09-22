export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL: SendEmail;
  WEBHOOKS: Queue<WebhookJob>;
  RETENTION_DAYS: string;
  ADMIN_KEY: string;
  API_URL: string; // where the Worker is served; attachment links are minted under it
}

export interface Inbox {
  id: string;
  address: string;
  name: string | null;
  key_hash: string; // signs attachment links; never returned by any route
  deleted_at: number | null;
}

// Every shared operation returns one of these. REST maps it to a status and a JSON body, MCP to a
// tool result. A failure's `data` is for a body that carries more than the error: a failed send
// answers `{ id, error }`, the id being the row that records the attempt.
export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string; data?: unknown };

export interface WebhookJob {
  webhookId: string;
  messageId: string;
  // The status this job fired for, and why. Absent for inbound mail, which has only one state.
  // Always set together, from the same event that queued the job — never mix one with the row's.
  status?: string;
  statusReason?: string | null;
}

// What Cloudflare Email Service publishes to the delivery-events queue, mirroring the payloads
// captured verbatim from production. Some fields go unread today: they're kept because the test
// fixtures depend on them, and because four of the six event types are inference we may need to
// correct later. `payload.terminal` is deliberately one of the unread ones — the code keys off its
// own TERMINAL set (below) because what matters is whether the row's *existing* status is terminal,
// not whether this event is.
export interface DeliveryEvent {
  type: string;
  source: { domain: string };
  metadata: { eventTimestamp: string };
  payload: {
    eventId: string;
    messageId: string;
    recipient: string;
    terminal: boolean;
    delivery?: { status: string; smtpEnhancedStatusCode?: string };
    bounce?: { type: string; classification?: string; reason?: string };
  };
}

// The Workers runtime has these, but TypeScript's lib doesn't declare them yet.
declare global {
  interface Uint8Array {
    toBase64(options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }): string;
  }
  interface Uint8ArrayConstructor {
    fromBase64(base64: string, options?: { alphabet?: "base64" | "base64url" }): Uint8Array<ArrayBuffer>;
  }
}
