import { createExecutionContext, createMessageBatch } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import type { DeliveryEvent } from "../src/env";
import worker from "../src/index";
import { reset } from "./helpers";

beforeEach(reset);

it("serves the API from the deployed Worker entry point", async () => {
  const res = await (exports as any).default.fetch("https://worker.example/messages");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "Unauthorized" });
});

// Guards the literal queue name in src/index.ts against a typo diverging from
// wrangler.example.jsonc's `queues.consumers`: nothing else checks that a batch from
// "agent-inbox-email-events" actually reaches handleDeliveryEvent, not handleQueue.
//
// Calls the default export's own `queue` directly rather than through `exports` from
// "cloudflare:workers": that binding is RPC-like and structured-clones its arguments, and
// `createMessageBatch()`'s MessageBatch (a QueueController) isn't cloneable, so it throws
// a DataCloneError before src/index.ts ever sees it. A direct call still exercises the exact
// routing logic the deployed Worker runs.
it("routes the agent-inbox-email-events queue to the delivery-event handler", async () => {
  await env.DB.prepare("INSERT INTO inboxes (id, address, key_hash, created_at, updated_at) VALUES ('i1','a@x.com','h',0,0)").run();
  await env.DB.prepare(
    `INSERT INTO messages (id, inbox_id, direction, status, from_addr, from_name, recipients, subject, attachments, message_id, created_at, updated_at)
     VALUES ('m1','i1','out','sent','a@x.com','','b@x.com','s','[]','<m@x>',1,1)`,
  ).run();

  const event: DeliveryEvent = {
    type: "cf.email.sending.message.bounced",
    source: { domain: "email.byagent.io" },
    metadata: { eventTimestamp: new Date().toISOString() },
    payload: {
      eventId: "e1",
      messageId: "<m@x>",
      recipient: "nobody@example.org",
      terminal: true,
      delivery: { status: "bounced", smtpEnhancedStatusCode: "5.1.1" },
      bounce: { type: "hard", classification: "permanent_failure" },
    },
  };
  const batch = createMessageBatch("agent-inbox-email-events", [
    { id: "ev-1", timestamp: new Date(), attempts: 1, body: event },
  ]);
  const ctx = createExecutionContext();

  // src/index.ts's queue handler doesn't use ctx (cast past the narrower 2-arg type TypeScript
  // infers for it), but the real Workers runtime always passes one, so the call shape matches that.
  await (worker.queue as (...args: unknown[]) => Promise<void>)(batch, env, ctx);

  const row = await env.DB.prepare("SELECT status, status_reason FROM messages WHERE id = 'm1'").first<{
    status: string;
    status_reason: string | null;
  }>();
  expect(row).toMatchObject({ status: "bounced", status_reason: "5.1.1" });
});
