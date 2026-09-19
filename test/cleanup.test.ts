import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleScheduled } from "../src/cleanup";
import { reset } from "./helpers";

beforeEach(reset);

const DAY = 86_400_000;

async function addMessage(id: string, createdAt: number) {
  await env.DB.prepare("INSERT OR IGNORE INTO inboxes (id, address, key_hash, created_at, updated_at) VALUES ('i1', 'a@x.com', 'h', 0, 0)").run();
  await env.DB.prepare(
    "INSERT INTO messages (id, inbox_id, direction, from_addr, from_name, recipients, subject, attachments, created_at) VALUES (?, 'i1', 'in', 's@x.com', '', '', 'x', '[]', ?)",
  )
    .bind(id, createdAt)
    .run();
  await env.MAIL.put(`i1/${id}/message.json`, "{}");
}

describe("cleanup", () => {
  it("soft-deletes messages older than RETENTION_DAYS, keeping their files", async () => {
    await addMessage("old", Date.now() - 8 * DAY);
    await addMessage("new", Date.now() - 1 * DAY);
    await handleScheduled({ ...env, RETENTION_DAYS: "7" });

    const { results } = await env.DB.prepare("SELECT id, deleted_at FROM messages ORDER BY id").all();
    expect(results).toEqual([
      { id: "new", deleted_at: null },
      { id: "old", deleted_at: expect.any(Number) },
    ]);
    const keys = (await env.MAIL.list()).objects.map((o) => o.key).sort();
    expect(keys).toEqual(["i1/new/message.json", "i1/old/message.json"]);
  });

  it("does nothing when RETENTION_DAYS is not a positive number", async () => {
    await addMessage("old", Date.now() - 800 * DAY);
    await handleScheduled({ ...env, RETENTION_DAYS: "0" });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
