// One-time setup: creates the Cloudflare resources, writes wrangler.jsonc,
// deploys the Worker, sets ADMIN_KEY and saves it to .dev.vars (gitignored).
// Safe to re-run (it issues a new ADMIN_KEY).
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const NAME = "byagent-email";

const run = (cmd, options = {}) => execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...options });
const runVisible = (cmd) => execSync(cmd, { stdio: "inherit" });
const tryRun = (cmd) => {
  try {
    return run(cmd);
  } catch {
    return null; // usually "already exists"
  }
};

// npm run setup -- --domain example.com [--api api.example.com]
const { values } = parseArgs({ options: { domain: { type: "string" }, api: { type: "string" } } });

run("npx wrangler whoami"); // fails early when not logged in

let domain = values.domain?.toLowerCase();
if (!domain) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  domain = (await rl.question("Email domain (e.g. example.com): ")).trim().toLowerCase();
  rl.close();
}
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(`Not a valid domain: ${domain}`);

// Optional API hostname (custom domain). Without it the Worker is served on workers.dev.
const apiHost = values.api?.toLowerCase();
if (apiHost && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(apiHost)) throw new Error(`Not a valid hostname: ${apiHost}`);

console.log("Creating D1 database, R2 bucket and queue...");
tryRun(`npx wrangler d1 create ${NAME}`);
tryRun(`npx wrangler r2 bucket create ${NAME}`);
tryRun(`npx wrangler queues create ${NAME}-webhooks`);
const { uuid } = JSON.parse(run(`npx wrangler d1 info ${NAME} --json`));

if (existsSync("wrangler.jsonc")) {
  console.log("wrangler.jsonc already exists, leaving it as is (edit it to change the domain or API hostname).");
} else {
  const config = readFileSync("wrangler.example.jsonc", "utf8")
    .replace("email.example.com", domain)
    .replace("REPLACE_WITH_D1_DATABASE_ID", uuid)
    .replace(
      '"vars": {',
      apiHost ? `"routes": [{ "pattern": "${apiHost}", "custom_domain": true }],\n  "workers_dev": false,\n  "preview_urls": false,\n  "vars": {` : '"vars": {',
    );
  writeFileSync("wrangler.jsonc", config);
  console.log("Wrote wrangler.jsonc");
}

runVisible(`npx wrangler d1 migrations apply ${NAME} --remote`);
runVisible("npx wrangler deploy");

const adminKey = randomBytes(32).toString("hex");
run("npx wrangler secret put ADMIN_KEY", { input: adminKey });

const env = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l && !l.startsWith("ADMIN_KEY=")) : [];
writeFileSync(".dev.vars", [...env, `ADMIN_KEY=${adminKey}`, ""].join("\n"));

console.log(`
Done. ADMIN_KEY saved to .dev.vars (gitignored). Use it with: source .dev.vars

Steps left, in the Cloudflare dashboard:
  1. Email > Email Sending > Onboard Domain > ${domain}
  2. If ${domain} is a subdomain: Email > Email Routing > (apex domain) > Settings > Subdomains: add ${domain}
  3. Email Routing rules for ${domain}: set the catch-all rule to "Send to a Worker" > ${NAME}
`);
