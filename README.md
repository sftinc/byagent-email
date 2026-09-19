# byagent-email

A very simple email service for AI agents, built on Cloudflare. Each agent gets its own
inbox, like `claude@example.com`, and an API key. It can send mail with attachments,
poll for received and sent mail, and register webhooks that fire when mail arrives.

It's one Cloudflare Worker. Mail comes in through Email Routing and goes out through
Email Service. D1, R2 and Queues store the rest.

## Requirements

- One or more domains on Cloudflare DNS. A subdomain (e.g. `mail.example.com`) works too.
- The Workers Paid plan, which Email Service sending requires.
- Node.js 20+ and `npx wrangler login`.

## Setup with an agent

Paste this into a coding agent such as Claude Code:

```text
Set up byagent-email for me: https://github.com/sftinc/byagent-email

1. Clone the repo and read its README.
2. Ask me whether I want the API on a custom hostname (e.g. api.example.com).
3. Check that I'm logged in with `npx wrangler whoami`. If not, ask me to run `npx wrangler login`.
4. Run `npm install`, then `npm run setup` (add the hostname if I gave one: `npm run setup api.example.com`).
5. Ask me which domain(s) to receive mail on. Walk me through the README's dashboard steps for each one, and wait until I say they're done.
6. Create a test inbox with the admin API, using ADMIN_KEY from .dev.vars. Save its api_key to .dev.vars.
7. Send a test email from the inbox to an address I give you. Ask me to reply, then check that the reply shows up in GET /messages.

Never print or commit any keys.
```

## Setup

```bash
npm install
npm run setup api.example.com
```

The setup command:
- creates the D1 database, R2 bucket and queue,
- writes `wrangler.jsonc` (gitignored). The hostname is optional: it serves the API on that hostname as a custom domain. Leave it out to use the Worker's `workers.dev` URL,
- applies the database schema and deploys the Worker,
- generates an `ADMIN_KEY` and saves it to `.dev.vars` (gitignored), which `wrangler dev` also uses. Load it with `source .dev.vars`.

Setup is safe to re-run. It keeps existing resources, data and the `ADMIN_KEY` in `.dev.vars`. To rotate the admin key, delete that line and re-run. After pulling updates, re-run it to apply any new database migrations and redeploy.

Then, for each email domain, in the Cloudflare dashboard:

1. **Email > Email Sending > Onboard Domain**, and choose the domain. This adds the MX, SPF, DKIM and DMARC records.
2. **Email > Email Routing**: if you use a subdomain, first add it under **apex domain > Settings > Subdomains**.
3. In Email Routing's rules for the domain, set the **catch-all** rule to **Send to a Worker > byagent-email**.

Enabling Email Routing replaces the domain's MX records, so use a domain (or subdomain) that doesn't already receive mail.

### Configuration

| Name | Where | Default | |
|---|---|---|---|
| `RETENTION_DAYS` | `vars` in `wrangler.jsonc` | `0` | Mail (received and sent) older than this many days is deleted daily (a soft delete, see below). `0` never deletes it. |
| `ADMIN_KEY` | Worker secret, plus `.dev.vars` locally | set by setup | Admin API key |

To add or change the API hostname later, set `routes` in `wrangler.jsonc` to `[{ "pattern": "api.example.com", "custom_domain": true }]` and redeploy.

Deletes are soft everywhere: a deleted inbox, webhook or message disappears from the lists, but its
database row and stored mail are kept. Pass `deleted=true` to a list to see deleted items instead,
each with its `deleted_at`, and restore any of them with its `restore` route. Deleting an inbox marks
only the inbox: its mail and webhooks come back untouched when it is restored, so an address is never
reused for a second inbox.

Purge is the one permanent operation, and the only thing that frees storage. For a live inbox it
removes what is already deleted, and nothing in use. For a deleted inbox it removes the inbox itself
with all of its mail, files and webhooks, which needs `?confirm=true` and frees the address.

## Admin API

All admin calls use `Authorization: Bearer <ADMIN_KEY>`.

```bash
# Create an inbox. name is optional. The api_key is shown only once.
curl -X POST $URL/admin/inboxes -H "Authorization: Bearer $ADMIN_KEY" -d '{"address":"claude@example.com","name":"Claude"}'
# → {"id":"…","address":"claude@example.com","name":"Claude","api_key":"…"}
```

Inboxes can be on any domain you've set up for this Worker (see Setup). Creating an inbox checks that the domain's MX records point at Cloudflare Email Routing, which catches typos and domains that aren't set up yet. It can't confirm that the catch-all rule targets this Worker, so check that step in the dashboard.

| Method | Path | |
|---|---|---|
| `POST` | `/admin/inboxes` | `{address, name?}` → `{id, address, name, api_key}` |
| `GET` | `/admin/inboxes?deleted=true` | List inboxes: `id`, `address`, `name`, `created_at` |
| `PATCH` | `/admin/inboxes/:id` | `{name}` sets the display name (`null` or `""` removes it) → `{id, address, name}` |
| `DELETE` | `/admin/inboxes/:id` | Delete the inbox. Its key stops working and its mail is hidden. |
| `POST` | `/admin/inboxes/:id/restore` | Bring a deleted inbox back, with its mail and webhooks |
| `POST` | `/admin/inboxes/:id/purge` | Permanently remove what is deleted → `{messages, webhooks, inbox}` |
| `POST` | `/admin/inboxes/:id/rotate-key` | Returns a new `api_key` |

Admin routes take the inbox `id`, from creation or `GET /admin/inboxes`. An inbox's `name` is optional; when set, its mail is sent as `Name <address>`. It can be up to 100 characters, with no line breaks.

## Agent API

All agent calls use `Authorization: Bearer <api_key>`.

```bash
# Send a message. reply_to_id, cc, bcc and attachments are optional.
curl -X POST $URL/send -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"bob@example.org","subject":"Hello","text":"Hi Bob"}'
# → {"id":"01a0…","messageId":"<…@example.com>"}

# New mail, newest first, 20 per page.
curl "$URL/messages?unread=true" -H "Authorization: Bearer $API_KEY"
# → {"messages":[{"id":"01a0…","from":{"name":"Bob","address":"bob@example.org"},…}],
#    "paging":{"before":null,"after":null}}

# Read one, mark it read, then delete it.
curl $URL/messages/01a0… -H "Authorization: Bearer $API_KEY"
curl -X POST $URL/messages/01a0…/read -H "Authorization: Bearer $API_KEY"
curl -X DELETE $URL/messages/01a0… -H "Authorization: Bearer $API_KEY"
# → {"ok":true}, and POST .../restore brings it back
```

| Method | Path | |
|---|---|---|
| `POST` | `/send` | `{to, cc?, bcc?, subject, text?, html?, attachments?: [{filename, type, content (base64)}], reply_to_id?}` → `{id, messageId}`. The sent message is saved, and `id` works with the `/messages/:id` routes. |
| `GET` | `/messages?direction=in&unread=true&deleted=false&from=<text>&to=<text>&subject=<text>&before=<id>&after=<id>` | List messages, 20 per page, newest first → `{messages, paging: {before, after}}`. For older mail pass `paging.before` as `before`, for newer mail `paging.after` as `after`; `null` means there is no more that way. `direction` is `in` (received, the default), `out` (sent) or `all`. Each message has `from` as `{name, address}` and lists its `recipients` (to, cc and, for sent mail, bcc). `from` matches part of the sender address, `to` part of any recipient and `subject` part of the subject, all ignoring case (e.g. `from=@example.com`). |
| `GET` | `/messages/:id` | Full message, deleted or not: `message_id`, `in_reply_to`, `references`, `from`, `reply_to`, `to`, `cc`, `bcc` (sent mail), `subject`, `date`, `text`, `html`, attachment list, all `headers`, `direction`, `created_at`, `read_at`, `deleted_at`. Addresses are `{name, address}`. |
| `GET` | `/messages/:id/attachments/:index` | Download an attachment (`index` from the message's `attachments`) |
| `POST` | `/messages/:id/read` | Mark read: sets `read_at`, keeping the first time |
| `DELETE` | `/messages/:id` | Delete |
| `POST` | `/messages/:id/restore` | Undo a delete |
| `GET` / `POST` / `DELETE` | `/webhooks[/:id]?deleted=true` | List, add (`{url}`, https only → `{id, url, secret}`), remove |
| `POST` | `/webhooks/:id/restore` | Undo a delete, unless the inbox already has 10 |

Send limits come from Cloudflare: 5 MiB per message, 32 attachments, 50 recipients.

Mail is parsed when it arrives and stored in R2 as `<inbox id>/<message id>/message.json`, with each
attachment as its own file beside it. Reads never re-parse, and both received and sent mail are stored
the same way. Every message, in lists and on its own, carries its `attachments` (`index`, `filename`,
`type`, `size`, `disposition`).

All timestamps are Unix milliseconds: `created_at`, `read_at` (`null` until read), `deleted_at` and an
inbox's `updated_at`. A message's `date` is different: it is the email's own Date header, as ISO 8601.

To reply in a thread, pass `reply_to_id`: the `id` of a message in this inbox. The Worker sets the
`In-Reply-To` and `References` headers from it, so the reply threads in the recipient's mail client.
Replies to replies keep the chain. Set `to` and the subject yourself, e.g. `Re: <subject>`.

A received message's `from` comes from its headers and isn't verified, so don't treat it as proof of who sent it.

`GET /health` needs no key: it returns `{"ok":true}`, or a 503 if the database is unreachable.

## Webhooks

When mail arrives, each of the inbox's webhooks gets a `POST`:

```json
{ "inbox": "claude@example.com",
  "message": { "id": "…", "message_id": "<…>", "in_reply_to": null, "references": [],
               "from": { "name": "Bob", "address": "bob@example.org" }, "reply_to": [],
               "to": [{ "name": "", "address": "claude@example.com" }],
               "subject": "…", "date": "…", "text": "…",
               "attachments": [{ "index": 0, "filename": "a.pdf", "type": "application/pdf", "size": 1234 }] } }
```

Each webhook has its own `secret`, returned only once, when the webhook is added. To rotate it,
delete the webhook and add it again. To verify a webhook, compute `HMAC-SHA256(secret, X-Timestamp + "." + rawBody)` as
hex and compare it with the `X-Signature` header (`sha256=<hex>`). Reject old timestamps.
A non-2xx response is retried with backoff, up to 5 attempts in total. You can always fall back to polling.

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
npm run types     # regenerate worker-configuration.d.ts after changing bindings
```
