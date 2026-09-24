# Setup

## Requirements

- One or more domains on Cloudflare DNS. A subdomain (e.g. `mail.example.com`) works too.
- The Workers Paid plan, which Email Service sending requires.
- Node.js 20+ and `npx wrangler login`.

## Deploy

```bash
npm install
npm run setup <api hostname>
```

The setup command:

- creates the D1 database, R2 bucket and queues,
- writes `wrangler.jsonc` (gitignored). The hostname is optional: it serves the API on that hostname
  as a custom domain. Leave it out to use the Worker's `workers.dev` URL,
- applies the database schema and deploys the Worker,
- generates an `ADMIN_KEY` and a `LINK_KEY`, sets both as Worker secrets and saves them to
  `.dev.vars` (gitignored), along with `API_URL`, the address the Worker is served on. `wrangler dev`
  uses this file too. Load it with `source .dev.vars`.

Setup is safe to re-run. It keeps existing resources, data and both keys in `.dev.vars`. To rotate a
key, delete its line and re-run:

- **`ADMIN_KEY`**: the old key stops working at once, so update anything that uses it, such as an MCP
  connection. Nothing else changes.
- **`LINK_KEY`**: every outstanding attachment link stops working — at most fifteen minutes of them
  are ever live. Rotate it only if you think it has leaked.

After pulling updates, re-run it to redeploy.

**Upgrading an existing install:** this release needs `API_DOMAIN` to mint attachment links. Re-run
setup with your API hostname, `npm run setup <api hostname>`: it adds `API_DOMAIN` to the `vars` in
your existing `wrangler.jsonc` before it deploys. Without the hostname it still works, but deploys
twice.

Be aware that schema changes here are made by editing `0001_init.sql` in place rather than by adding a
numbered migration, and `wrangler d1 migrations apply` skips a migration it has already recorded — so
re-running setup will not bring an existing database up to date. Compare the file against your live
schema and apply the difference yourself with `wrangler d1 execute <name> --remote`. An install that
predates delivery events won't get the
`agent-inbox-email-events` consumer added to its `wrangler.jsonc` by re-running setup — setup changes
nothing in that file but `API_DOMAIN` — so add the `queues.consumers` entry from `wrangler.example.jsonc`
to it by hand.

**Recipient names:** from this release the `recipients` column holds JSON,
`[{"name":"…","address":"…"}]`, instead of comma-separated addresses. A schema diff won't show
that, so convert existing rows by hand, once, right before deploying. Back up first:

```bash
npx wrangler d1 export <name> --remote --output backup.sql
```

Save this as `convert.sql` and run `npx wrangler d1 execute <name> --remote --file convert.sql`:

```sql
UPDATE messages SET recipients = (
  SELECT json_group_array(json_object('name', '', 'address', value))
  FROM json_each(CASE WHEN recipients = '' THEN '[]'
                      ELSE '[' || replace(json_quote(recipients), ',', '","') || ']' END)
);
```

Run it only once: a second run would treat converted rows as old ones. After deploying, this
should return 0:

```sql
SELECT count(*) FROM messages WHERE recipients <> '[]' AND recipients NOT LIKE '[{"name":%';
```

If it isn't 0, mail arrived between the `UPDATE` and the deploy. Run the same `UPDATE` again, restricted
to the rows the check above found (safe to repeat, since it only touches old-format rows):

```sql
UPDATE messages SET recipients = (
  SELECT json_group_array(json_object('name', '', 'address', value))
  FROM json_each(CASE WHEN recipients = '' THEN '[]'
                      ELSE '[' || replace(json_quote(recipients), ',', '","') || ']' END)
) WHERE recipients <> '[]' AND recipients NOT LIKE '[{"name":%';
```

## Each email domain

In the Cloudflare dashboard:

1. **Email > Email Sending > Onboard Domain**, and choose the domain. This adds the MX, SPF, DKIM and
   DMARC records.
2. **Email > Email Routing**: if you use a subdomain, first add it under
   **apex domain > Settings > Subdomains**.
3. In Email Routing's rules for the domain, set the **catch-all** rule to
   **Send to a Worker > agent-inbox**.
4. **Queues > agent-inbox-email-events > Subscriptions > Subscribe to events**: source "Email
   Sending", this domain, all six `message.*` events.

Without step 4, sent mail stays `sent` — you will not see deliveries, bounces or complaints.

Enabling Email Routing replaces the domain's MX records, so use a domain (or subdomain) that doesn't
already receive mail.

Creating an inbox checks that its domain's MX records point at Cloudflare Email Routing, which catches
typos and domains that aren't set up yet. It can't confirm that the catch-all rule targets this
Worker, so check that step in the dashboard.

## Configuration

| Name | Where | Default | |
|---|---|---|---|
| `RETENTION_DAYS` | `vars` in `wrangler.jsonc` | `0` | Mail older than this many days is [purged](concepts.md#purging) daily at 03:00 UTC, permanently, with its files. Messages only. `0` keeps mail forever. |
| `ADMIN_KEY` | Worker secret, plus `.dev.vars` locally | set by setup | Admin API key |
| `LINK_KEY` | Worker secret, plus `.dev.vars` locally | set by setup | Signs attachment links and nothing else. It isn't in D1, so a copy of the database alone can't forge a link. |
| `API_DOMAIN` | `vars` in `wrangler.jsonc` | set by setup | The Worker's hostname, without `https://`; attachment links are `https://<API_DOMAIN>/attachments/…`. Cloudflare serves every Worker hostname over HTTPS. |
| `API_URL` | `.dev.vars` locally | set by setup | The same address as a full URL, for you and your agents to call the API with |

Without a hostname the Worker is served on a `workers.dev` URL, `https://agent-inbox.<your
subdomain>.workers.dev`, and setup turns that on explicitly (`"workers_dev": true` in
`wrangler.jsonc`), so there is always a URL. It turns preview URLs off (`"preview_urls": false`),
which wrangler would otherwise enable alongside workers.dev. That hostname only exists once the first deploy prints
it, so setup then writes it into `wrangler.jsonc` as `API_DOMAIN` and deploys a second time. With a
custom hostname it is known up front and one deploy is enough.

To add a custom hostname to an install that started on workers.dev, re-run setup with it:
`npm run setup <api hostname>`. Setup edits only the lines it owns in `wrangler.jsonc`. It adds the
`routes` entry, turns `workers_dev` and `preview_urls` off, sets `API_DOMAIN`, and deploys once. The
hostname must be on a zone in the same Cloudflare account. The workers.dev URL stops answering, so
point agents, MCP connectors and webhook receivers at the new one.

To move from one custom hostname to another, change the `routes` pattern in `wrangler.jsonc`
yourself, then re-run `npm run setup <api hostname>`. Setup won't rewrite an existing `routes` entry,
since it may be written any number of ways; it stops and says so.

`GET /health` needs no key: it returns `{"ok":true}`, or a 503 if the database is unreachable.

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
npm run deploy    # deploy the current code
npm run types     # regenerate worker-configuration.d.ts after changing bindings
```
