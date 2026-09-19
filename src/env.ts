export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL: SendEmail;
  WEBHOOKS: Queue<WebhookJob>;
  DOMAIN: string;
  RETENTION_DAYS: string;
  ADMIN_KEY: string;
}

export interface WebhookJob {
  webhookId: string;
  inbox: string;
  messageId: string;
}
