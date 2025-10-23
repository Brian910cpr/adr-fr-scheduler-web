# ADR FR — CSV Import (Members + October Wallboard)

Run these **exact** commands from your repo root:

```
wrangler d1 execute adr_fr --remote --file migrations/002_import_members.sql
wrangler d1 execute adr_fr --remote --file migrations/003_import_wallboard_october.sql
```

For local testing:

```
wrangler d1 execute adr_fr --local --file migrations/002_import_members.sql
wrangler d1 execute adr_fr --local --file migrations/003_import_wallboard_october.sql
```

These scripts `INSERT OR REPLACE` into:

- `members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin)`
- `wallboard (service_date, block, unit_id, seat_role, assignee_member_number, status, quality, flashing)`

Notes:
- `assignee_member_number` may be a number or a name; names are mapped to member_number from members.csv. Unknown names become NULL.
- Dates must be `YYYY-MM-DD`.
