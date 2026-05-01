-- EmailCenter initial schema

CREATE TABLE IF NOT EXISTS composed_emails (
    id                 INTEGER  PRIMARY KEY AUTOINCREMENT,
    template_id        TEXT     NOT NULL,
    to_address         TEXT     NOT NULL,
    cc_addresses       TEXT,
    subject            TEXT,
    template_data      TEXT     NOT NULL,
    business_metadata  TEXT,
    is_draft           INTEGER  NOT NULL DEFAULT 0,
    status             TEXT     NOT NULL DEFAULT 'pending',
    created_at         TEXT     NOT NULL DEFAULT (datetime('now')),
    sent_at            TEXT,
    gmail_message_id   TEXT     UNIQUE,
    error_message      TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
    id                 INTEGER  PRIMARY KEY AUTOINCREMENT,
    composed_email_id  INTEGER  NOT NULL REFERENCES composed_emails(id) ON DELETE CASCADE,
    original_name      TEXT     NOT NULL,
    stored_name        TEXT     NOT NULL UNIQUE,
    mime_type          TEXT     NOT NULL,
    size_bytes         INTEGER  NOT NULL,
    uploaded_at        TEXT     NOT NULL DEFAULT (datetime('now')),
    metadata           TEXT
);

CREATE TABLE IF NOT EXISTS gmail_messages (
    id                 INTEGER  PRIMARY KEY AUTOINCREMENT,
    gmail_message_id   TEXT     NOT NULL UNIQUE,
    thread_id          TEXT,
    mailbox            TEXT     NOT NULL,
    from_address       TEXT,
    to_address         TEXT,
    cc_address         TEXT,
    subject            TEXT,
    snippet            TEXT,
    labels             TEXT,
    date               TEXT,
    cached_at          TEXT     NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
    id                 INTEGER  PRIMARY KEY CHECK (id = 1),
    last_synced_at     TEXT,
    history_id         TEXT
);

INSERT OR IGNORE INTO sync_state (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_composed_status   ON composed_emails(status);
CREATE INDEX IF NOT EXISTS idx_composed_is_draft ON composed_emails(is_draft);
CREATE INDEX IF NOT EXISTS idx_composed_sent_at  ON composed_emails(sent_at);
CREATE INDEX IF NOT EXISTS idx_composed_to       ON composed_emails(to_address);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(composed_email_id);
CREATE INDEX IF NOT EXISTS idx_gmail_mailbox     ON gmail_messages(mailbox);
CREATE INDEX IF NOT EXISTS idx_gmail_date        ON gmail_messages(date);
CREATE INDEX IF NOT EXISTS idx_gmail_to          ON gmail_messages(to_address);
CREATE INDEX IF NOT EXISTS idx_gmail_from        ON gmail_messages(from_address);
