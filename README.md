# byagent-email

A very simple email service for AI agents, built on Cloudflare. Each agent gets its own
inbox, like `claude@email.example.com`, and an API key. It can send mail with attachments,
poll for received mail, and register webhooks that fire when mail arrives.

It's one Cloudflare Worker. Mail comes in through Email Routing and goes out through
Email Service. D1, R2 and Queues store the rest.

## Requirements

- A domain on Cloudflare DNS. A subdomain such as `email.example.com` works well.
- The Workers Paid plan, which Email Service sending requires.
- Node.js 20+ and `npx wrangler login`.

## Setup

```bash
npm install
npm run setup -- email.example.com
```

The setup command:
- creates the D1 database, R2 bucket and queue,
- writes `wrangler.jsonc` (gitignored),
- applies the database schema and deploys the Worker,
- prints a new `ADMIN_KEY`.

Then, in the Cloudflare dashboard:

1. **Email > Email Sending > Onboard Domain**, and choose your email domain. This adds the MX, SPF, DKIM and DMARC records.
2. **Email > Email Routing**: if your email domain is a subdomain, open the **apex domain > Settings > Subdomains** and add it. This adds the MX records it needs to receive mail.
3. In Email Routing's rules for your email domain, set the **catch-all** rule to **Send to a Worker > byagent-email**.

### Configuration

| Name | Where | Default | |
|---|---|---|---|
| `DOMAIN` | `vars` in `wrangler.jsonc` | set by setup | Email domain for inboxes |
| `RETENTION_DAYS` | `vars` in `wrangler.jsonc` | `7` | Received mail older than this is deleted daily |
| `ADMIN_KEY` | `wrangler secret put ADMIN_KEY` | set by setup | Admin API key |

The API is served on the Worker's `workers.dev` URL. Add a custom domain in the dashboard if you want one.

## Admin API

All admin calls use `Authorization: Bearer <ADMIN_KEY>`.

```bash
# Create an inbox. The api_key is shown only once.
curl -X POST $URL/admin/inboxes -H "Authorization: Bearer $ADMIN_KEY" -d '{"name":"claude"}'
# → {"address":"claude@email.example.com","api_key":"…","webhook_secret":"…"}
```

| Method | Path | |
|---|---|---|
| `POST` | `/admin/inboxes` | `{name}` → `{address, api_key, webhook_secret}` |
| `GET` | `/admin/inboxes` | List inboxes |
| `DELETE` | `/admin/inboxes/:address` | Delete the inbox and all its mail |
| `POST` | `/admin/inboxes/:address/rotate-key` | Returns a new `api_key` |

## Agent API

All agent calls use `Authorization: Bearer <api_key>`.

| Method | Path | |
|---|---|---|
| `POST` | `/send` | `{to, cc?, bcc?, subject, text?, html?, attachments?: [{filename, type, content (base64)}]}` → `{messageId}` |
| `GET` | `/messages?unread=true&since=<unix ms>` | List messages, newest first (max 100) |
| `GET` | `/messages/:id` | Full message: text, html, attachment list |
| `GET` | `/messages/:id/attachments/:index` | Download an attachment |
| `POST` | `/messages/:id/read` | Mark read |
| `DELETE` | `/messages/:id` | Delete |
| `GET` / `POST` / `DELETE` | `/webhooks[/:id]` | List, add (`{url}`, https only), remove |

Send limits come from Cloudflare: 5 MiB per message, 32 attachments, 50 recipients.

## Webhooks

When mail arrives, each of the inbox's webhooks gets a `POST`:

```json
{ "inbox": "claude@email.example.com",
  "message": { "id": "…", "from": "…", "to": ["…"], "subject": "…", "date": "…", "text": "…",
               "attachments": [{ "index": 0, "filename": "a.pdf", "type": "application/pdf", "size": 1234 }] } }
```

To verify a webhook, compute `HMAC-SHA256(webhook_secret, X-Timestamp + "." + rawBody)` as
hex and compare it with the `X-Signature` header (`sha256=<hex>`). Reject old timestamps.
A non-2xx response is retried up to 5 times with backoff. You can always fall back to polling.

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
npm run types     # regenerate worker-configuration.d.ts after changing bindings
```
