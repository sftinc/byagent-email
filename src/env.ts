export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL: SendEmail;
  WEBHOOKS: Queue<WebhookJob>;
  RETENTION_DAYS: string;
  ADMIN_KEY: string;
}

export interface Inbox {
  id: string;
  address: string;
  name: string | null;
}

export interface WebhookJob {
  webhookId: string;
  messageId: string;
  // The status this job fired for. Absent for inbound mail, which has only one state.
  status?: string;
}

// What Cloudflare Email Service publishes to the delivery-events queue. Only the fields we read.
export interface DeliveryEvent {
  type: string;
  source: { domain: string };
  metadata: { eventTimestamp: string };
  payload: {
    eventId: string;
    messageId: string;
    recipient: string;
    terminal: boolean;
    delivery: { status: string; smtpEnhancedStatusCode?: string };
    bounce?: { type: string; classification?: string; reason?: string };
  };
}

// The Workers runtime has these, but TypeScript's lib doesn't declare them yet.
declare global {
  interface Uint8Array { toBase64(): string }
  interface Uint8ArrayConstructor { fromBase64(base64: string): Uint8Array }
}
