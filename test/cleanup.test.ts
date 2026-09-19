import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleScheduled } from "../src/cleanup";
import { reset } from "./helpers";

beforeEach(reset);

const DAY = 86_400_000;

async function addMessage(id: string, createdAt: number, attachments = "[]") {
  await env.DB.prepare("INSERT OR IGNORE INTO inboxes (id, address, key_hash, created_at, updated_at) VALUES ('i1', 'a@x.com', 'h', 0, 0)").run();
  await env.DB.prepare(
    "INSERT INTO messages (id, inbox_id, direction, from_addr, from_name, recipients, subject, attachments, created_at) VALUES (?, 'i1', 'in', 's@x.com', '', '', 'x', ?, ?)",
  )
    .bind(id, attachments, createdAt)
    .run();
  await env.MAIL.put(`i1/${id}/message.json`, "{}");
  for (let i = 0; i < JSON.parse(attachments).length; i++) await env.MAIL.put(`i1/${id}/${i}`, "bytes");
}

const file = { filename: "a.txt", type: "text/plain", size: 5, disposition: "attachment" };

describe("cleanup", () => {
  it("permanently deletes messages older than RETENTION_DAYS, with their files", async () => {
    await addMessage("old", Date.now() - 8 * DAY, JSON.stringify([file]));
    await addMessage("new", Date.now() - 1 * DAY);
    await handleScheduled({ ...env, RETENTION_DAYS: "7" });

    const { results } = await env.DB.prepare("SELECT id FROM messages").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["new"]);
    expect((await env.MAIL.list()).objects.map((o) => o.key)).toEqual(["i1/new/message.json"]);
  });

  it("deletes old messages whether or not they were already deleted", async () => {
    await addMessage("old", Date.now() - 8 * DAY);
    await env.DB.prepare("UPDATE messages SET deleted_at = 1 WHERE id = 'old'").run();
    await handleScheduled({ ...env, RETENTION_DAYS: "7" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("leaves inboxes and webhooks alone", async () => {
    await addMessage("old", Date.now() - 8 * DAY);
    await env.DB.prepare("INSERT INTO webhooks (id, inbox_id, url, secret, created_at) VALUES ('w1', 'i1', 'https://a.example', 's', 0)").run();
    await handleScheduled({ ...env, RETENTION_DAYS: "7" });

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM inboxes").first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("does nothing when RETENTION_DAYS is not a positive number", async () => {
    await addMessage("old", Date.now() - 800 * DAY);
    await handleScheduled({ ...env, RETENTION_DAYS: "0" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>()).toEqual({ n: 1 });
  });
});
