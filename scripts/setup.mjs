// One-time setup: creates the Cloudflare resources, writes wrangler.jsonc,
// deploys the Worker, sets ADMIN_KEY and saves it to .dev.vars (gitignored).
// Safe to re-run: it keeps the ADMIN_KEY in .dev.vars (delete that line to rotate it).
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const NAME = "agent-inbox";

const run = (cmd, options = {}) => execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...options });
const runVisible = (cmd) => execSync(cmd, { stdio: "inherit" });
const tryRun = (cmd) => {
  try {
    return run(cmd);
  } catch {
    return null; // usually "already exists"
  }
};

// npm run setup [api.example.com]
// The optional hostname serves the API on a custom domain. Without it the Worker uses workers.dev.
const apiHost = process.argv[2]?.toLowerCase();
if (apiHost && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(apiHost)) throw new Error(`Not a valid hostname: ${apiHost}`);

run("npx wrangler whoami"); // fails early when not logged in

console.log("Creating D1 database, R2 bucket and queue...");
tryRun(`npx wrangler d1 create ${NAME}`);
tryRun(`npx wrangler r2 bucket create ${NAME}`);
tryRun(`npx wrangler queues create ${NAME}-webhooks`);
const { uuid } = JSON.parse(run(`npx wrangler d1 info ${NAME} --json`));

if (existsSync("wrangler.jsonc")) {
  console.log("wrangler.jsonc already exists, leaving it as is (edit it to change the API hostname).");
} else {
  // Either a custom domain or the generated workers.dev URL, never neither: without an explicit
  // setting the Worker can deploy with no public URL at all.
  const serving = apiHost
    ? `"routes": [{ "pattern": "${apiHost}", "custom_domain": true }],\n  "workers_dev": false,\n  "preview_urls": false,`
    : '"workers_dev": true,';
  const config = readFileSync("wrangler.example.jsonc", "utf8")
    .replace("REPLACE_WITH_D1_DATABASE_ID", uuid)
    .replace('"vars": {', `${serving}\n  "vars": {`);
  writeFileSync("wrangler.jsonc", config);
  console.log("Wrote wrangler.jsonc");
}

runVisible(`npx wrangler d1 migrations apply ${NAME} --remote`);

// The deploy prints where the Worker is served: a workers.dev URL, or the custom domain.
const deployed = run("npx wrangler deploy");
console.log(deployed);
const apiUrl =
  deployed.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] ??
  (deployed.match(/^\s+(\S+) \(custom domain\)/m)?.[1] && `https://${deployed.match(/^\s+(\S+) \(custom domain\)/m)[1]}`);

// .dev.vars (gitignored) holds the admin key and the API URL, so tools and agents can find them.
const lines = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8").split("\n").filter(Boolean) : [];
const vars = new Map(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const existing = vars.get("ADMIN_KEY");
const adminKey = existing || randomBytes(32).toString("hex");
run("npx wrangler secret put ADMIN_KEY", { input: adminKey });
vars.set("ADMIN_KEY", adminKey);
if (apiUrl) vars.set("API_URL", apiUrl);
writeFileSync(".dev.vars", `${[...vars].map(([k, v]) => `${k}=${v}`).join("\n")}\n`);

console.log(`
Done. ADMIN_KEY ${existing ? "kept in" : "saved to"} .dev.vars (gitignored). Use it with: source .dev.vars
${apiUrl ? `The API is at ${apiUrl} (saved to .dev.vars as API_URL).` : "Could not read the API URL from the deploy output."}

For each email domain, in the Cloudflare dashboard:
  1. Email > Email Sending > Onboard Domain
  2. If it is a subdomain: Email > Email Routing > (apex domain) > Settings > Subdomains: add it
  3. Email Routing rules for the domain: set the catch-all rule to "Send to a Worker" > ${NAME}
`);
