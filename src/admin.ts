import { type Context, Hono } from "hono";
import { findInbox, type Policy } from "./auth";
import { sha256 } from "./crypto";
import type { Env, Inbox } from "./env";
import { createInbox, deleteInbox, listDomains, listInboxes, listRejected, purgeInbox, renameInbox, restoreInbox, rotateInboxKey } from "./inboxes";
import { reply } from "./reply";

export const admin = new Hono<{ Bindings: Env }>();

admin.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!c.env.ADMIN_KEY || (await sha256(token)) !== (await sha256(c.env.ADMIN_KEY))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// A route's :id is an id, never an address. Answers 404 when the inbox is missing or in the wrong
// state for the route: renaming, deleting and rotating need a live inbox, restoring a deleted one,
// and purge takes either and branches.
async function target(c: Context<{ Bindings: Env }>, policy: Policy): Promise<Inbox | Response> {
  const inbox = await findInbox(c.env, { id: c.req.param("id")! }, policy);
  return inbox ?? c.json({ error: "Inbox not found" }, 404);
}

admin.post("/inboxes", async (c) => reply(c, await createInbox(c.env, await c.req.json().catch(() => ({}))), 201));
admin.get("/inboxes", async (c) => reply(c, await listInboxes(c.env, c.req.query("deleted") === "true")));
admin.get("/rejected", async (c) => reply(c, await listRejected(c.env)));
admin.get("/domains", async (c) => reply(c, await listDomains(c.env)));

admin.patch("/inboxes/:id", async (c) => {
  const inbox = await target(c, "live");
  if (inbox instanceof Response) return inbox;
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  return reply(c, await renameInbox(c.env, inbox, body.name));
});

admin.delete("/inboxes/:id", async (c) => {
  const inbox = await target(c, "live");
  return inbox instanceof Response ? inbox : reply(c, await deleteInbox(c.env, inbox));
});

admin.post("/inboxes/:id/restore", async (c) => {
  const inbox = await target(c, "deleted");
  return inbox instanceof Response ? inbox : reply(c, await restoreInbox(c.env, inbox));
});

admin.post("/inboxes/:id/purge", async (c) => {
  const inbox = await target(c, "any");
  return inbox instanceof Response ? inbox : reply(c, await purgeInbox(c.env, inbox, c.req.query("confirm") === "true"));
});

admin.post("/inboxes/:id/rotate-key", async (c) => {
  const inbox = await target(c, "live");
  return inbox instanceof Response ? inbox : reply(c, await rotateInboxKey(c.env, inbox));
});
