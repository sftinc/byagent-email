export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL: SendEmail;
  WEBHOOKS: Queue<WebhookJob>;
  RETENTION_DAYS: string;
  ADMIN_KEY: string;
}

export interface WebhookJob {
  webhookId: string;
  messageId: string;
}

// The Workers runtime has these, but TypeScript's lib doesn't declare them yet.
declare global {
  interface Uint8Array { toBase64(): string }
  interface Uint8ArrayConstructor { fromBase64(base64: string): Uint8Array }
}
