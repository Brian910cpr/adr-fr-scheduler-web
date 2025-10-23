-- 1) Seats table
CREATE TABLE IF NOT EXISTS shift_seats (
  shift_date TEXT NOT NULL,         -- YYYY-MM-DD
  unit_code  TEXT NOT NULL,         -- e.g. "120", "121", "131", "ALL"
  shift_name TEXT NOT NULL,         -- "Day" | "Night" | "AM" | "PM"
  seat_role  TEXT NOT NULL,         -- "A" (attendant) | "D" (driver)
  member_id  INTEGER,               -- nullable
  PRIMARY KEY (shift_date, unit_code, shift_name, seat_role)
);

-- 2) Optional legacy table (many installs already have it).
-- Keep it, but ensure it exists for compatibility.
CREATE TABLE IF NOT EXISTS shifts (
  shift_date TEXT NOT NULL,
  unit_code  TEXT NOT NULL,
  shift_name TEXT NOT NULL,
  member_id  INTEGER,
  PRIMARY KEY (shift_date, unit_code, shift_name)
);

-- 3) One-time backfill:
-- If the legacy table has a committed member, treat it as Attendant.
INSERT OR IGNORE INTO shift_seats (shift_date, unit_code, shift_name, seat_role, member_id)
SELECT s.shift_date, s.unit_code, s.shift_name, 'A', s.member_id
FROM shifts s
WHERE s.member_id IS NOT NULL;

-- 4) Helpful indexes
CREATE INDEX IF NOT EXISTS idx_shift_seats_month
ON shift_seats (shift_date, unit_code, shift_name);
