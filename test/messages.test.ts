import { beforeEach, describe, expect, it } from "vitest";
import { api, reset } from "./helpers";

beforeEach(reset);

describe("messages", () => {
  it("requires an inbox key", async () => {
    expect((await api("/messages")).status).toBe(401);
    expect((await api("/messages", { key: "nope" })).status).toBe(401);
  });
});
