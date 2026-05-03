-- Contacts, contact emails, routing rules

CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  folder_path  TEXT    NOT NULL,
  type         TEXT    NOT NULL DEFAULT 'prospect',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,
  label      TEXT    NOT NULL DEFAULT '',
  UNIQUE(email)
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_contains TEXT    NOT NULL DEFAULT '',
  extensions    TEXT    NOT NULL DEFAULT '',
  subfolder     TEXT    NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contact_emails_email   ON contact_emails(email);
CREATE INDEX IF NOT EXISTS idx_contact_emails_contact ON contact_emails(contact_id);
