CREATE TABLE inboxes (
  address        TEXT PRIMARY KEY,
  key_hash       TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE webhooks (
  id    TEXT PRIMARY KEY,
  inbox TEXT NOT NULL,
  url   TEXT NOT NULL
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  inbox       TEXT NOT NULL,
  from_addr   TEXT NOT NULL,
  subject     TEXT,
  received_at INTEGER NOT NULL,           -- or sent, for direction 'out'
  read        INTEGER NOT NULL DEFAULT 0,
  direction   TEXT NOT NULL DEFAULT 'in', -- 'in' (received) or 'out' (sent)
  to_addrs    TEXT NOT NULL DEFAULT ''    -- every recipient (to, cc, bcc), comma-separated
);

CREATE UNIQUE INDEX inboxes_key_hash ON inboxes(key_hash);
CREATE INDEX messages_inbox_received ON messages(inbox, received_at);
CREATE INDEX webhooks_inbox ON webhooks(inbox);
