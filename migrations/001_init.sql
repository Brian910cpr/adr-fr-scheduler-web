-- migrations/001_init.sql

-- Units (fixed three ambulance units)
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,        -- '120','121','131'
  name TEXT NOT NULL                -- e.g., 'Ambulance 120'
);

-- Shifts schedule (one row per day/unit/shift)
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_date TEXT NOT NULL,         -- ISO date 'YYYY-MM-DD' UTC
  unit_code TEXT NOT NULL,          -- '120','121','131'
  shift_name TEXT NOT NULL,         -- 'Day' | 'Night'
  intent TEXT NOT NULL DEFAULT '-', -- '-', '✓', '✕'
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_uniq
  ON shifts(shift_date, unit_code, shift_name);

CREATE INDEX IF NOT EXISTS idx_shifts_month
  ON shifts(shift_date);

-- Seed the three units if missing
INSERT OR IGNORE INTO units(code, name) VALUES
 ('120','Ambulance 120'),
 ('121','Ambulance 121'),
 ('131','Ambulance 131');
