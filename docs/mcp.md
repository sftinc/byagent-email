# MCP

The same inbox as a set of tools, for any client that speaks the Model Context Protocol. One
endpoint, `POST /mcp`, on the same URL as the REST API.

## Connect

Every client configures the same two things: the URL, and one key in the `Authorization` header.
Which key you paste decides what the connection can do. `<api url>` is `API_URL` in `.dev.vars`.

| Key | Tools | Reaches |
|---|---|---|
| An inbox's `api_key` | the 10 mail and webhook tools | that inbox only |
| `ADMIN_KEY` | those 10, plus 9 inbox-management tools | any inbox, named by `inbox` on each call that acts on one |

Claude Code:

```bash
claude mcp add --transport http inbox <api url>/mcp \
  --header "Authorization: Bearer <api key>"
```

Cursor, in `mcp.json`:

```json
{ "mcpServers": { "inbox": { "url": "<api url>/mcp",
                             "headers": { "Authorization": "Bearer <api key>" } } } }
```

Clients that only speak OAuth (Claude Desktop) can reach it through
`mcp-remote` with the same header. The server speaks the current protocol revision (`2026-07-28`)
and the two before it (`2025-11-25`, `2025-06-18`).

## Which key to give an agent

**One agent, one inbox: give it that inbox's key.** The connection is sealed — nothing the agent
can name reaches another inbox, and `inbox` can be left off every call.

**Several agents sharing one connection: that connection needs the admin key**, and then every
agent on it can name any inbox. That is not something the server can prevent: it sees one
connection and cannot tell the agents apart, and any label an agent passes is a claim, not a
credential. Agents that read untrusted mail — which is all of them — are the classic target for a
message that tries to talk them into acting on a mailbox that isn't theirs.

So: agents that must be isolated from each other get their own connection with their own key, and
the admin key lives in a configuration your agents don't load. Every admin-key call that acts on an
inbox is logged (`{"event":"admin_access",…}`), so there is a trail either way.

## The `inbox` argument

Every tool that acts on an inbox takes `inbox`: an address or an inbox id.

- With an inbox key it is optional and defaults to that inbox. Naming a different one is an error
  that says which inbox the key is for.
- With the admin key it is required. There is no default to fall back on, so a call without it is
  refused rather than guessed.

Four tools have no target and take no `inbox`: `create_inbox`, `list_inboxes`, `list_rejected`,
`list_domains`.

## Tools

Inbox tools — an inbox key, or the admin key with `inbox`:

| Tool | Arguments | |
|---|---|---|
| `send_mail` | `to`, `cc`, `bcc`, `subject`, `text`, `html`, `attachments`, `reply_to_id` | Same body as [`POST /send`](agent-api.md#send) |
| `list_messages` | `direction`, `unread`, `from`, `to`, `subject`, `deleted`, `before`, `after` | Same filters as [`GET /messages`](agent-api.md#list-messages) |
| `read_message` | `id`, `mark_read` | Marks read unless `mark_read: false` |
| `mark_unread` | `id` | |
| `delete_message` / `restore_message` | `id` | |
| `list_webhooks` | `deleted` | |
| `create_webhook` | `url`, `name`, `bearer` | Returns the `secret` once |
| `delete_webhook` / `restore_webhook` | `id` | |

Admin tools — the admin key only:

| Tool | Arguments | |
|---|---|---|
| `create_inbox` | `address`, `name` | Returns the `api_key` once |
| `list_inboxes` | `deleted` | |
| `rename_inbox` | `inbox`, `name` | |
| `delete_inbox` / `restore_inbox` | `inbox` | |
| `purge_inbox` | `inbox`, `confirm` | **Permanent.** `confirm: true` to remove a deleted inbox entirely |
| `rotate_inbox_key` | `inbox` | Cuts off the running agent and revokes its attachment links |
| `list_rejected` | — | |
| `list_domains` | — | |

Each tool returns the same JSON its REST route does, as `structuredContent` and as text. A
validation failure, a missing message, a refused send — anything the route would answer 4xx or 5xx —
comes back as a tool error (`isError: true`) with the same message, so the model can correct and
retry. A refused send still carries the `id` of the row that records it.

## Attachments

No tool returns attachment bytes. A read message carries a `url` on each attachment, good for
fifteen minutes and needing no key. See [Attachment links](concepts.md#attachment-links).

## Errors from the transport

| | |
|---|---|
| `400`, code `-32600` | The body isn't a JSON-RPC 2.0 request |
| `400`, code `-32020` | A required header is missing, or disagrees with the body |
| `400`, code `-32022` | A protocol version we don't speak; `data.supported` lists what we do |
| `400`, code `-32602` | Malformed `_meta`, an unknown tool, or a `tools/call` with no `name` |
| `404`, code `-32601` | Unknown method, or one this revision doesn't have (`initialize` on `2026-07-28`, `ping` on it too) |
| `405` | Anything but `POST` |
