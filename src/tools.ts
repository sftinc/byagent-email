import type { Policy } from "./auth";
import type { Env, Inbox, Result } from "./env";

// One MCP tool: a schema and a thin wrapper over one shared operation. `admin` tools are for the
// admin principal only. `policy` means the tool acts on an inbox, found under that state policy
// from the `inbox` argument (or the caller's own inbox); absent means the tool has no target.
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  admin?: true;
  policy?: Policy;
  run: (env: Env, inbox: Inbox, args: Record<string, unknown>) => Promise<Result<unknown>>;
}

export const TOOLS: Tool[] = [];
