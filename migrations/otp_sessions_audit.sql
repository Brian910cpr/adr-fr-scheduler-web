
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_number TEXT NOT NULL,
  channel TEXT CHECK(channel IN ('sms','email')) NOT NULL,
  code_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  member_number TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_member_number TEXT,
  action TEXT NOT NULL,
  meta TEXT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
