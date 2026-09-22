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
| `updated_at` | an inbox's last change (rename, key rotation) |
| `read_at` | when an agent first read a message; `null` until then |
| `deleted_at` | when something was deleted; `null` while live |

A message's `date` is the exception: it's the email's own Date header, as an ISO 8601 string.

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
