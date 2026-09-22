# Cloudflare Agent Inbox

A very simple email service for AI agents, built on Cloudflare. Each agent gets its own
inbox, like `claude@example.com`, and an API key. It can send mail with attachments,
poll for received and sent mail, and register webhooks that fire when mail arrives.

It's a free alternative to [AgentMail](https://agentmail.to) and the other hosted agent
inbox services: the same idea — an inbox the agent owns, created over an API, no human
OAuth — except it runs in your own Cloudflare account, on your own domain, with no
per-inbox or per-message fee.

It's one Cloudflare Worker. Mail comes in through Email Routing and goes out through
Email Service. D1, R2 and Queues store the rest.

## Docs

| | |
|---|---|
| [Setup](docs/setup.md) | Deploying it, the Cloudflare dashboard steps, configuration |
| [Admin API](docs/admin-api.md) | Creating and managing inboxes and their keys |
| [Agent API](docs/agent-api.md) | Sending, reading, replying: the file to give your agent |
| [MCP](docs/mcp.md) | The inbox as tools, for Claude Code, Cursor and any MCP client |
| [Webhooks](docs/webhooks.md) | Push instead of polling, payload and signature |
| [Concepts](docs/concepts.md) | IDs, timestamps, deleting and purging, storage, limits |

## Deploy the Worker

You need a domain on Cloudflare DNS (a subdomain like `mail.example.com` works too), the
Workers Paid plan, which Email Service sending requires, and Node.js 20+.

```bash
git clone https://github.com/sftinc/cfloudflare-agent-inbox
cd cfloudflare-agent-inbox && npm install
npx wrangler login
npm run setup <api hostname>      # hostname optional; without it you get a workers.dev URL
```

Setup creates the D1 database, R2 bucket and queues, deploys the Worker, and writes `ADMIN_KEY`,
`LINK_KEY` and `API_URL` to `.dev.vars` (gitignored). It's safe to re-run.

Then point each email domain at the Worker, in the Cloudflare dashboard:

- **Email > Email Sending > Onboard Domain**, and choose the domain.
- Using a subdomain? Add it first under **apex domain > Settings > Subdomains**.
- In **Email Routing**'s rules for the domain, set the **catch-all** rule to
  **Send to a Worker > agent-inbox**.

Email Routing replaces the domain's MX records, so use one that doesn't already receive mail.
The rest — re-running setup, `RETENTION_DAYS`, changing the API hostname — is in
[Setup](docs/setup.md).

## Deploy it with an agent

Or have a coding agent such as Claude Code do all of the above. Paste this:

```text
Set up Cloudflare Agent Inbox for me: https://github.com/sftinc/cfloudflare-agent-inbox

1. Clone it and follow docs/setup.md.

2. Ask me what you need from me: whether I want a custom API hostname, and which
   domain(s) will receive mail. Walk me through the dashboard steps for each domain,
   and wait until I say they're done.

3. When you're done, tell me the API URL and give me a link to .dev.vars, which holds
   it as API_URL along with ADMIN_KEY. Never commit that file.
```

## Give an agent an inbox

`<api url>` and `<admin key>` are `API_URL` and `ADMIN_KEY` in `.dev.vars`
(`source .dev.vars && echo $API_URL $ADMIN_KEY`). `<address>` is any address on a domain you
set up above, and `<name>` is the display name its mail goes out as — `Claude
<claude@example.com>`.

### Over MCP

For Claude Code:

```bash
claude mcp add --transport http inbox <api url>/mcp \
  --header "Authorization: Bearer <admin key>"
```

The agent can then create its own inbox with the `create_inbox` tool. This connection reaches
every inbox. For an agent that should see only its own, connect with that inbox's `api_key`
instead ([MCP](docs/mcp.md#which-key-to-give-an-agent), which also covers Cursor and other
clients).

### Over the API

Fill in the four blanks and paste this into any agent. It needs nothing else — no repo, no
files, no secret store.

```text
You have an email inbox at <address>, sending as <name>.
The API is at <api url>, and the admin key is <admin key>.

1. Create the inbox, following
   https://raw.githubusercontent.com/sftinc/cfloudflare-agent-inbox/main/docs/admin-api.md
   Keep the api_key it returns. It is shown once, and it is what you authenticate with
   from now on.

2. Read https://raw.githubusercontent.com/sftinc/cfloudflare-agent-inbox/main/docs/agent-api.md
   for how to send, list, read and reply.

3. Send me a test message at <your address>.
```

## The API in brief

Admin calls use `ADMIN_KEY`; agent calls use an inbox's `api_key`.

| Method | Path | |
|---|---|---|
| `POST` | `/send` | Send mail, to named or plain addresses, optionally as a threaded reply |
| `GET` | `/messages` | List, filter and page through mail |
| `GET` | `/messages/:id` | Read one in full; marks it read |
| `GET` | `/attachments/:token` | Fetch an attachment by its link; no key needed |
| `POST` | `/messages/:id/unread` | Put it back in the unread list |
| `DELETE` / `POST` | `/messages/:id`, `/messages/:id/restore` | Delete, undo |
| `GET` / `POST` / `DELETE` | `/webhooks[/:id]` | Manage webhooks (`{url, name?, bearer?}`) |
| `POST` / `GET` | `/admin/inboxes` | Create, list inboxes |
| `PATCH` / `DELETE` / `POST` | `/admin/inboxes/:id[/restore\|/purge\|/rotate-key]` | Rename, delete, restore, purge, rotate |
| `POST` | `/mcp` | The MCP endpoint — [MCP](docs/mcp.md) |
| `GET` | `/health` | No key needed |

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
```
