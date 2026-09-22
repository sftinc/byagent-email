-- Column order: primary key, foreign keys, data grouped by what it describes, then dates
-- (created_at first, deleted_at last). Deletes are soft: they set deleted_at and keep the row.

CREATE TABLE inboxes (
  id         TEXT PRIMARY KEY,
  -- identity
  address    TEXT NOT NULL,
  name       TEXT,              -- optional display name for outgoing mail
  -- auth
  key_hash   TEXT NOT NULL,
  -- dates
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,  -- set on create, and whenever the row changes (e.g. key rotation)
  deleted_at INTEGER
);

CREATE TABLE webhooks (
  id           TEXT PRIMARY KEY,
  inbox_id     TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  -- target
  name         TEXT,              -- optional label, so a list says what each webhook is for
  url          TEXT NOT NULL,
  -- auth
  secret       TEXT NOT NULL,     -- signs this webhook's deliveries; never sent, only its HMAC
  bearer       TEXT,              -- sent verbatim as `Authorization: Bearer ...` when set
  -- dates
  created_at   INTEGER NOT NULL,
  succeeded_at INTEGER,           -- last delivery the receiver accepted
  failed_at    INTEGER,           -- last delivery it didn't; compare the two for health
  deleted_at   INTEGER
);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  inbox_id      TEXT REFERENCES inboxes(id) ON DELETE CASCADE,  -- null when no inbox holds the address
  -- routing
  direction     TEXT NOT NULL,     -- 'in' (received) or 'out' (sent)
  status        TEXT NOT NULL,     -- in: 'received' | 'rejected'
                                   -- out: 'sent' | 'delivered' | 'deferred' | 'bounced' | 'complained' | 'rejected' | 'failed'
  status_reason TEXT,              -- why the status is what it is; null when there's nothing to explain
  message_id    TEXT,              -- the RFC 5322 Message-ID; how a delivery event finds its message
  from_addr     TEXT NOT NULL,
  from_name     TEXT NOT NULL,     -- '' when the sender has no display name
  recipients    TEXT NOT NULL,     -- to, cc and (for sent mail) bcc, comma-separated
  -- content
  subject     TEXT,
  attachments TEXT NOT NULL,       -- [{filename, type, size, disposition}], '[]' when there are none
  -- dates
  created_at  INTEGER NOT NULL,    -- received or sent
  updated_at  INTEGER NOT NULL,    -- set on create, and whenever the row changes (e.g. a delivery event)
  read_at     INTEGER,             -- null until the agent marks it read
  deleted_at  INTEGER
);

-- One inbox per address, deleted or not: a deleted inbox is restored, never recreated.
CREATE UNIQUE INDEX inboxes_address ON inboxes(address);
CREATE UNIQUE INDEX inboxes_key_hash ON inboxes(key_hash);
CREATE INDEX messages_inbox_id ON messages(inbox_id, id);  -- lists and pages by id
CREATE INDEX messages_message_id ON messages(message_id);
CREATE INDEX webhooks_inbox ON webhooks(inbox_id);
