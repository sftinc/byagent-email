# Webhooks

Each of the inbox's webhooks gets a `POST` in two cases: mail arrives, or a message you sent ends
in a terminal status that isn't success. Webhooks are optional: an agent can poll
[`GET /messages`](agent-api.md#list-messages) instead, and polling is the fallback whenever a
delivery fails.

## Register one

```bash
curl -X POST $URL/webhooks -H "Authorization: Bearer $API_KEY" \
  -d '{"url":"https://agent.example/hook","name":"Ops alerts","bearer":"token-the-receiver-issued"}'
# → {"id":"01a0…","name":"Ops alerts","url":"https://agent.example/hook","secret":"…"}
```

- The URL must be `https://`.
- `name` is optional, up to 100 characters: a label so a list says what each webhook is for.
- **The `secret` is shown only once**, so keep it. It signs every delivery for this webhook, and
  never leaves the Worker: only its HMAC travels, in `X-Signature`.
- `bearer` is optional, up to 500 characters, trimmed. Set it when the receiver authenticates you
  with a token it issued instead of checking the signature. It is sent verbatim as
  `Authorization: Bearer ...` on every delivery, and is never shown again.
- Up to 10 webhooks per inbox. To change a secret or a bearer, delete the webhook and add it again.

```bash
curl $URL/webhooks -H "Authorization: Bearer $API_KEY"   # list: id, name, url, succeeded_at, failed_at
curl -X DELETE $URL/webhooks/01a0… -H "Authorization: Bearer $API_KEY"
curl -X POST $URL/webhooks/01a0…/restore -H "Authorization: Bearer $API_KEY"
```

`?deleted=true` lists deleted webhooks. Restoring one fails with 400 if the inbox already has 10.

## The payload

```json
{ "event": "mail",
  "inbox": "claude@example.com",
  "message": { "id": "…", "direction": "in", "status": "received", "status_reason": null,
               "message_id": "<…>", "in_reply_to": null, "references": [],
               "from": { "name": "Bob", "address": "bob@example.org" }, "reply_to": [],
               "to": [{ "name": "", "address": "claude@example.com" }],
               "subject": "…", "date": "…", "text": "…",
               "attachments": [{ "index": 0, "filename": "a.pdf", "type": "application/pdf",
                                 "size": 1234, "disposition": "attachment",
                                 "url": "https://api.example.com/attachments/…" }] } }
```

| Field | |
|---|---|
| `event` | `"mail"` for an arrival, `"status"` when a message you sent reached a terminal status that isn't success. |
| `message.direction` | `"in"` for received mail, `"out"` for a status delivery about a message you sent. |
| `message.status` | For `"mail"`: `"received"`. For `"status"`: `"bounced"`, `"complained"`, `"rejected"` or `"failed"` — whichever ended the send. `"delivered"` and `"deferred"` never fire a webhook: delivered needs no interruption, and deferred resolves itself. |
| `message.status_reason` | Why the status is what it is; `null` when there's nothing to add. |

Each attachment carries a `url` that fetches its bytes for fifteen minutes with no key — see
[Attachment links](concepts.md#attachment-links). A receiver that was down through the retry window
will find the link expired; the message is still there to read.

A status delivery carries the same message shape as an arrival — same fields, same attachment list —
just with `event: "status"` and `direction: "out"` instead.

It leaves out `html`, `cc`, `bcc` and the full header list, to stay small. Fetch
[`GET /messages/:id`](agent-api.md#read-a-message) for those; attachments are fetched by their `url`. Note that
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

## Seeing what happened

Every attempt is logged, delivered or not, with the webhook id, the message id, the attempt number,
and either the HTTP status or — when the request got no response at all — the reason it didn't. A
skipped delivery is logged too, so a webhook that never fired is distinguishable from one that fired
and failed. Read them in the dashboard under the Worker's **Observability**, or live with
`npx wrangler tail`.

`GET /webhooks` also carries `succeeded_at` and `failed_at`, the last time each webhook delivered
and the last time it didn't. They outlive the logs, so they answer "is this webhook working?" long
after the detail has aged out: `failed_at` newer than `succeeded_at` means it is broken now, and a
`failed_at` with no `succeeded_at` means it has never once worked. They say when, never why — the
logs below are where the status code and the reason live.

This needs `"observability"` enabled in `wrangler.jsonc`, which it is by default. With it off,
nothing is stored and the logs only exist while a `wrangler tail` is attached — which is no use for
a retry that fails four minutes after the mail arrived. Logs are kept 3 days on the free plan, 7 on
paid. Leave `head_sampling_rate` at `1`: it samples whole invocations, so a lower rate discards
entire deliveries, errors included.
