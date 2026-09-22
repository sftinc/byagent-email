import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryEvent } from "../src/env";
import { handleDeliveryEvent } from "../src/events";
import { reset } from "./helpers";

beforeEach(reset);

export function bounceEvent(messageId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "cf.email.sending.message.bounced",
    source: { zoneId: "z", domain: "email.byagent.io", type: "email.sending" },
    metadata: { eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
    payload: {
      eventId: "e1",
      messageId,
      sender: "test@email.byagent.io",
      recipient: "nobody@example.org",
      subject: "x",
      terminal: true,
      delivery: { status: "bounced", provider: "gmail", smtpStatusCode: "550", smtpEnhancedStatusCode: "5.1.1", smtpResponse: "550 5.1.1 User unknown" },
      bounce: { type: "hard", classification: "permanent_failure", reason: "550 5.1.1 User unknown" },
      ...overrides,
    },
  };
}

async function sentMessage(messageId: string) {
  await env.DB.prepare("INSERT INTO inboxes (id, address, key_hash, created_at, updated_at) VALUES ('i1','a@x.com','h',0,0)").run();
  await env.DB.prepare(
    `INSERT INTO messages (id, inbox_id, direction, status, from_addr, from_name, recipients, subject, attachments, message_id, created_at, updated_at)
     VALUES ('m1','i1','out','sent','a@x.com','','b@x.com','s','[]',?,1,1)`,
  ).bind(messageId).run();
}

const run = (body: unknown) =>
  handleDeliveryEvent(
    createMessageBatch("agent-inbox-email-events", [{ id: "ev-1", timestamp: new Date(), attempts: 1, body }]) as any,
    env,
  );

const status = () => env.DB.prepare("SELECT status, status_reason, updated_at FROM messages").first<any>();

describe("delivery events", () => {
  it("acks an event with no matching message", async () => {
    const batch = createMessageBatch("agent-inbox-email-events", [
      { id: "ev-1", timestamp: new Date(Date.now() - 10 * 60_000), attempts: 1, body: bounceEvent("<nothing@x>") },
    ]);
    const ctx = createExecutionContext();
    await handleDeliveryEvent(batch as MessageBatch<DeliveryEvent>, env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["ev-1"]);
  });

  it("marks a bounced message bounced with its enhanced status code", async () => {
    await sentMessage("<m@x>");
    await run(bounceEvent("<m@x>"));
    expect(await status()).toMatchObject({ status: "bounced", status_reason: "5.1.1" });
  });

  it("prefixes a soft bounce", async () => {
    await sentMessage("<m@x>");
    const e = bounceEvent("<m@x>");
    e.payload.bounce.type = "soft";
    await run(e);
    expect((await status()).status_reason).toBe("soft:5.1.1");
  });

  it("marks a delivered message delivered with no reason", async () => {
    await sentMessage("<m@x>");
    const e = bounceEvent("<m@x>");
    e.type = "cf.email.sending.message.delivered";
    e.payload.delivery = { status: "delivered", provider: "cloudflare" } as any;
    delete (e.payload as any).bounce;
    await run(e);
    expect(await status()).toMatchObject({ status: "delivered", status_reason: null });
  });

  it("marks a deferred message deferred with its enhanced status code", async () => {
    await sentMessage("<m@x>");
    const e = bounceEvent("<m@x>");
    e.type = "cf.email.sending.message.deferred";
    e.payload.terminal = false;
    e.payload.delivery = {
      status: "deferred",
      provider: "gmail",
      smtpStatusCode: "421",
      smtpEnhancedStatusCode: "4.2.2",
      smtpResponse: "421 4.2.2 Mailbox full, try again later",
    } as any;
    delete (e.payload as any).bounce;
    await run(e);
    expect(await status()).toMatchObject({ status: "deferred", status_reason: "4.2.2" });
  });

  it("marks a complained message complained with no reason", async () => {
    await sentMessage("<m@x>");
    const e = bounceEvent("<m@x>");
    e.type = "cf.email.sending.message.complained";
    e.payload.delivery = { status: "complained", provider: "gmail" } as any;
    delete (e.payload as any).bounce;
    await run(e);
    expect(await status()).toMatchObject({ status: "complained", status_reason: null });
  });

  it("marks a rejected message rejected with delivery.status as the reason", async () => {
    await sentMessage("<m@x>");
    const e = bounceEvent("<m@x>");
    e.type = "cf.email.sending.message.rejected";
    e.payload.delivery = { status: "suppressed", provider: "cloudflare" } as any;
    delete (e.payload as any).bounce;
    await run(e);
    expect(await status()).toMatchObject({ status: "rejected", status_reason: "suppressed" });
  });

  it("marks a failed message failed with its enhanced status code", async () => {
    await sentMessage("<m@x>");
    const e = bounceEvent("<m@x>");
    e.type = "cf.email.sending.message.failed";
    e.payload.delivery = {
      status: "failed",
      provider: "gmail",
      smtpStatusCode: "451",
      smtpEnhancedStatusCode: "4.3.0",
      smtpResponse: "451 4.3.0 internal error",
    } as any;
    delete (e.payload as any).bounce;
    await run(e);
    expect(await status()).toMatchObject({ status: "failed", status_reason: "4.3.0" });
  });

  it("bumps updated_at", async () => {
    await sentMessage("<m@x>");
    await run(bounceEvent("<m@x>"));
    expect((await status()).updated_at).toBeGreaterThan(1);
  });

  it("retries an unmatched event that is younger than five minutes", async () => {
    const batch = createMessageBatch("agent-inbox-email-events", [
      { id: "ev-1", timestamp: new Date(Date.now() - 60_000), attempts: 1, body: bounceEvent("<absent@x>") },
    ]);
    const retry = vi.fn();
    (batch.messages[0] as any).retry = retry;
    await handleDeliveryEvent(batch as any, env);
    // The delay is what makes the grace window reachable at all; a bare retry() burns max_retries in seconds.
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("acks an unmatched event older than five minutes", async () => {
    const batch = createMessageBatch("agent-inbox-email-events", [
      { id: "ev-1", timestamp: new Date(Date.now() - 10 * 60_000), attempts: 1, body: bounceEvent("<absent@x>") },
    ]);
    const retry = vi.fn();
    (batch.messages[0] as any).retry = retry;
    const ctx = createExecutionContext();
    await handleDeliveryEvent(batch as any, env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["ev-1"]);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not let a late deferred overwrite a delivered", async () => {
    await sentMessage("<m@x>");
    const delivered = bounceEvent("<m@x>");
    delivered.type = "cf.email.sending.message.delivered";
    delivered.payload.delivery = { status: "delivered", provider: "cloudflare" } as any;
    await run(delivered);

    const deferred = bounceEvent("<m@x>");
    deferred.type = "cf.email.sending.message.deferred";
    deferred.payload.terminal = false;
    await run(deferred);

    expect((await status()).status).toBe("delivered");
  });

  it("lets one terminal state replace another", async () => {
    await sentMessage("<m@x>");
    await run(bounceEvent("<m@x>"));
    const complained = bounceEvent("<m@x>");
    complained.type = "cf.email.sending.message.complained";
    await run(complained);
    expect((await status()).status).toBe("complained");
  });

  it("retries an event for an inbound message, since it matches no outbound row", async () => {
    await env.DB.prepare("INSERT INTO inboxes (id, address, key_hash, created_at, updated_at) VALUES ('i1','a@x.com','h',0,0)").run();
    await env.DB.prepare(
      `INSERT INTO messages (id, inbox_id, direction, status, from_addr, from_name, recipients, subject, attachments, message_id, created_at, updated_at)
       VALUES ('m1','i1','in','received','a@x.com','','b@x.com','s','[]','<m@x>',1,1)`,
    ).run();
    const batch = createMessageBatch("agent-inbox-email-events", [
      { id: "ev-1", timestamp: new Date(), attempts: 1, body: bounceEvent("<m@x>") },
    ]);
    const retry = vi.fn();
    (batch.messages[0] as any).retry = retry;
    await handleDeliveryEvent(batch as any, env);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect((await status()).status).toBe("received");
  });

  it("queues a webhook for a terminal failure", async () => {
    await sentMessage("<m@x>");
    await env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret, created_at) VALUES ('w1','i1','https://a.example/hook','s',0)").run();
    const sendBatch = vi.fn();
    await handleDeliveryEvent(
      createMessageBatch("agent-inbox-email-events", [{ id: "ev-1", timestamp: new Date(), attempts: 1, body: bounceEvent("<m@x>") }]) as any,
      { ...env, WEBHOOKS: { sendBatch } as any },
    );
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { webhookId: "w1", messageId: "m1", status: "bounced", statusReason: "5.1.1" } },
    ]);
  });

  it("queues no webhook for delivered or deferred", async () => {
    await sentMessage("<m@x>");
    await env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret, created_at) VALUES ('w1','i1','https://a.example/hook','s',0)").run();
    const sendBatch = vi.fn();
    const e = bounceEvent("<m@x>");
    e.type = "cf.email.sending.message.delivered";
    e.payload.delivery = { status: "delivered", provider: "cloudflare" } as any;
    await handleDeliveryEvent(
      createMessageBatch("agent-inbox-email-events", [{ id: "ev-1", timestamp: new Date(), attempts: 1, body: e }]) as any,
      { ...env, WEBHOOKS: { sendBatch } as any },
    );
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
