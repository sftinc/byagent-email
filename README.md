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
| [Webhooks](docs/webhooks.md) | Push instead of polling, payload and signature |
| [Concepts](docs/concepts.md) | IDs, timestamps, deleting and purging, storage, limits |

## Setup

You need a domain on Cloudflare DNS (a subdomain like `mail.example.com` works too), the
Workers Paid plan, which Email Service sending requires, and Node.js 20+.

1. **Clone and install.**

   ```bash
   git clone https://github.com/sftinc/cfloudflare-agent-inbox
   cd cfloudflare-agent-inbox
   npm install
   ```

2. **Log in to Cloudflare.**

   ```bash
   npx wrangler login
   ```

3. **Deploy.** The hostname is optional; without it the API is served on a `workers.dev` URL.

   ```bash
   npm run setup api.example.com
   ```

   This creates the D1 database, R2 bucket and queue, applies the schema, deploys the Worker,
   and writes `ADMIN_KEY` and `API_URL` to `.dev.vars` (gitignored). It's safe to re-run.

4. **Point each email domain at the Worker**, in the Cloudflare dashboard:

   - **Email > Email Sending > Onboard Domain**, and choose the domain.
   - Using a subdomain? Add it first under **apex domain > Settings > Subdomains**.
   - In **Email Routing**'s rules for the domain, set the **catch-all** rule to
     **Send to a Worker > agent-inbox**.

   Email Routing replaces the domain's MX records, so use one that doesn't already receive mail.

5. **Create the first inbox.**

   ```bash
   source .dev.vars
   curl -X POST $API_URL/admin/inboxes -H "Authorization: Bearer $ADMIN_KEY" \
     -d '{"address":"claude@example.com","name":"Claude"}'
   ```

   The `api_key` it returns is shown only once. That's what the agent authenticates with.

6. **Check it works.** Send yourself a message, reply to it from your own mail, then confirm
   the reply arrives.

   ```bash
   export API_KEY=…          # the api_key from step 5
   curl -X POST $API_URL/send -H "Authorization: Bearer $API_KEY" \
     -d '{"to":"you@example.com","subject":"Hello","text":"Testing."}'
   curl "$API_URL/messages?unread=true" -H "Authorization: Bearer $API_KEY"
   ```

The details — what setup writes, re-running it, `RETENTION_DAYS`, changing the API hostname —
are in [Setup](docs/setup.md). Or have a coding agent such as Claude Code do all of it:

```text
Set up Cloudflare Agent Inbox for me: https://github.com/sftinc/cfloudflare-agent-inbox

1. Clone the repo and read its README and docs/setup.md.
2. Ask me whether I want the API on a custom hostname (e.g. api.example.com).
3. Check that I'm logged in with `npx wrangler whoami`. If not, ask me to run `npx wrangler login`.
4. Run `npm install`, then `npm run setup` (add the hostname if I gave one: `npm run setup api.example.com`).
5. Ask me which domain(s) to receive mail on. Walk me through the dashboard steps for each one, and wait until I say they're done.
6. Ask me what to call the first inbox, then create it with the admin API, using ADMIN_KEY from .dev.vars. Save its api_key to .dev.vars.
7. Send a test email from the inbox to an address I give you. Ask me to reply, then check that the reply shows up in GET /messages.
8. Finish by telling me the API URL (also saved in .dev.vars as API_URL), the inbox address, where its key is saved, and that agents using it should read docs/agent-api.md.

Never print or commit any keys.
```

## Giving an inbox to an agent

Create the inbox with the [Admin API](docs/admin-api.md), then hand the agent its address, its key and
[docs/agent-api.md](docs/agent-api.md). Or paste this into a coding agent, in the repo:

```text
Give me an email inbox with Cloudflare Agent Inbox, in this repo.

1. Find the API URL: API_URL in .dev.vars, written by setup. If it is missing, run `npm run deploy` and take the URL it prints (a custom domain if wrangler.jsonc has one, otherwise the workers.dev URL Cloudflare generated). Confirm with `curl $URL/health`, which returns {"ok":true}.
2. Read ADMIN_KEY from .dev.vars (gitignored). If it isn't there, tell me, and don't continue. Never print it.
3. Ask me for the inbox address (name@domain, on a domain already set up for this Worker: see `GET /admin/inboxes` for ones in use) and an optional display name for outgoing mail.
4. Create it: POST $URL/admin/inboxes with {"address":"…","name":"…"} and the admin key. Append the api_key it returns to .dev.vars as <INBOX>_EMAIL_KEY. It is shown only once, so don't lose it and don't print it.
5. Check it works: send a short test message from the inbox to an address I give you, then confirm GET /messages?direction=out lists it.
6. Print a brief I can paste into the agent that will use this inbox, filled in with the real address, URL and variable name — never the key itself:

   You have an email inbox: <address>.
   - The API is at <url>. Your key is in .dev.vars, as <INBOX>_EMAIL_KEY: read it from there, and never print it.
   - Authenticate every call with: Authorization: Bearer $<INBOX>_EMAIL_KEY
   - Read docs/agent-api.md for how to send, list, read and reply.
   Check for new mail with GET /messages?unread=true. Reading a message marks it read.
   Reply with POST /send using reply_to_id so it stays in the thread.
```

## The API in brief

Admin calls use `ADMIN_KEY`; agent calls use an inbox's `api_key`.

| Method | Path | |
|---|---|---|
| `POST` | `/send` | Send mail, to named or plain addresses, optionally as a threaded reply |
| `GET` | `/messages` | List, filter and page through mail |
| `GET` | `/messages/:id` | Read one in full; marks it read |
| `GET` | `/messages/:id/attachments/:index` | Download an attachment |
| `POST` | `/messages/:id/unread` | Put it back in the unread list |
| `DELETE` / `POST` | `/messages/:id`, `/messages/:id/restore` | Delete, undo |
| `GET` / `POST` / `DELETE` | `/webhooks[/:id]` | Manage webhooks (`{url, name?}`) |
| `POST` / `GET` | `/admin/inboxes` | Create, list inboxes |
| `PATCH` / `DELETE` / `POST` | `/admin/inboxes/:id[/restore\|/purge\|/rotate-key]` | Rename, delete, restore, purge, rotate |
| `GET` | `/health` | No key needed |

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
```
