import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("serves the API from the deployed Worker entry point", async () => {
  const res = await (exports as any).default.fetch("https://worker.example/messages");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "Unauthorized" });
});
