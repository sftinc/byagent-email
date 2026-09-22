# Admin API

Managing inboxes. Every call uses the admin key:

```bash
source .dev.vars            # ADMIN_KEY and API_URL, written by setup
export URL=$API_URL
```

```bash
curl -H "Authorization: Bearer $ADMIN_KEY" $URL/admin/inboxes
```

| Method | Path | |
|---|---|---|
| `POST` | `/admin/inboxes` | Create an inbox |
| `GET` | `/admin/inboxes?deleted=true` | List inboxes |
| `PATCH` | `/admin/inboxes/:id` | Set or clear the display name |
| `POST` | `/admin/inboxes/:id/rotate-key` | Issue a new API key |
| `DELETE` | `/admin/inboxes/:id` | Delete the inbox |
| `POST` | `/admin/inboxes/:id/restore` | Undo a delete |
| `POST` | `/admin/inboxes/:id/purge` | Permanently remove what is deleted |
| `GET` | `/admin/rejected` | List mail sent to addresses no inbox holds |

Routes take the inbox `id`, from creation or the list.

## Create an inbox

```bash
curl -X POST $URL/admin/inboxes -H "Authorization: Bearer $ADMIN_KEY" \
  -d '{"address":"claude@example.com","name":"Claude"}'
# → {"id":"01a0…","address":"claude@example.com","name":"Claude","api_key":"…"}
```

- `name` is optional. When set, the inbox's mail goes out as `Claude <claude@example.com>`.
- **The `api_key` is shown only once.** Give it to the agent; it can't be retrieved later, only rotated.
- The address can be on any domain set up for this Worker ([Setup](setup.md#each-email-domain)). Its
  MX records are checked first.
- 409 if the address exists. If the existing inbox is deleted, the error says to restore it instead.

To push arriving mail somewhere, register a webhook with the new key right after creating the inbox:
`POST /webhooks` with `{"url":"https://…"}` — see [Webhooks](webhooks.md#register-one).

## List inboxes

```bash
curl $URL/admin/inboxes -H "Authorization: Bearer $ADMIN_KEY"
# → {"inboxes":[{"id":"01a0…","address":"claude@example.com","name":"Claude","created_at":1789…}]}
```

`?deleted=true` lists deleted inboxes instead, each with its `deleted_at`.

## Rename

```bash
curl -X PATCH $URL/admin/inboxes/01a0… -H "Authorization: Bearer $ADMIN_KEY" -d '{"name":"Support Bot"}'
# → {"id":"01a0…","address":"claude@example.com","name":"Support Bot"}
```

`null` or `""` removes the name. Names are at most 100 characters, with no line breaks.

## Rotate the key

```bash
curl -X POST $URL/admin/inboxes/01a0…/rotate-key -H "Authorization: Bearer $ADMIN_KEY"
# → {"api_key":"…"}
```

The old key stops working immediately. Mail and webhooks are untouched.

## Delete and restore

```bash
curl -X DELETE $URL/admin/inboxes/01a0… -H "Authorization: Bearer $ADMIN_KEY"
curl -X POST $URL/admin/inboxes/01a0…/restore -H "Authorization: Bearer $ADMIN_KEY"
```

Deleting marks only the inbox: its key stops working, new mail to it is rejected, and it leaves the
lists. Restoring brings it back with its mail, webhooks and original key. See
[Deleting](concepts.md#deleting).

## Purge

```bash
# Live inbox: drop what is already deleted.
curl -X POST $URL/admin/inboxes/01a0…/purge -H "Authorization: Bearer $ADMIN_KEY"
# → {"messages":12,"webhooks":1,"inbox":false}

# Deleted inbox: remove it entirely. Needs confirm=true.
curl -X POST "$URL/admin/inboxes/01a0…/purge?confirm=true" -H "Authorization: Bearer $ADMIN_KEY"
# → {"messages":840,"webhooks":2,"inbox":true}
```

This is permanent and frees the storage. Without `confirm=true`, purging a deleted inbox returns 400.
Purge an inbox before deleting its data another way (for example resetting the database), so its
stored files go with it.

## List rejected mail

```bash
curl $URL/admin/rejected -H "Authorization: Bearer $ADMIN_KEY"
# → {"rejected":[{"id":"01a0…","from_addr":"sender@example.org","recipients":"nobody@example.com","subject":"Hi","status_reason":"unknown_recipient","created_at":1789…}]}
```

No agent can see this mail — it belongs to no inbox — so this is the only way to read it. See
[Rejected mail](concepts.md#rejected-mail).

Returns at most the newest 100. These rows have no stored body, and are purged after 30 days
regardless of any inbox's `RETENTION_DAYS`.
