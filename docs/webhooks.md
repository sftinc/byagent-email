# Webhooks

When mail arrives, each of the inbox's webhooks gets a `POST`. Webhooks are optional: an agent can
poll [`GET /messages`](agent-api.md#list-messages) instead, and polling is the fallback whenever a
delivery fails.

## Register one

```bash
curl -X POST $URL/webhooks -H "Authorization: Bearer $API_KEY" \
  -d '{"url":"https://agent.example/hook","name":"Ops alerts"}'
# → {"id":"01a0…","name":"Ops alerts","url":"https://agent.example/hook","secret":"…"}
```

- The URL must be `https://`.
- `name` is optional, up to 100 characters: a label so a list says what each webhook is for.
- `secret` is optional, and signs every delivery for this webhook. Leave it out and the Worker
  generates one; send one (16 to 200 characters, trimmed) to sign with a key the receiver already
  knows. Either way it comes back in the response.
- **A generated `secret` is shown only once**, so keep it.
- Up to 10 webhooks per inbox. To rotate a secret, delete the webhook and add it again.

```bash
curl $URL/webhooks -H "Authorization: Bearer $API_KEY"   # list: id, name, url (no secrets)
curl -X DELETE $URL/webhooks/01a0… -H "Authorization: Bearer $API_KEY"
curl -X POST $URL/webhooks/01a0…/restore -H "Authorization: Bearer $API_KEY"
```

`?deleted=true` lists deleted webhooks. Restoring one fails with 400 if the inbox already has 10.

## The payload

```json
{ "inbox": "claude@example.com",
  "message": { "id": "…", "message_id": "<…>", "in_reply_to": null, "references": [],
               "from": { "name": "Bob", "address": "bob@example.org" }, "reply_to": [],
               "to": [{ "name": "", "address": "claude@example.com" }],
               "subject": "…", "date": "…", "text": "…",
               "attachments": [{ "index": 0, "filename": "a.pdf", "type": "application/pdf",
                                 "size": 1234, "disposition": "attachment" }] } }
```

It leaves out `html`, `cc`, `bcc` and the full header list, to stay small. Fetch
[`GET /messages/:id`](agent-api.md#read-a-message) for those, and for attachment downloads. Note that
fetching marks the message read.

## Verifying a delivery

Each request carries two headers:

| Header | |
|---|---|
| `X-Timestamp` | Unix milliseconds |
| `X-Signature` | `sha256=<hex>` |

Compute `HMAC-SHA256(secret, X-Timestamp + "." + rawBody)` as hex and compare it with `X-Signature`.
Reject old timestamps, so an old delivery can't be replayed at you.

```js
const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
const ok = signature === `sha256=${expected}` && Date.now() - Number(timestamp) < 5 * 60_000;
```

## Retries

A 2xx response means delivered. Anything else, or a timeout after 10 seconds, is retried with backoff:
30s, 60s, 120s, 240s, up to 5 attempts in total. After that the delivery is dropped, and the message
is still in the inbox for polling.

Deliveries for a message or webhook that is deleted before they go out are skipped.
