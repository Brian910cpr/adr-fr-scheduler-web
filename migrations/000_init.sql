
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_number TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  cert_level TEXT CHECK(cert_level IN ('ALS','AEMT','EMT-B','MR','NMD')),
  type3_driver INTEGER DEFAULT 0,
  type2_driver INTEGER DEFAULT 1,
  phone TEXT,
  email TEXT,
  role TEXT DEFAULT 'member',
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS wallboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_date TEXT NOT NULL,
  block TEXT CHECK(block IN ('day','night')) NOT NULL,
  unit_id TEXT CHECK(unit_id IN ('120','121','123')) NOT NULL,
  seat_role TEXT CHECK(seat_role IN ('Attendant','Driver')) NOT NULL,
  assignee_member_number TEXT,
  status TEXT DEFAULT 'open',
  quality TEXT DEFAULT 'red',
  flashing TEXT DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
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
