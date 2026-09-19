# byagent-email

A very simple email service for AI agents, built on Cloudflare. Each agent gets its own
inbox, like `claude@example.com`, and an API key. It can send mail with attachments,
poll for received mail, and register webhooks that fire when mail arrives.

It's one Cloudflare Worker. Mail comes in through Email Routing and goes out through
Email Service. D1, R2 and Queues store the rest.

## Requirements

- One or more domains on Cloudflare DNS. A subdomain (e.g. `mail.example.com`) works too.
- The Workers Paid plan, which Email Service sending requires.
- Node.js 20+ and `npx wrangler login`.

## Setup

```bash
npm install
npm run setup -- --api api.example.com
```

The setup command:
- creates the D1 database, R2 bucket and queue,
- writes `wrangler.jsonc` (gitignored). `--api` is optional: it serves the API on that hostname as a custom domain. Leave it out to use the Worker's `workers.dev` URL,
- applies the database schema and deploys the Worker,
- generates a new `ADMIN_KEY` and saves it to `.dev.vars` (gitignored), which `wrangler dev` also uses. Load it with `source .dev.vars`.

Then, for each email domain, in the Cloudflare dashboard:

1. **Email > Email Sending > Onboard Domain**, and choose the domain. This adds the MX, SPF, DKIM and DMARC records.
2. **Email > Email Routing**: if you use a subdomain, first add it under **apex domain > Settings > Subdomains**.
3. In Email Routing's rules for the domain, set the **catch-all** rule to **Send to a Worker > byagent-email**.

Enabling Email Routing replaces the domain's MX records, so use a domain (or subdomain) that doesn't already receive mail.

### Configuration

| Name | Where | Default | |
|---|---|---|---|
| `RETENTION_DAYS` | `vars` in `wrangler.jsonc` | `0` | Received mail older than this many days is deleted daily. `0` keeps mail forever. |
| `ADMIN_KEY` | Worker secret, plus `.dev.vars` locally | set by setup | Admin API key |

To add or change the API hostname later, set `routes` in `wrangler.jsonc` to `[{ "pattern": "api.example.com", "custom_domain": true }]` and redeploy.

## Admin API

All admin calls use `Authorization: Bearer <ADMIN_KEY>`.

```bash
# Create an inbox. The api_key and webhook_secret are shown only once.
curl -X POST $URL/admin/inboxes -H "Authorization: Bearer $ADMIN_KEY" -d '{"address":"claude@example.com"}'
# → {"address":"claude@example.com","api_key":"…","webhook_secret":"…"}
```

Keep the `webhook_secret` from inbox creation. It isn't shown again.

Inboxes can be on any domain you've set up for this Worker (see Setup). The address isn't checked against your domains, so a typo creates an inbox that never receives mail. Delete it and create it again.

| Method | Path | |
|---|---|---|
| `POST` | `/admin/inboxes` | `{address}` → `{address, api_key, webhook_secret}` |
| `GET` | `/admin/inboxes` | List inboxes |
| `DELETE` | `/admin/inboxes/:address` | Delete the inbox and all its mail |
| `POST` | `/admin/inboxes/:address/rotate-key` | Returns a new `api_key` |

## Agent API

All agent calls use `Authorization: Bearer <api_key>`.

| Method | Path | |
|---|---|---|
| `POST` | `/send` | `{to, cc?, bcc?, subject, text?, html?, attachments?: [{filename, type, content (base64)}]}` → `{messageId}` |
| `GET` | `/messages?unread=true&since=<unix ms>` | List messages (newest first; with `since`, oldest first so you can page forward). Max 100. |
| `GET` | `/messages/:id` | Full message: text, html, attachment list |
| `GET` | `/messages/:id/attachments/:index` | Download an attachment |
| `POST` | `/messages/:id/read` | Mark read |
| `DELETE` | `/messages/:id` | Delete |
| `GET` / `POST` / `DELETE` | `/webhooks[/:id]` | List, add (`{url}`, https only), remove |

Send limits come from Cloudflare: 5 MiB per message, 32 attachments, 50 recipients.

A received message's `from` comes from its headers and isn't verified, so don't treat it as proof of who sent it.

## Webhooks

When mail arrives, each of the inbox's webhooks gets a `POST`:

```json
{ "inbox": "claude@example.com",
  "message": { "id": "…", "from": "…", "to": ["…"], "subject": "…", "date": "…", "text": "…",
               "attachments": [{ "index": 0, "filename": "a.pdf", "type": "application/pdf", "size": 1234 }] } }
```

To verify a webhook, compute `HMAC-SHA256(webhook_secret, X-Timestamp + "." + rawBody)` as
hex and compare it with the `X-Signature` header (`sha256=<hex>`). Reject old timestamps.
A non-2xx response is retried with backoff, up to 5 attempts in total. You can always fall back to polling.

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
npm run types     # regenerate worker-configuration.d.ts after changing bindings
```
