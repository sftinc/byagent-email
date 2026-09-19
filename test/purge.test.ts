import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY, api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);

const counts = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

async function inboxWithTrash() {
  const inbox = await createInbox("agent");
  const hooks = [];
  for (const url of ["https://keep.example/hook", "https://drop.example/hook"]) {
    hooks.push((await (await api("/webhooks", { method: "POST", key: inbox.api_key, body: { url } })).json()) as { id: string });
  }
  await api(`/webhooks/${hooks[1].id}`, { method: "DELETE", key: inbox.api_key });
  for (const subject of ["Keep", "Drop"]) await receive(eml({ subject }), inbox.address);
  const { messages } = (await (await api("/messages", { key: inbox.api_key })).json()) as { messages: any[] };
  const drop = messages.find((m) => m.subject === "Drop")!.id;
  await api(`/messages/${drop}`, { method: "DELETE", key: inbox.api_key });
  return inbox;
}

describe("purge", () => {
  it("empties a live inbox's trash, leaving everything in use", async () => {
    const inbox = await inboxWithTrash();
    const res = await api(`/admin/inboxes/${inbox.id}/purge`, { method: "POST", key: ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: 1, webhooks: 1, inbox: false });

    expect(await counts("messages")).toBe(1);
    expect(await counts("webhooks")).toBe(1);
    expect((await env.MAIL.list()).objects).toHaveLength(1);
    const list = (await (await api("/messages", { key: inbox.api_key })).json()) as { messages: any[] };
    expect(list.messages.map((m) => m.subject)).toEqual(["Keep"]);
  });

  it("refuses to purge a deleted inbox without confirm", async () => {
    const inbox = await inboxWithTrash();
    await api(`/admin/inboxes/${inbox.id}`, { method: "DELETE", key: ADMIN_KEY });
    const res = await api(`/admin/inboxes/${inbox.id}/purge`, { method: "POST", key: ADMIN_KEY });
    expect(res.status).toBe(400);
    expect(await counts("inboxes")).toBe(1);
  });

  it("removes a deleted inbox and everything it owns with confirm", async () => {
    const inbox = await inboxWithTrash();
    await api(`/admin/inboxes/${inbox.id}`, { method: "DELETE", key: ADMIN_KEY });
    const res = await api(`/admin/inboxes/${inbox.id}/purge?confirm=true`, { method: "POST", key: ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: 2, webhooks: 2, inbox: true });

    for (const table of ["inboxes", "webhooks", "messages"]) expect(await counts(table)).toBe(0);
    expect((await env.MAIL.list()).objects).toHaveLength(0);
    // The address is free again.
    const again = await api("/admin/inboxes", { method: "POST", key: ADMIN_KEY, body: { address: inbox.address } });
    expect(again.status).toBe(201);
  });

  it("404s for an unknown inbox", async () => {
    expect((await api("/admin/inboxes/nope/purge?confirm=true", { method: "POST", key: ADMIN_KEY })).status).toBe(404);
  });
});
