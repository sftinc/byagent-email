import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/api";
import type { Env } from "../src/env";
import { ADMIN_KEY, api, createInbox, eml, receive, reset } from "./helpers";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

export const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

export function rpc(body: unknown, headers: Record<string, string> = {}, overrides: Partial<Env> = {}): Promise<Response> {
  return Promise.resolve(
    app.request(
      "/mcp",
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
      { ...env, ...overrides },
    ),
  );
}

// A well-formed request in each era. `key` sets the bearer.
export function modern(method: string, params: Record<string, unknown> = {}, opts: { key?: string; headers?: Record<string, string>; id?: unknown } = {}) {
  const headers: Record<string, string> = {
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(typeof params.name === "string" && { "Mcp-Name": params.name }),
    ...opts.headers,
  };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  return rpc({ jsonrpc: "2.0", id: "id" in opts ? opts.id : 1, method, params: { ...params, _meta: META } }, headers);
}

export function legacy(method: string, params: Record<string, unknown> = {}, opts: { key?: string; headers?: Record<string, string>; version?: string; id?: unknown } = {}) {
  const headers: Record<string, string> = { "MCP-Protocol-Version": opts.version ?? "2025-11-25", ...opts.headers };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  return rpc({ jsonrpc: "2.0", id: "id" in opts ? opts.id : 1, method, params }, headers);
}

const errorOf = async (res: Response) => ((await res.json()) as any).error;

describe("transport", () => {
  it("GET and DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"]) expect((await app.request("/mcp", { method }, env)).status).toBe(405);
  });

  it("a foreign Origin is 403", async () => {
    const res = await modern("server/discover", {}, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("a body that is not a JSON-RPC request is -32600", async () => {
    expect((await rpc("nope")).status).toBe(400);
    expect(await errorOf(await rpc({ jsonrpc: "1.0", method: "x" }))).toMatchObject({ code: -32600 });
  });

  it("a notification is 202 with no body", async () => {
    const res = await legacy("notifications/initialized", {}, { id: undefined });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("an unknown method is 404 with -32601 in both eras", async () => {
    for (const res of [await modern("resources/list"), await legacy("resources/list")]) {
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toMatchObject({ code: -32601 });
    }
  });
});

describe("era dispatch", () => {
  it("1: a modern header decides modern; initialize is then unavailable — after validation", async () => {
    expect(await errorOf(await modern("initialize"))).toMatchObject({ code: -32601 });
    const noMethod = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { _meta: META } }, { "MCP-Protocol-Version": "2026-07-28" });
    expect(await errorOf(noMethod)).toMatchObject({ code: -32020 });
    const noMeta = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "initialize" });
    expect(await errorOf(noMeta)).toMatchObject({ code: -32602 });
  });

  it("2: a legacy header decides legacy; server/discover is then unavailable", async () => {
    expect(await errorOf(await legacy("server/discover"))).toMatchObject({ code: -32601 });
  });

  it("3: an unrecognised version is -32022 listing what is supported, not -32601", async () => {
    const res = await legacy("tools/list", {}, { version: "2024-11-05" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: -32022,
      message: expect.any(String),
      data: { supported: ["2026-07-28", "2025-11-25", "2025-06-18"], requested: "2024-11-05" },
    });
  });

  it("4: a bare initialize with no header, no Mcp-Method and no _meta succeeds", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "agent-inbox", version: expect.any(String) },
      instructions: expect.any(String),
    });
  });

  it("5: no header on anything else is -32020, not -32022", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: -32020 });
  });
});

describe("modern validation", () => {
  it("_meta absent, empty, or missing either required field is -32602; empty capabilities and no clientInfo are fine", async () => {
    const send = (meta: unknown) => rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: meta === undefined ? {} : { _meta: meta } }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" });
    for (const meta of [undefined, {}, { "io.modelcontextprotocol/clientCapabilities": {} }, { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }]) {
      expect(await errorOf(await send(meta))).toMatchObject({ code: -32602 });
    }
    expect((await send(META)).status).toBe(200);
  });

  it("each header mismatch is -32020", async () => {
    const bad = await modern("tools/list", {}, { headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" } });
    expect(await errorOf(bad)).toMatchObject({ code: -32020 });
    const metaMismatch = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" });
    expect(await errorOf(metaMismatch)).toMatchObject({ code: -32020 });
    const noName = await modern("tools/call", { name: "read_message" }, { headers: { "Mcp-Name": "" } });
    expect(await errorOf(noName)).toMatchObject({ code: -32020 });
  });

  it("Mcp-Name accepts the base64 sentinel", async () => {
    const encoded = `=?base64?${new TextEncoder().encode("read_message").toBase64()}?=`;
    const res = await modern("tools/call", { name: "read_message", arguments: {} }, { headers: { "Mcp-Name": encoded } });
    // Header validation passed; what follows is the tool's own answer (unauthenticated → tool error), not -32020.
    expect(((await res.json()) as any).error?.code).not.toBe(-32020);
  });

  it("a legacy tools/call needs no Mcp-Name", async () => {
    const res = await legacy("tools/call", { name: "read_message", arguments: {} });
    expect(((await res.json()) as any).error?.code).not.toBe(-32020);
  });
});

describe("handshake", () => {
  it("server/discover reports versions, capabilities and identity, publicly cacheable", async () => {
    const res = await modern("server/discover");
    expect(((await res.json()) as any).result).toEqual({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "agent-inbox", version: expect.any(String) } },
      instructions: expect.any(String),
      ttlMs: expect.any(Number),
      cacheScope: "public",
    });
  });

  it("legacy initialize answers an unsupported requested version with our newest legacy one", async () => {
    const res = await legacy("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } }, { headers: {}, version: "2025-06-18" });
    expect(((await res.json()) as any).result.protocolVersion).toBe("2025-11-25");
  });

  it("ping is legacy-only", async () => {
    expect(((await (await legacy("ping")).json()) as any).result).toEqual({});
    expect(await errorOf(await modern("ping"))).toMatchObject({ code: -32601 });
  });

  it("tools/list is private, and empty without a credential", async () => {
    const res = await modern("tools/list");
    expect(((await res.json()) as any).result).toEqual({ resultType: "complete", tools: [], ttlMs: expect.any(Number), cacheScope: "private" });
  });
});

// Calls a tool the legacy way (no per-request headers to build) and returns the tool result.
async function call(name: string, args: Record<string, unknown>, key?: string) {
  const res = await legacy("tools/call", { name, arguments: args }, { key });
  const body = (await res.json()) as any;
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result as { structuredContent: any; content: { type: string; text: string }[]; isError?: true };
}

const names = async (key: string) => ((await (await modern("tools/list", {}, { key })).json()) as any).result.tools.map((t: any) => t.name);

const INBOX_TOOLS = ["send_mail", "reply", "reply_all", "list_messages", "read_message", "mark_unread", "delete_message", "restore_message", "list_webhooks", "create_webhook", "delete_webhook", "restore_webhook"];
const ADMIN_TOOLS = ["create_inbox", "list_inboxes", "rename_inbox", "delete_inbox", "restore_inbox", "purge_inbox", "rotate_inbox_key", "list_rejected", "list_domains"];

describe("tool surface", () => {
  it("an inbox key sees twelve tools, the admin key twenty-one, in a stable order", async () => {
    const inbox = await createInbox("agent");
    expect(await names(inbox.api_key)).toEqual(INBOX_TOOLS);
    expect(await names(ADMIN_KEY)).toEqual([...INBOX_TOOLS, ...ADMIN_TOOLS]);
    expect(await names("nope")).toEqual([]);
  });

  it("every listed tool has a schema, and `inbox` is described on exactly the seventeen with a target", async () => {
    const tools = ((await (await modern("tools/list", {}, { key: ADMIN_KEY })).json()) as any).result.tools;
    const withInbox = tools.filter((t: any) => t.inputSchema.properties?.inbox).map((t: any) => t.name);
    expect(withInbox).toEqual(INBOX_TOOLS.concat("rename_inbox", "delete_inbox", "restore_inbox", "purge_inbox", "rotate_inbox_key"));
    for (const t of tools) expect(t.inputSchema).toMatchObject({ type: "object" });
  });

  it("calling an admin tool by name with an inbox key is refused — discovery is not enforcement", async () => {
    const inbox = await createInbox("agent");
    for (const name of ["purge_inbox", "restore_inbox"]) {
      const r = await call(name, { inbox: inbox.address, confirm: true }, inbox.api_key);
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toMatch(/needs the admin key/);
    }
    const listed = (await (await api(`/admin/inboxes`, { key: ADMIN_KEY })).json()) as any;
    expect(listed.inboxes.map((i: any) => i.address)).toContain(inbox.address);
  });

  it("no credential is a tool error, not a protocol error", async () => {
    const r = await call("list_messages", {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatch(/Unauthorized/);
  });

  it("an unknown tool is -32602", async () => {
    await expect(call("nope", {}, ADMIN_KEY)).rejects.toThrow(/-32602/);
  });

  it("the admin key without `inbox` is a tool error naming the tool, and writes nothing", async () => {
    await createInbox("agent");
    const r = await call("delete_message", { id: "x" }, ADMIN_KEY);
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatch(/^delete_message: `inbox` is required with the admin key/);
  });

  it("an inbox key naming another inbox is a tool error naming its own address", async () => {
    const inbox = await createInbox("agent");
    const other = await createInbox("other");
    const r = await call("list_messages", { inbox: other.address }, inbox.api_key);
    expect(r.structuredContent).toEqual({ error: `list_messages: This key is for ${inbox.address}` });
  });

  it("a thrown error inside a tool becomes a tool error, not an HTTP 500, and is logged", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("create_inbox", { address: "boom@email.example.com" }, ADMIN_KEY);
    expect(r).toMatchObject({ isError: true, structuredContent: { error: "Internal error" } });
    expect(error).toHaveBeenCalled();
  });
});

describe("tools match their REST routes", () => {
  it("list_messages and read_message, and read marks read unless told not to", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ subject: "One", attachment: { filename: "a.txt", content: "A" } }), inbox.address);
    const rest = (await (await api("/messages", { key: inbox.api_key })).json()) as any;
    const tool = await call("list_messages", {}, inbox.api_key);
    expect(tool.structuredContent).toEqual(rest);
    expect(JSON.parse(tool.content[0].text)).toEqual(rest);

    const id = rest.messages[0].id;
    const peek = await call("read_message", { id, mark_read: false }, inbox.api_key);
    expect(peek.structuredContent.read_at).toBeNull();
    expect(peek.structuredContent.attachments[0].url).toMatch(/\/attachments\//);
    const read = await call("read_message", { id }, inbox.api_key);
    expect(read.structuredContent.read_at).toEqual(expect.any(Number));
  });

  it("mail with no Subject header: list_messages and read_message still succeed, subject null", async () => {
    const inbox = await createInbox("agent");
    await receive(
      "From: Sender <sender@example.org>\r\nTo: agent@email.example.com\r\nDate: Sat, 19 Sep 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNo subject\r\n",
      inbox.address,
    );
    const list = await call("list_messages", {}, inbox.api_key);
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent.messages[0].subject).toBeNull();

    const id = list.structuredContent.messages[0].id;
    const read = await call("read_message", { id }, inbox.api_key);
    expect(read.isError).toBeUndefined();
  });

  it("list_messages validates like the route", async () => {
    const inbox = await createInbox("agent");
    const r = await call("list_messages", { direction: "sideways" }, inbox.api_key);
    expect(r).toMatchObject({ isError: true, structuredContent: { error: "`direction` must be in, out or all" } });
  });

  it("mark_unread, delete_message, restore_message", async () => {
    const inbox = await createInbox("agent");
    await receive(eml(), inbox.address);
    const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;
    await call("read_message", { id }, inbox.api_key);
    expect((await call("mark_unread", { id }, inbox.api_key)).structuredContent).toEqual({ ok: true });
    expect((await call("delete_message", { id }, inbox.api_key)).structuredContent).toEqual({ ok: true });
    expect(await call("delete_message", { id }, inbox.api_key)).toMatchObject({ isError: true, structuredContent: { error: "Message not found" } });
    expect((await call("restore_message", { id }, inbox.api_key)).structuredContent).toEqual({ ok: true });
  });

  it("send_mail sends, replies in thread, and a refused send carries the failed row's id", async () => {
    const inbox = await createInbox("agent");
    // The EMAIL binding is swapped through app.request's env, so these go through rpc() directly.
    const send = vi.fn().mockResolvedValue({ messageId: "<m1@x>" });
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_mail", arguments: { to: "bob@example.org", subject: "Hi", text: "Hello" } } },
      { "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${inbox.api_key}` },
      { EMAIL: { send } as any },
    );
    expect(((await res.json()) as any).result.structuredContent).toEqual({ id: expect.any(String), messageId: "<m1@x>" });

    const failing = vi.fn().mockRejectedValue(Object.assign(new Error("quota"), { code: "E_DAILY_LIMIT_EXCEEDED" }));
    const failed = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_mail", arguments: { to: "bob@example.org", subject: "Hi", text: "Hello" } } },
      { "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${inbox.api_key}` },
      { EMAIL: { send: failing } as any },
    );
    expect(((await failed.json()) as any).result).toMatchObject({ isError: true, structuredContent: { id: expect.any(String), error: "E_DAILY_LIMIT_EXCEEDED" } });
  });

  it("reply and reply_all answer in the thread", async () => {
    const inbox = await createInbox("agent");
    await receive(eml({ headers: "Message-ID: <first@x.com>\r\n" }), inbox.address);
    const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;
    const send = vi.fn().mockResolvedValue({ messageId: "<r@x>" });
    for (const name of ["reply", "reply_all"]) {
      const res = await rpc(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { id, text: "Thanks" } } },
        { "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${inbox.api_key}` },
        { EMAIL: { send } as any },
      );
      expect(((await res.json()) as any).result.structuredContent).toEqual({ id: expect.any(String), messageId: "<r@x>" });
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ to: [{ email: "sender@example.org", name: "Sender" }], subject: "Re: Hello" }));
    }
  });

  it("webhooks: list, create, delete, restore", async () => {
    const inbox = await createInbox("agent");
    const created = await call("create_webhook", { url: "https://agent.example/hook", name: "Ops" }, inbox.api_key);
    expect(created.structuredContent).toEqual({ id: expect.any(String), name: "Ops", url: "https://agent.example/hook", secret: expect.any(String) });
    const id = created.structuredContent.id;
    expect((await call("list_webhooks", {}, inbox.api_key)).structuredContent.webhooks.map((w: any) => w.id)).toEqual([id]);
    expect((await call("delete_webhook", { id }, inbox.api_key)).structuredContent).toEqual({ ok: true });
    expect((await call("list_webhooks", { deleted: true }, inbox.api_key)).structuredContent.webhooks.map((w: any) => w.id)).toEqual([id]);
    expect((await call("restore_webhook", { id }, inbox.api_key)).structuredContent).toEqual({ ok: true });
    expect(await call("create_webhook", { url: "http://insecure" }, inbox.api_key)).toMatchObject({ isError: true, structuredContent: { error: "`url` must be an https:// URL" } });
  });

  it("admin: create, list, rename, rotate, delete, restore, purge, rejected, domains", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const created = await call("create_inbox", { address: "New@email.example.com", name: "New Bot" }, ADMIN_KEY);
    expect(created.structuredContent).toEqual({ id: expect.any(String), address: "new@email.example.com", name: "New Bot", api_key: expect.any(String) });
    const { id, address } = created.structuredContent;

    expect((await call("list_inboxes", {}, ADMIN_KEY)).structuredContent.inboxes.map((i: any) => i.address)).toEqual([address]);
    expect((await call("rename_inbox", { inbox: address, name: "Renamed" }, ADMIN_KEY)).structuredContent).toEqual({ id, address, name: "Renamed" });
    const rotated = await call("rotate_inbox_key", { inbox: id }, ADMIN_KEY);
    expect(rotated.structuredContent.api_key).toMatch(/^[0-9a-f]{64}$/);
    expect((await api("/messages", { key: created.structuredContent.api_key })).status).toBe(401);

    expect((await call("delete_inbox", { inbox: address }, ADMIN_KEY)).structuredContent).toEqual({ ok: true });
    expect(await call("rotate_inbox_key", { inbox: address }, ADMIN_KEY)).toMatchObject({ isError: true, structuredContent: { error: "rotate_inbox_key: Inbox not found" } });
    expect((await call("restore_inbox", { inbox: address }, ADMIN_KEY)).structuredContent).toEqual({ id, address, name: "Renamed" });
    expect(await call("restore_inbox", { inbox: address }, ADMIN_KEY)).toMatchObject({ isError: true });

    expect((await call("purge_inbox", { inbox: address }, ADMIN_KEY)).structuredContent).toEqual({ messages: 0, webhooks: 0, inbox: false });
    await call("delete_inbox", { inbox: address }, ADMIN_KEY);
    expect(await call("purge_inbox", { inbox: address }, ADMIN_KEY)).toMatchObject({ isError: true, structuredContent: { error: expect.stringMatching(/confirm/) } });
    expect((await call("purge_inbox", { inbox: address, confirm: true }, ADMIN_KEY)).structuredContent).toEqual({ messages: 0, webhooks: 0, inbox: true });

    await receive(eml(), "nobody@email.example.com");
    expect((await call("list_rejected", {}, ADMIN_KEY)).structuredContent.rejected).toHaveLength(1);
    expect((await call("list_domains", {}, ADMIN_KEY)).structuredContent).toEqual({ domains: [] });
  });

  it("an admin-key mail tool marks read like any other, and is logged", async () => {
    const inbox = await createInbox("agent");
    await receive(eml(), inbox.address);
    const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await call("read_message", { inbox: inbox.address, id }, ADMIN_KEY);
    expect(r.structuredContent.read_at).toEqual(expect.any(Number));
    expect(log).toHaveBeenCalledWith({ event: "admin_access", tool: "read_message", inbox: inbox.address, id });
  });

  it("no response carries key_hash", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const inbox = await createInbox("agent");
    await receive(eml(), inbox.address);
    const { id } = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!;

    const read = await call("read_message", { inbox: inbox.address, id }, ADMIN_KEY);
    const list = await call("list_inboxes", {}, ADMIN_KEY);
    const renamed = await call("rename_inbox", { inbox: inbox.address, name: "Renamed" }, ADMIN_KEY);
    await call("delete_inbox", { inbox: inbox.address }, ADMIN_KEY);
    const restored = await call("restore_inbox", { inbox: inbox.address }, ADMIN_KEY);
    const rest = await (await api(`/messages/${id}`, { key: inbox.api_key })).json();

    for (const body of [read.structuredContent, list.structuredContent, renamed.structuredContent, restored.structuredContent, rest]) {
      expect(JSON.stringify(body)).not.toContain("key_hash");
    }
  });
});
