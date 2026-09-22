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
- generates an `ADMIN_KEY` and saves it to `.dev.vars` (gitignored), along with `API_URL`, the address
  the Worker is served on. `wrangler dev` uses this file too. Load it with `source .dev.vars`.

Setup is safe to re-run. It keeps existing resources, data and the `ADMIN_KEY` in `.dev.vars`. To
rotate the admin key, delete that line and re-run. After pulling updates, re-run it to redeploy.

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
| `API_DOMAIN` | `vars` in `wrangler.jsonc` | set by setup | The Worker's hostname, without `https://`; attachment links are `https://<API_DOMAIN>/attachments/…`. Cloudflare serves every Worker hostname over HTTPS. |
| `API_URL` | `.dev.vars` locally | set by setup | The same address as a full URL, for you and your agents to call the API with |

Without a hostname the Worker is served on a `workers.dev` URL, `https://agent-inbox.<your
subdomain>.workers.dev`, and setup turns that on explicitly (`"workers_dev": true` in
`wrangler.jsonc`), so there is always a URL. That hostname only exists once the first deploy prints
it, so setup then writes it into `wrangler.jsonc` as `API_DOMAIN` and deploys a second time. With a
custom hostname it is known up front and one deploy is enough.

To add or change the API hostname later, set `routes` in `wrangler.jsonc` to
`[{ "pattern": "<api hostname>", "custom_domain": true }]` and re-run `npm run setup
<api hostname>`, which updates `API_DOMAIN` to match. Or change both in `wrangler.jsonc` yourself
and run `npm run deploy`.

`GET /health` needs no key: it returns `{"ok":true}`, or a 503 if the database is unreachable.

## Development

```bash
npm test          # Vitest inside the Workers runtime
npm run typecheck
npm run deploy    # deploy the current code
npm run types     # regenerate worker-configuration.d.ts after changing bindings
```
