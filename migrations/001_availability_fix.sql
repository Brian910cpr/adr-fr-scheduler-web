CREATE TABLE IF NOT EXISTS sc_availability (
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,
  half       TEXT NOT NULL,
  state      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER,
  PRIMARY KEY (user_id, date, half)
);

/* Add columns only if missing (run manually if needed)
   ALTER TABLE sc_availability ADD COLUMN note TEXT NOT NULL DEFAULT '';
   ALTER TABLE sc_availability ADD COLUMN updated_at INTEGER;
*/

UPDATE sc_availability SET state='unset'
WHERE state IS NULL OR state NOT IN ('prefer','available','unset','no');

CREATE TRIGGER IF NOT EXISTS sc_avail_ai AFTER INSERT ON sc_availability
BEGIN
  UPDATE sc_availability SET updated_at=unixepoch()
  WHERE user_id=NEW.user_id AND date=NEW.date AND half=NEW.half;
END;

CREATE TRIGGER IF NOT EXISTS sc_avail_au AFTER UPDATE ON sc_availability
BEGIN
  UPDATE sc_availability SET updated_at=unixepoch()
  WHERE user_id=NEW.user_id AND date=NEW.date AND half=NEW.half;
END;
