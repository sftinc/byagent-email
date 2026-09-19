import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Fake DNS-over-HTTPS for inbox creation: every domain has Cloudflare MX records,
// except ones starting with "nomx.". Tests that stub fetch themselves replace this.
beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const name = new URL(url).searchParams.get("name") ?? "";
    const Answer = name.startsWith("nomx.") ? [] : [{ type: 15, data: "10 route1.mx.cloudflare.net." }];
    return Response.json({ Status: 0, Answer });
  });
});
afterEach(() => vi.unstubAllGlobals());
