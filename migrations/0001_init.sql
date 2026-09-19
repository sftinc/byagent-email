CREATE TABLE inboxes (
  id         TEXT PRIMARY KEY,
  address    TEXT NOT NULL UNIQUE,
  key_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhooks (
  id       TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  url      TEXT NOT NULL,
  secret   TEXT NOT NULL -- signs this webhook's deliveries
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  inbox_id    TEXT NOT NULL,
  from_addr   TEXT NOT NULL,
  subject     TEXT,
  received_at INTEGER NOT NULL,           -- or sent, for direction 'out'
  read        INTEGER NOT NULL DEFAULT 0,
  direction   TEXT NOT NULL DEFAULT 'in', -- 'in' (received) or 'out' (sent)
  recipients  TEXT NOT NULL DEFAULT ''    -- to, cc and (for sent mail) bcc, comma-separated
);

CREATE UNIQUE INDEX inboxes_key_hash ON inboxes(key_hash);
CREATE INDEX messages_inbox_received ON messages(inbox_id, received_at);
CREATE INDEX webhooks_inbox ON webhooks(inbox_id);
