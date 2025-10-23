# ADR FR Scheduler — Full Repo (Requests + Forecast + Month Calendar)

## Deploy
wrangler d1 execute adr_fr --remote --file=db/schema.sql
wrangler d1 execute adr_fr --remote --file=db/seed.sql
wrangler deploy

Open /calendar.html

## Endpoints
- GET /api/me?member=NUMBER|NAME
- GET /api/units-active?from&to
- POST /api/units-active  { service_date, units:[{unit_id,am_active,pm_active}] }
- GET /api/wallboard?from&to          // includes prepublish flag
- GET /api/forecast?from&to           // forecast_quality + 'Need' text (no names)
- POST /api/request                   // pre-publish preferences
- POST /api/claim                     // post-publish direct claim
- POST /api/remove

## Status rules
- Green: Attendant ALS + Driver EMT-B
- Yellow: Attendant ALS + Driver MR | ALS
- Red: Attendant EMT-B + Driver EMT-B | MR
- Slow-Flashing-Red: Driver NMD/None (waiver)
