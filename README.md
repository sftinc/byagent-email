# byagent-email

A very simple email service for AI agents, built on Cloudflare. Each agent gets its own
inbox, like `claude@example.com`, and an API key. It can send mail with attachments,
poll for received and sent mail, and register webhooks that fire when mail arrives.

It's one Cloudflare Worker. Mail comes in through Email Routing and goes out through
Email Service. D1, R2 and Queues store the rest.

## Docs

| | |
|---|---|
| [Setup](docs/setup.md) | Deploying it, the Cloudflare dashboard steps, configuration |
| [Admin API](docs/admin-api.md) | Creating and managing inboxes and their keys |
| [Agent API](docs/agent-api.md) | Sending, reading, replying: the file to give your agent |
| [Webhooks](docs/webhooks.md) | Push instead of polling, payload and signature |
| [Concepts](docs/concepts.md) | IDs, timestamps, deleting and purging, storage, limits |

## Setup

```bash
npm install
npm run setup api.example.com     # hostname optional; without it you get a workers.dev URL
```

Then point each email domain at the Worker in the Cloudflare dashboard. Both steps are in
[Setup](docs/setup.md). Or paste this into a coding agent such as Claude Code:

```text
Set up byagent-email for me: https://github.com/sftinc/byagent-email

1. Clone the repo and read its README and docs/setup.md.
2. Ask me whether I want the API on a custom hostname (e.g. api.example.com).
3. Check that I'm logged in with `npx wrangler whoami`. If not, ask me to run `npx wrangler login`.
4. Run `npm install`, then `npm run setup` (add the hostname if I gave one: `npm run setup api.example.com`).
5. Ask me which domain(s) to receive mail on. Walk me through the dashboard steps for each one, and wait until I say they're done.
6. Ask me what to call the first inbox, then create it with the admin API, using ADMIN_KEY from .dev.vars. Save its api_key to .dev.vars.
7. Send a test email from the inbox to an address I give you. Ask me to reply, then check that the reply shows up in GET /messages.
8. Finish by telling me the API URL, the inbox address, where its key is saved, and that agents using it should read docs/agent-api.md.

Never print or commit any keys.
```

## Giving an inbox to an agent

Create an inbox with the [Admin API](docs/admin-api.md), then hand the agent its address, its key and
[docs/agent-api.md](docs/agent-api.md). Something like:

```text
You have an email inbox: claude@example.com.

- The API is at https://api.example.com, and your key is in EMAIL_API_KEY.
- Authenticate every call with: Authorization: Bearer <key>
- Read docs/agent-api.md for how to send, list, read and reply.

Check for new mail with GET /messages?unread=true. Reading a message marks it read.
Reply with POST /send using reply_to_id so it stays in the thread.
```

## The API in brief

Admin calls use `ADMIN_KEY`; agent calls use an inbox's `api_key`.

| Method | Path | |
|---|---|---|
| `POST` | `/send` | Send mail, optionally as a threaded reply |
| `GET` | `/messages` | List, filter and page through mail |
| `GET` | `/messages/:id` | Read one in full; marks it read |
| `GET` | `/messages/:id/attachments/:index` | Download an attachment |
| `POST` | `/messages/:id/unread` | Put it back in the unread list |
| `DELETE` / `POST` | `/messages/:id`, `/messages/:id/restore` | Delete, undo |
| `GET` / `POST` / `DELETE` | `/webhooks[/:id]` | Manage webhooks |
| `POST` / `GET` | `/admin/inboxes` | Create, list inboxes |
| `PATCH` / `DELETE` / `POST` | `/admin/inboxes/:id[/restore\|/purge\|/rotate-key]` | Rename, delete, restore, purge, rotate |
| `GET` | `/health` | No key needed |

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
```
