import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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

describe("delivery events", () => {
  it("acks an event with no matching message", async () => {
    const batch = createMessageBatch("agent-inbox-email-events", [
      { id: "ev-1", timestamp: new Date(Date.now() - 10 * 60_000), attempts: 1, body: bounceEvent("<nothing@x>") },
    ]);
    const ctx = createExecutionContext();
    await handleDeliveryEvent(batch as MessageBatch<DeliveryEvent>, env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["ev-1"]);
  });
});
