-- === ADR FR Scheduler: Base Schema ===
CREATE TABLE IF NOT EXISTS members (
  member_number TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  cert_level TEXT NOT NULL,
  type3_driver INTEGER NOT NULL DEFAULT 0,
  type2_driver INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT, email TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wallboard (
  service_date TEXT NOT NULL,
  block TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  seat_role TEXT NOT NULL,
  assignee_member_number TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  quality TEXT NOT NULL DEFAULT 'red',
  flashing TEXT NOT NULL DEFAULT 'none',
  notes TEXT,
  PRIMARY KEY (service_date, block, unit_id, seat_role)
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  member_number TEXT NOT NULL,
  service_date TEXT NOT NULL,
  block TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  seat_role TEXT NOT NULL,
  intent TEXT NOT NULL,
  conditions TEXT
);
CREATE TABLE IF NOT EXISTS units_active (
  service_date TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  am_active INTEGER NOT NULL DEFAULT 1,
  pm_active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (service_date, unit_id)
);
CREATE TABLE IF NOT EXISTS call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  source TEXT NOT NULL,
  member_number TEXT,
  full_name TEXT,
  action TEXT NOT NULL,
  unit_id TEXT,
  service_date TEXT,
  block TEXT,
  seat_role TEXT,
  intent TEXT,
  result TEXT,
  reason TEXT,
  verified INTEGER DEFAULT 0,
  payload TEXT
);
