import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.example.jsonc" },
        miniflare: { bindings: { ADMIN_KEY: "test-admin-key", LINK_KEY: "test-link-key", API_DOMAIN: "api.example.com", TEST_MIGRATIONS: migrations } },
      }),
    ],
    // `.claude/` holds git worktrees of this repo, whose test files are copies of these.
    test: { setupFiles: ["./test/setup.ts"], exclude: [...configDefaults.exclude, "**/.claude/**"] },
  };
});
