import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleScheduled } from "../src/cleanup";
import { reset } from "./helpers";

beforeEach(reset);

const DAY = 86_400_000;

async function addMessage(id: string, receivedAt: number) {
  await env.DB.prepare("INSERT INTO messages (id, inbox, from_addr, subject, received_at) VALUES (?, 'a@email.example.com', 's@x.com', 'x', ?)")
    .bind(id, receivedAt)
    .run();
  await env.MAIL.put(`a@email.example.com/${id}.eml`, "raw");
}

describe("cleanup", () => {
  it("deletes messages older than RETENTION_DAYS", async () => {
    await addMessage("old", Date.now() - 8 * DAY);
    await addMessage("new", Date.now() - 1 * DAY);
    await handleScheduled({ ...env, RETENTION_DAYS: "7" });

    const { results } = await env.DB.prepare("SELECT id FROM messages").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["new"]);
    const keys = (await env.MAIL.list()).objects.map((o) => o.key);
    expect(keys).toEqual(["a@email.example.com/new.eml"]);
  });

  it("does nothing when RETENTION_DAYS is not a positive number", async () => {
    await addMessage("old", Date.now() - 800 * DAY);
    await handleScheduled({ ...env, RETENTION_DAYS: "0" });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
