import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_KEY, api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

describe("inbox resolution", () => {
  it("admin key reaches an inbox's mail by address or id, and is logged", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ subject: "Hi" }), inbox.address);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    for (const selector of [inbox.address, inbox.id, "AGENT@email.example.com"]) {
      const res = await api(`/messages?inbox=${encodeURIComponent(selector)}`, { key: ADMIN_KEY });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).messages.map((m: any) => m.subject)).toEqual(["Hi"]);
    }
    expect(log).toHaveBeenCalledWith({ event: "admin_access", method: "GET", path: "/messages", inbox: inbox.address });
  });

  it("admin key without an inbox is an argument error, never an inbox lookup", async () => {
    await createInbox("agent");
    const res = await api("/messages", { key: ADMIN_KEY });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/`inbox` is required with the admin key/);
  });

  it("admin key naming an unknown or deleted inbox is 404", async () => {
    const inbox = await createInbox("agent");
    expect((await api("/messages?inbox=nobody@email.example.com", { key: ADMIN_KEY })).status).toBe(404);
    await api(`/admin/inboxes/${inbox.id}`, { method: "DELETE", key: ADMIN_KEY });
    expect((await api(`/messages?inbox=${inbox.address}`, { key: ADMIN_KEY })).status).toBe(404);
  });

  it("inbox key ignores an absent selector and accepts its own", async () => {
    const inbox = await createInbox("agent");
    expect((await api("/messages", { key: inbox.api_key })).status).toBe(200);
    expect((await api(`/messages?inbox=${inbox.address}`, { key: inbox.api_key })).status).toBe(200);
    expect((await api(`/messages?inbox=${inbox.id}`, { key: inbox.api_key })).status).toBe(200);
  });

  it("inbox key naming another inbox is refused, naming its own address", async () => {
    const inbox = await createInbox("agent");
    const other = await createInbox("other");
    const res = await api(`/messages?inbox=${other.address}`, { key: inbox.api_key });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: `This key is for ${inbox.address}` });
  });

  it("no credential, an unknown one, or an empty bearer is 401", async () => {
    await createInbox("agent");
    expect((await api("/messages")).status).toBe(401);
    expect((await api("/messages", { key: "nope" })).status).toBe(401);
    expect((await api("/messages", { key: "" })).status).toBe(401);
  });

  it("an empty bearer is not the admin key when ADMIN_KEY is unset", async () => {
    await createInbox("agent");
    const res = await api("/messages?inbox=agent@email.example.com", { key: "" }, { ADMIN_KEY: "" });
    expect(res.status).toBe(401);
  });

  it("/admin/* still rejects an inbox key", async () => {
    const inbox = await createInbox("agent");
    expect((await api("/admin/inboxes", { key: inbox.api_key })).status).toBe(401);
  });
});
