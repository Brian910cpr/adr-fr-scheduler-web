CREATE TABLE IF NOT EXISTS units_active (
  service_date TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  am_active INTEGER NOT NULL DEFAULT 1,
  pm_active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (service_date, unit_id)
);