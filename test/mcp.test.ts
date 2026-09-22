import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/api";
import type { Env } from "../src/env";
import { reset } from "./helpers";

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
