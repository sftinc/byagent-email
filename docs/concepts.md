# Concepts

Rules that apply across the whole API.

## IDs

Every id — inbox, message, webhook — is a UUID v7: unguessable, and ordered by creation time. Message
lists and paging are ordered by message id, so ordering matches arrival with no ties.

Admin routes take the inbox `id`, not its address, so an address could change without rewriting
anything. Agents never need the inbox id: their API key identifies the inbox.

## Timestamps

All timestamps are Unix milliseconds:

| Field | |
|---|---|
| `created_at` | when a message was received or sent, or an inbox created |
| `updated_at` | last change to an inbox (rename, key rotation) or a message (e.g. marking it read, or a delivery status change) |
| `read_at` | when an agent first read a message; `null` until then |
| `deleted_at` | when something was deleted; `null` while live |

A message's `date` is the exception: it's the email's own Date header, as an ISO 8601 string.

## Status

Every message has a `status`:

| `status` | `direction` | Meaning |
|---|---|---|
| `received` | in | mail delivered to an inbox |
| `rejected` | in | no inbox holds the address; `inbox_id` is null |
| `sent` | out | Cloudflare accepted it; no delivery event yet |
| `delivered` | out | the recipient's server accepted it |
| `deferred` | out | temporary failure, retries pending |
| `bounced` | out | permanent failure, or retries exhausted |
| `complained` | out | the recipient marked it as spam |
| `rejected` | out | blocked by policy before delivery |
| `failed` | out | `EMAIL.send` threw, or an internal delivery error |

`rejected` is the only word appearing in both directions: inbound it means no inbox holds the
address, outbound it means policy blocked the send before Cloudflare would even try it.

Delivery events are per-recipient, and a multi-recipient send tracks one `status` for the whole
message: the last event processed wins. A bounce to one recipient can be masked by another
recipient's later `delivered`.

## Deleting

Deletes are soft everywhere. A deleted inbox, webhook or message disappears from the lists, but its
database row and stored mail are kept.

- Pass `deleted=true` to any list to see deleted items instead, each with its `deleted_at`.
- Every deletable thing has a `restore` route that undoes it.
- `GET /messages/:id` returns a message whether or not it's deleted. Changing one (marking it unread,
  deleting it again) returns 404.
- Deleting an inbox marks only the inbox. Its key stops working and its mail is hidden, and restoring
  it brings everything back as it was, including messages deleted individually, which stay deleted.
- An address belongs to one inbox forever. Creating an address that a deleted inbox holds returns 409,
  saying to restore it instead.

## Purging

Purge is the one permanent operation, and the only thing that frees storage.

- On a live inbox it removes what is already deleted, and nothing in use.
- On a deleted inbox it removes the inbox itself with all of its mail, files and webhooks. That needs
  `?confirm=true`, and it frees the address.
- `RETENTION_DAYS` purges on a schedule: each night it removes messages older than that many days,
  deleted or not, with their files. It never touches inboxes or webhooks. See
  [Configuration](setup.md#configuration).
- Rejected mail (see below) is always purged after 30 days, regardless of `RETENTION_DAYS`. No
  inbox purge can reach it, since it belongs to no inbox.
- Rotating an inbox's key (`rotate-key`) revokes its outstanding attachment links along with the key.

See [`POST /admin/inboxes/:id/purge`](admin-api.md#purge).

## Storage

Mail is parsed once, when it arrives, and never re-parsed on read. Each message is stored in R2 under
its own prefix:

```
<inbox id>/<message id>/message.json   the message exactly as the API returns it
<inbox id>/<message id>/0              first attachment, raw bytes
<inbox id>/<message id>/1              second attachment, and so on
```

Sent mail is stored the same way. D1 holds what lists and filters need: sender, recipients, subject,
attachment metadata and the timestamps. The raw email is not kept.

### Attachment links

Attachment bytes are fetched by link, not by API call. Reading a message — over REST or MCP — puts a
`url` on each attachment:

```
https://api.example.com/attachments/AZk4sBxEegKOMV1_mgscLQGZOMQ_Knwxn16KGyw9Tl8AAGqytWZc83HWsRjOuZfJdw3hEFGk
```

The link needs no key, so anything holding it can follow it: a script, a browser, a model. It is
signed with the inbox's key and **expires after fifteen minutes**, because links land in transcripts
and logs that outlive them. An expired link answers `410` and says to read the message again; a
purged attachment answers `410` and says so; a tampered link answers `404` and nothing else.

Rotating the inbox's key revokes every link it minted, and only its own. Deleting the inbox does the
same. Message lists carry attachment names, types and sizes but no links — read the message to get
those. Webhook payloads carry them too.

### Rejected mail

The domain uses a catch-all rule, so mail for an address no inbox holds still reaches the Worker. It's
recorded as a message with no `inbox_id` and no stored files — there's no inbox to store them under —
and rejected. With no inbox, it's invisible to every agent; only an admin can see it.

## Limits

| | |
|---|---|
| Sending | 5 MiB per message, 32 attachments, 50 recipients (Cloudflare's limits) |
| Receiving | 25 MiB per message (Cloudflare's limit) |
| Listing | 20 messages per page |
| Webhooks | 10 per inbox |
| Inbox and webhook names | 100 characters, no line breaks |
