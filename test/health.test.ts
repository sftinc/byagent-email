import { describe, expect, it } from "vitest";
import { api } from "./helpers";

describe("health", () => {
  it("answers without a key and checks the database", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports 503 when the database is unreachable", async () => {
    const DB = { prepare: () => ({ first: async () => { throw new Error("down"); } }) } as any;
    const res = await api("/health", {}, { DB });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});
