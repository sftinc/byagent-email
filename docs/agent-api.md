# Agent API

Everything an agent does with its own inbox: send mail, read what arrives, reply in a thread. Hand
this file to the agent.

Every call uses the inbox's API key, which identifies the inbox:

```bash
export URL=https://api.example.com        # whoever deployed it has this: API_URL in .dev.vars
export API_KEY=…                          # from inbox creation, shown once
curl -H "Authorization: Bearer $API_KEY" "$URL/messages?unread=true"
```

| Method | Path | |
|---|---|---|
| `POST` | `/send` | Send a message, optionally as a reply |
| `GET` | `/messages` | List messages, newest first, 20 per page |
| `GET` | `/messages/:id` | Read one in full; marks it read |
| `GET` | `/messages/:id/attachments/:index` | Download an attachment |
| `POST` | `/messages/:id/unread` | Put it back in the unread list |
| `DELETE` | `/messages/:id` | Delete |
| `POST` | `/messages/:id/restore` | Undo a delete |
| `GET` / `POST` / `DELETE` | `/webhooks[/:id]` | [Webhooks](webhooks.md), so arriving mail is pushed to you |

## Send

```bash
curl -X POST $URL/send -H "Authorization: Bearer $API_KEY" -d '{
  "to": "bob@example.org",
  "subject": "Hello",
  "text": "Hi Bob"
}'
# → {"id":"01a0…","messageId":"<…@example.com>"}
```

| Field | |
|---|---|
| `to` | required: an address, or a list of them. Each is `"bob@x.com"` or `{"address":"bob@x.com","name":"Bob"}` |
| `cc`, `bcc` | optional, same shape |
| `subject` | required |
| `text`, `html` | at least one; sending both lets the recipient's client choose |
| `attachments` | optional, see below |
| `reply_to_id` | optional, see below |

A named recipient goes out as `Bob <bob@x.com>`, and the name is kept on the saved copy. Searching by
`to` still matches addresses only. The sender is always the inbox, as `Name <address>` when the inbox
has a name. `id` is the saved copy,
which works with every `/messages/:id` route; `messageId` is the email's `Message-ID` header.

Limits: 5 MiB per message, 32 attachments, 50 recipients. Over the size limit returns 413; a rejected
send returns 502 with Cloudflare's error code, such as `E_DAILY_LIMIT_EXCEEDED`. The attempt is still
saved with `status: "failed"` and that code as `status_reason`, and the 502 body carries its `id`
alongside `error` so you can find it later.

### Attachments

Each attachment is `{filename, type, content}`, where `content` is base64:

```bash
curl -X POST $URL/send -H "Authorization: Bearer $API_KEY" -d "{
  \"to\": \"bob@example.org\", \"subject\": \"Report\", \"text\": \"Attached.\",
  \"attachments\": [{\"filename\":\"report.pdf\",\"type\":\"application/pdf\",\"content\":\"$(base64 < report.pdf)\"}]
}"
```

### Reply in a thread

Pass `reply_to_id`, the `id` of a message in this inbox:

```bash
curl -X POST $URL/send -H "Authorization: Bearer $API_KEY" -d '{
  "to": "bob@example.org",
  "subject": "Re: Hello",
  "text": "Got it.",
  "reply_to_id": "01a0…"
}'
```

The Worker sets `In-Reply-To` and `References` from that message, so the reply lands in the same
conversation in the recipient's mail client. Replies to replies keep the chain. Choose `to` and the
subject yourself: reply to the message's `reply_to` if it has one, otherwise its `from`.

## List messages

```bash
curl "$URL/messages?unread=true" -H "Authorization: Bearer $API_KEY"
```

```json
{ "messages": [
    { "id": "01a0…", "direction": "in", "status": "received", "status_reason": null,
      "from": { "name": "Bob", "address": "bob@example.org" },
      "recipients": ["claude@example.com"],
      "subject": "Hello", "attachments": [],
      "created_at": 1789853699757, "read_at": null, "deleted_at": null }
  ],
  "paging": { "before": "01a0…", "after": null } }
```

Lists never mark anything read. 20 messages per page, newest first.

| Parameter | |
|---|---|
| `direction` | `in` (received, the default), `out` (sent) or `all` |
| `unread=true` | only messages with no `read_at` |
| `from`, `to`, `subject` | match part of the value, ignoring case, e.g. `from=@example.org` |
| `deleted=true` | deleted messages instead of live ones |
| `before`, `after` | paging, below |

`to` matches any recipient, including `cc` and, on sent mail, `bcc`.

### Paging

`paging.before` and `paging.after` are the ids to ask for next, or `null` when there is no more that
way. Pass `paging.before` as `?before=` for older mail, `paging.after` as `?after=` for newer. Every
page comes back newest first.

```bash
# catch up on everything new since the last message you handled
curl "$URL/messages?after=01a0…" -H "Authorization: Bearer $API_KEY"
```

## Read a message

```bash
curl $URL/messages/01a0… -H "Authorization: Bearer $API_KEY"
```

```json
{ "id": "01a0…",
  "message_id": "<…>", "in_reply_to": null, "references": [],
  "from": { "name": "Bob", "address": "bob@example.org" }, "reply_to": [],
  "to": [{ "name": "", "address": "claude@example.com" }], "cc": [],
  "subject": "Hello", "date": "2026-09-19T21:34:57.000Z",
  "text": "Hi there\n", "html": null,
  "attachments": [{ "index": 0, "filename": "a.pdf", "type": "application/pdf",
                    "size": 1234, "disposition": "attachment" }],
  "headers": [{ "key": "subject", "value": "Hello" }],
  "direction": "in", "status": "received", "status_reason": null,
  "created_at": 1789853699757, "read_at": 1789853712004, "deleted_at": null }
```

| Field | |
|---|---|
| `status` | `received`, `bounced` or `rejected` for received mail; `sent` or `failed` for sent mail |
| `status_reason` | why the status is what it is, or `null` when there is nothing to explain |

**Reading marks the message read**, keeping the time of the first read. If you fail after reading one
and want it back in the queue, `POST /messages/:id/unread`.

A deleted message still reads, and shows its `deleted_at`. Its `from` comes from the email's headers
and isn't verified, so don't treat it as proof of who sent it.

## Download an attachment

```bash
curl -OJ $URL/messages/01a0…/attachments/0 -H "Authorization: Bearer $API_KEY"
```

The `index` is the attachment's position in the message's `attachments`. The response carries the
original `Content-Type` and filename. An attachment with a `content_id` and
`"disposition": "inline"` is an inline image from the HTML body, not a real attachment.

## Delete

```bash
curl -X DELETE $URL/messages/01a0… -H "Authorization: Bearer $API_KEY"
curl -X POST $URL/messages/01a0…/restore -H "Authorization: Bearer $API_KEY"
```

Deleting is reversible: the message leaves the lists but is kept, and restore brings it back. See
[Deleting](concepts.md#deleting).

## Errors

Every error is `{"error":"…"}` with a status:

| | |
|---|---|
| 400 | bad request: a missing field, an invalid value, or `reply_to_id` that isn't yours |
| 401 | missing or wrong API key |
| 404 | no such message, webhook, or nothing to restore |
| 413 | the message is larger than 5 MiB |
| 502 | Cloudflare refused the send; `error` is its code, and the body also carries the failed message's `id` |
