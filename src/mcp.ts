import { type Context, Hono } from "hono";
import { authenticate, bearer, resolveInbox } from "./auth";
import type { Env, Inbox, Result } from "./env";
import { TOOLS } from "./tools";

// POST /mcp: stateless Streamable HTTP, JSON in and JSON out, no sessions and no SSE. Serves the
// current protocol revision and the two before it, which differ in the handshake and in which
// headers a request must carry — so the era is decided first and only that era's rules apply.
export const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18"];
export const VERSIONS = [MODERN, ...LEGACY];

const SERVER_INFO = { name: "agent-inbox", version: "1" };
const INSTRUCTIONS =
  "An email inbox for agents. Mail tools act on the inbox your key belongs to; with the admin key, " +
  "pass `inbox` (an address or an id) on every mail tool. Attachments are fetched from the `url` on " +
  "a read message; links expire after 15 minutes, so read the message again for a fresh one.";

type Rpc = { jsonrpc: string; id?: unknown; method: string; params?: Record<string, any> };
type Ctx = Context<{ Bindings: Env }>;

const rpcResult = (c: Ctx, id: unknown, result: unknown) => c.json({ jsonrpc: "2.0", id, result });
const rpcError = (c: Ctx, id: unknown, code: number, message: string, status: 400 | 404, data?: unknown) =>
  c.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined && { data }) } }, status);

// A header value, with the spec's `=?base64?…?=` sentinel decoded. Garbage decodes to nothing.
function decodeHeader(value: string | undefined): string | undefined {
  const m = value?.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return value;
  try {
    return new TextDecoder().decode(Uint8Array.fromBase64(m[1]));
  } catch {
    return undefined;
  }
}

function toolResult(result: Result<unknown>) {
  const body = result.ok ? result.data : { ...(result.data as object | undefined), error: result.error };
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    ...(result.ok ? {} : { isError: true }),
  };
}

const toolError = (status: number, error: string) => toolResult({ ok: false, status, error });

export const mcp = new Hono<{ Bindings: Env }>();

mcp.on(["GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"], "/", (c) => c.json({ error: "Method not allowed" }, 405));

mcp.post("/", async (c) => {
  // DNS-rebinding guard from the transport spec: a browser's Origin must be our own.
  const origin = c.req.header("Origin");
  if (origin !== undefined && origin !== new URL(c.req.url).origin) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<Rpc>().catch(() => null);
  if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(c, null, -32600, "Invalid Request", 400);
  }
  const { id, method } = body;
  const params = body.params && typeof body.params === "object" ? body.params : {};

  // The era: the header decides; the method only breaks a tie when there is no header.
  const version = c.req.header("MCP-Protocol-Version");
  let era: "modern" | "legacy";
  if (version === MODERN) era = "modern";
  else if (version !== undefined && LEGACY.includes(version)) era = "legacy";
  else if (version !== undefined) return rpcError(c, id, -32022, "Unsupported protocol version", 400, { supported: VERSIONS, requested: version });
  else if (method === "initialize") era = "legacy";
  else return rpcError(c, id, -32020, "Missing MCP-Protocol-Version header", 400);

  if (era === "modern") {
    const meta = params._meta;
    const capabilities = meta?.["io.modelcontextprotocol/clientCapabilities"];
    if (!meta || typeof meta !== "object" || typeof meta["io.modelcontextprotocol/protocolVersion"] !== "string" || !capabilities || typeof capabilities !== "object") {
      return rpcError(c, id, -32602, "`_meta` must carry io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities", 400);
    }
    if (meta["io.modelcontextprotocol/protocolVersion"] !== version) {
      return rpcError(c, id, -32020, "MCP-Protocol-Version header does not match _meta", 400);
    }
    if (decodeHeader(c.req.header("Mcp-Method")) !== method) return rpcError(c, id, -32020, "Mcp-Method header is missing or does not match method", 400);
    if (method === "tools/call" && decodeHeader(c.req.header("Mcp-Name")) !== params.name) {
      return rpcError(c, id, -32020, "Mcp-Name header is missing or does not match params.name", 400);
    }
  }

  if (id === undefined) return c.body(null, 202); // a notification: accepted, nothing to say

  switch (method) {
    case "server/discover":
      if (era === "modern") return rpcResult(c, id, discover());
      break;
    case "initialize":
      if (era === "legacy") return rpcResult(c, id, initialize(params));
      break;
    case "ping":
      if (era === "legacy") return rpcResult(c, id, {}); // removed in 2026-07-28
      break;
    case "tools/list":
      return rpcResult(c, id, await listTools(c));
    case "tools/call":
      return callTool(c, id, params);
  }
  return rpcError(c, id, -32601, `Method not found: ${method}`, 404);
});

function discover() {
  return {
    resultType: "complete",
    supportedVersions: VERSIONS,
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    instructions: INSTRUCTIONS,
    ttlMs: 3600_000,
    cacheScope: "public", // the same for every caller; tools/list is what varies
  };
}

function initialize(params: Record<string, any>) {
  const requested = params.protocolVersion;
  return {
    protocolVersion: LEGACY.includes(requested) ? requested : LEGACY[0],
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

// Only what the credential can call. Private, because the list differs by credential and a shared
// cache must not hand an admin's list to an inbox key. Discovery, not enforcement: callTool checks again.
async function listTools(c: Ctx) {
  const principal = await authenticate(c.env, bearer(c.req.header("Authorization")));
  const visible = TOOLS.filter((t) => principal !== null && (!t.admin || principal.kind === "admin"));
  return {
    resultType: "complete",
    tools: visible.map(({ name, description, inputSchema, outputSchema }) => ({
      name,
      description,
      inputSchema,
      ...(outputSchema && { outputSchema }),
    })),
    ttlMs: 300_000,
    cacheScope: "private",
  };
}

// Authenticate the principal, authorize the operation, then resolve the target: in that order,
// because collapsing them is how an authorization hole gets in.
async function callTool(c: Ctx, id: unknown, params: Record<string, any>) {
  if (typeof params.name !== "string") return rpcError(c, id, -32602, "`params.name` is required", 400);
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return rpcError(c, id, -32602, `Unknown tool: ${params.name}`, 400);
  const args: Record<string, unknown> = params.arguments && typeof params.arguments === "object" ? params.arguments : {};

  const principal = await authenticate(c.env, bearer(c.req.header("Authorization")));
  if (!principal) return rpcResult(c, id, toolError(401, "Unauthorized: send an inbox key or the admin key as `Authorization: Bearer`"));
  if (tool.admin && principal.kind !== "admin") return rpcResult(c, id, toolError(403, `${tool.name} needs the admin key`));

  let inbox: Inbox | null = null;
  if (tool.policy) {
    const resolved = await resolveInbox(c.env, principal, typeof args.inbox === "string" ? args.inbox : undefined, tool.policy);
    if (!resolved.ok) return rpcResult(c, id, toolError(resolved.status, `${tool.name}: ${resolved.error}`));
    inbox = resolved.data;
    if (principal.kind === "admin") {
      console.log({ event: "admin_access", tool: tool.name, inbox: inbox.address, ...(typeof args.id === "string" && { messageId: args.id }) });
    }
  }
  return rpcResult(c, id, toolResult(await tool.run(c.env, inbox as Inbox, args)));
}
