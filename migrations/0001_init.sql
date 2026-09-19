-- Column order: primary key, foreign keys, data grouped by what it describes, then dates
-- (created_at first, deleted_at last). Deletes are soft: they set deleted_at and keep the row.

CREATE TABLE inboxes (
  id         TEXT PRIMARY KEY,
  -- identity
  address    TEXT NOT NULL,
  -- auth
  key_hash   TEXT NOT NULL,
  -- dates
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,  -- set on create, and whenever the row changes (e.g. key rotation)
  deleted_at INTEGER
);

CREATE TABLE webhooks (
  id         TEXT PRIMARY KEY,
  inbox_id   TEXT NOT NULL REFERENCES inboxes(id),
  -- target
  url        TEXT NOT NULL,
  -- auth
  secret     TEXT NOT NULL,     -- signs this webhook's deliveries
  -- dates
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  inbox_id   TEXT NOT NULL REFERENCES inboxes(id),
  -- routing
  direction  TEXT NOT NULL,     -- 'in' (received) or 'out' (sent)
  from_addr  TEXT NOT NULL,
  recipients TEXT NOT NULL,     -- to, cc and (for sent mail) bcc, comma-separated
  -- content
  subject    TEXT,
  -- state
  read       INTEGER NOT NULL DEFAULT 0,
  -- dates
  created_at INTEGER NOT NULL,  -- received or sent
  deleted_at INTEGER
);

-- An address is unique among inboxes that aren't deleted, so a deleted address can be reused.
CREATE UNIQUE INDEX inboxes_address ON inboxes(address) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX inboxes_key_hash ON inboxes(key_hash);
CREATE INDEX messages_inbox_id ON messages(inbox_id, id);  -- lists and pages by id
CREATE INDEX webhooks_inbox ON webhooks(inbox_id);
